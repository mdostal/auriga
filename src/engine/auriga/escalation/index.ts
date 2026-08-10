import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import type { DBAdapter } from "../../contracts/db-adapter.ts";
import type { ClassifiedFailure } from "../consumer/index.ts";
import { SqliteDBAdapter } from "../adapters/db/index.ts";

/**
 * The number of classified failures that must land inside `windowMs` before
 * this detector escalates-and-stops.
 *
 * Concrete, pre-decided per this story's acceptance criteria (not left as
 * an open parameter): 5. There is no production failure-rate data yet to
 * derive this from — see the story's own risk note
 * (auriga-escalation-sustained-decline.yaml, `risks[0]`) — so this is a
 * documented guess: low enough to catch a genuinely wedged dependency
 * (a single flaky adapter call retried a couple of times should not get
 * anywhere near 5 in a 60s window) while high enough that a short burst of
 * transient errors (e.g. one upstream blip) doesn't trip the whole
 * orchestrator into a full stop. Revisit after the P1 soak test
 * (p1-soak-test-run.yaml) once real failure-rate data exists.
 */
const DEFAULT_THRESHOLD_COUNT = 5;

/**
 * The sliding time window (ms) that `DEFAULT_THRESHOLD_COUNT` failures must
 * fall within. 60 seconds. Same rationale as `DEFAULT_THRESHOLD_COUNT`
 * above — a documented guess, not derived from production data: long
 * enough that a handful of failures scattered across normal, healthy
 * operation (e.g. one every few minutes) never accumulate into an
 * escalation, short enough that "5 failures in under a minute" reads
 * unambiguously as sustained decline rather than isolated bad luck.
 */
const DEFAULT_WINDOW_MS = 60_000;

/**
 * Exit code used for an escalate-and-stop, distinct from:
 *   - 0 — success
 *   - 1 — Node's default exit code for an uncaught exception / generic
 *     crash. This is exactly the failure mode escalate-and-stop must be
 *     externally distinguishable from (per this story's acceptance
 *     criteria), so it cannot share this code.
 *   - 2 — conventionally "incorrect usage" for many CLI tools.
 *   - 126-165 — reserved by POSIX shells for "command not executable",
 *     "command not found", and 128+signal (e.g. 130 = SIGINT) — codes an
 *     orchestrator-level escalation must not collide with, since anything
 *     supervising this process (a shell, a process manager) may interpret
 *     those specially.
 * 3 sits in the low, unreserved "application-defined" range, so it reads
 * as a deliberate application signal rather than colliding with a runtime
 * or shell convention.
 */
export const ESCALATION_EXIT_CODE = 3;

/**
 * Minimal shape this detector needs from its failure source: something
 * that can register a listener for a `"failure"` event carrying a
 * `ClassifiedFailure`. `AurigaConsumer` (auriga/consumer/index.ts) — an
 * `EventEmitter` — satisfies this structurally; this interface is kept
 * narrower than `EventEmitter` so any failure source with an
 * EventEmitter-shaped `on("failure", ...)` works, not just AurigaConsumer
 * itself.
 */
export interface FailureSource {
  on(event: "failure", listener: (failure: ClassifiedFailure) => void): unknown;
}

/**
 * A written record of an escalate-and-stop event — see
 * SustainedDeclineDetector's class doc, "Escalation record" section, for
 * why this exists and what it must be able to reconstruct.
 *
 * A discriminated union on `reason`, widened by verdict-synthesis-escalation
 * (auriga/watcher/verdict-synthesis.ts) to add a second escalation source —
 * `"verdict_disagreement"`, written when a verification swarm's stage-1
 * verdicts disagree — without introducing a second, parallel escalation
 * record type. Per that story's own design_decisions note: two different
 * escalation record shapes in the same codebase would fragment how a human
 * or Consus reads escalations, so the new variant is added here, as another
 * member of this same exported type, rather than as a standalone interface
 * elsewhere. Both variants share `reason` + `triggeredAt`; everything else
 * is specific to how that kind of escalation was detected.
 */
export type EscalationRecord = SustainedDeclineEscalationRecord | VerdictDisagreementEscalationRecord;

export interface SustainedDeclineEscalationRecord {
  reason: "sustained_decline";
  exitCode: number;
  triggeredAt: string;
  thresholdCount: number;
  windowMs: number;
  failureCount: number;
  /**
   * Summarized (not raw) failures that triggered escalation: the original
   * `error` value is intentionally dropped here (it may not be
   * JSON-serializable — e.g. an Error instance's own properties are
   * non-enumerable — and callers wanting the full detail already have it
   * via the `"failure"` event itself, upstream of this record).
   */
  failures: Array<{
    errorType: string;
    sourceAdapter: string;
    taskId?: string;
    timestamp: string;
  }>;
}

/**
 * Written by verdict-synthesis-escalation (auriga/watcher/verdict-
 * synthesis.ts) when a verification swarm's stage-1 verdicts disagree (at
 * least one verifier's sub-issue landed on `blocked` = reject) — see that
 * module's class doc for the full resolution logic. The parent (review-
 * status) issue is left entirely unwritten by this path — no status change,
 * not even an attempted one — matching this record's own purpose: this IS
 * the escalation (queryable by a human or Consus later), not a notification
 * mechanism, mirroring P1's SustainedDeclineDetector precedent of "record
 * it, let something downstream read it" rather than building new
 * notification infrastructure.
 */
export interface VerdictDisagreementEscalationRecord {
  reason: "verdict_disagreement";
  triggeredAt: string;
  /** The parent (review-status) issue whose stage-1 swarm disagreed. */
  parentIssueId: string;
  /**
   * Every stage-1 verifier sub-issue's id and terminal status (`done` =
   * approve, `blocked` = reject), read via `issue children` — enough detail
   * for a human or Consus to see the exact split without re-fetching
   * Multica.
   */
  verdicts: Array<{ issueId: string; status: string }>;
}

/** Constructor options for SustainedDeclineDetector — see class doc. */
export interface SustainedDeclineDetectorOptions {
  /** Default: DEFAULT_THRESHOLD_COUNT (5). */
  thresholdCount?: number;
  /** Default: DEFAULT_WINDOW_MS (60_000). */
  windowMs?: number;
  /**
   * The escalate-and-stop action. Default: `process.exit`. Injected
   * (not called directly as `process.exit(...)` inline in the detection
   * logic) so tests can pass a spy and assert it was called with the
   * right exit code without actually killing the test process — the same
   * constructor-injection reasoning AurigaConsumer documents for its
   * `lock`/`trackerAdapter` params (see auriga/consumer/index.ts's class
   * doc, "Dependency injection" section): this class is substrate-
   * agnostic about what "stop" means, and tests need a fake instead of a
   * real process kill.
   */
  stop?: (exitCode: number) => void;
  /**
   * Where the escalation record is written. Default: a `SqliteDBAdapter`
   * pointed at `escalations.db` next to this module. Injected for the
   * same reason as `stop` — tests pass their own adapter (e.g. a
   * `SqliteDBAdapter` over a temp file) so they can read the record back
   * without depending on, or polluting, this module's default on-disk
   * path.
   */
  dbAdapter?: DBAdapter;
  /** Default: ESCALATION_EXIT_CODE (3). */
  exitCode?: number;
}

const DEFAULT_DB_PATH = fileURLToPath(new URL("./escalations.db", import.meta.url));

/**
 * SustainedDeclineDetector — subscribes to a `FailureSource`'s `"failure"`
 * events (the `ClassifiedFailure` shape emitted by `AurigaConsumer`'s error
 * boundary, see auriga/consumer/index.ts) and escalates-and-stops once
 * `thresholdCount` failures land within `windowMs` of each other. This is
 * REQ-12 / the north-star mission statement's "escalates-and-STOPS on
 * sustained decline" half, made real for the first time in this epic (see
 * docs/north-star.md).
 *
 * ## What "consecutive" means here (and why it was relaxed)
 *
 * The acceptance criteria talk about "N consecutive dispatch failures".
 * Strictly, "consecutive" would mean N failures with no successful
 * dispatch in between, which requires an explicit "dispatch succeeded"
 * signal to reset the count on success. `AurigaConsumer` does not emit
 * one today — it only ever emits `"failure"` (see its class doc: a
 * successful `onEvent()` call returns silently, no event at all). Adding
 * a `"success"` event to AurigaConsumer to support a strict
 * reset-on-success definition is out of scope for this story (it would
 * change a class built and reviewed in a prior story).
 *
 * So this detector instead implements the honest, buildable interpretation
 * given AurigaConsumer's current public surface: **N failures within a
 * sliding time window**, regardless of what (if anything, since nothing is
 * observable to this detector) happened between them. This is a
 * deliberate relaxation of "consecutive", not an oversight — a burst of 5
 * failures in 60 seconds is a reasonable proxy for sustained decline
 * whether or not a successful dispatch was silently interleaved, and this
 * is exactly the interpretation the acceptance criteria's own second
 * bullet describes ("failures spread across a longer period" as the
 * non-firing case) — a purely time-windowed count, not a strict streak.
 *
 * ## Windowing semantics
 *
 * The window is anchored to each failure's own `timestamp` field (ISO
 * 8601, set by AurigaConsumer at catch time — see ClassifiedFailure's
 * doc), not this detector's local wall-clock receipt time. On each new
 * failure, the internal buffer is pruned to failures whose timestamp is
 * within `windowMs` of the newest failure's timestamp, then escalation
 * fires if the buffer's length has reached `thresholdCount`. Anchoring to
 * the event's own timestamp (rather than `Date.now()` at receipt) keeps
 * this deterministic and fast to test with synthetic, back-dated events,
 * and is the more correct choice anyway: what matters for "sustained
 * decline" is when the failures actually happened, not how promptly this
 * detector was scheduled to observe them.
 *
 * ## Escalate-and-stop action
 *
 * On crossing the threshold, this class (in order):
 *   1. Writes a written `EscalationRecord` (see its own doc) via the
 *      injected `dbAdapter`, so the stop is "clearly distinguishable from
 *      a crash or an unattended hang" per this story's acceptance
 *      criteria — a crash leaves no such record, an unattended hang
 *      leaves the process still running.
 *   2. Calls the injected `stop(exitCode)` — default `process.exit`, with
 *      `ESCALATION_EXIT_CODE` (see its own doc for why that specific
 *      code).
 *   3. Emits its own `"escalated"` event carrying the written record, so
 *      callers (including tests) can deterministically await completion
 *      of both steps above without polling or an arbitrary timeout.
 *
 * Both `stop` and `dbAdapter` are constructor-injected, not internally
 * constructed — see `SustainedDeclineDetectorOptions`'s doc for why (same
 * reasoning as AurigaConsumer's `lock`/`trackerAdapter` injection).
 *
 * ## Once escalated, stays escalated
 *
 * After the threshold is crossed once, this detector ignores further
 * `"failure"` events (an internal flag short-circuits `#onFailure`). In
 * production, the injected `stop` (real `process.exit`) makes this moot —
 * nothing runs after it. In tests, where `stop` is a non-terminating spy,
 * this prevents a second overlapping escalation (and a second db write /
 * second `stop` call) from events that arrive after the first threshold
 * crossing but before whatever supervises this process actually acts on
 * the stop.
 */
export class SustainedDeclineDetector extends EventEmitter {
  readonly #thresholdCount: number;
  readonly #windowMs: number;
  readonly #stop: (exitCode: number) => void;
  readonly #dbAdapter: DBAdapter;
  readonly #exitCode: number;

  #buffer: ClassifiedFailure[] = [];
  #escalated = false;
  #lastEscalationKey: string | undefined;

  constructor(source: FailureSource, options: SustainedDeclineDetectorOptions = {}) {
    super();
    this.#thresholdCount = options.thresholdCount ?? DEFAULT_THRESHOLD_COUNT;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#stop = options.stop ?? process.exit.bind(process);
    this.#dbAdapter = options.dbAdapter ?? new SqliteDBAdapter(DEFAULT_DB_PATH);
    this.#exitCode = options.exitCode ?? ESCALATION_EXIT_CODE;

    source.on("failure", this.#onFailure);
  }

  /** The db key the most recently written EscalationRecord was stored
   * under (via the injected `dbAdapter`), or `undefined` if this detector
   * has not escalated yet. Exposed so callers/tests can read the record
   * back without having to predict the timestamp-based key themselves. */
  get lastEscalationKey(): string | undefined {
    return this.#lastEscalationKey;
  }

  /** True once this detector has escalated (see class doc, "Once
   * escalated, stays escalated"). */
  get escalated(): boolean {
    return this.#escalated;
  }

  #onFailure = (failure: ClassifiedFailure): void => {
    if (this.#escalated) {
      // See class doc, "Once escalated, stays escalated".
      return;
    }

    this.#buffer.push(failure);

    const newestMs = Date.parse(failure.timestamp);
    this.#buffer = this.#buffer.filter((f) => newestMs - Date.parse(f.timestamp) <= this.#windowMs);

    if (this.#buffer.length >= this.#thresholdCount) {
      // Set synchronously, before the async write below, so a burst of
      // failures arriving before the write resolves can't slip past the
      // guard above and start a second, overlapping escalation.
      this.#escalated = true;
      void this.#escalate();
    }
  };

  async #escalate(): Promise<void> {
    const triggeredAt = new Date().toISOString();
    const key = `escalation:${triggeredAt}`;
    const record: EscalationRecord = {
      reason: "sustained_decline",
      exitCode: this.#exitCode,
      triggeredAt,
      thresholdCount: this.#thresholdCount,
      windowMs: this.#windowMs,
      failureCount: this.#buffer.length,
      failures: this.#buffer.map((f) => ({
        errorType: f.errorType,
        sourceAdapter: f.sourceAdapter,
        taskId: f.taskId,
        timestamp: f.timestamp,
      })),
    };

    try {
      await this.#dbAdapter.write(key, record);
      this.#lastEscalationKey = key;
    } catch {
      // Even if the write itself fails, the process must still stop —
      // swallowing this keeps the write's own failure from becoming a new
      // unhandled rejection, which would undermine the exact "never crash
      // silently" guarantee this class exists to provide. `stop()` below
      // still fires; `lastEscalationKey`/the emitted `"escalated"` record
      // are the only casualties, and this is the one path where the
      // written record isn't guaranteed (documented, not silent: a caller
      // inspecting `lastEscalationKey` after a failed write sees
      // `undefined` and can tell the difference).
    }

    this.#stop(this.#exitCode);
    this.emit("escalated", record);
  }
}
