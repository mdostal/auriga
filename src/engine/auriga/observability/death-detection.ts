import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

/**
 * auriga/observability/death-detection.ts — the orchestrator death/restart
 * detection mechanism for REQ-13's counter, per Open Question 5
 * (.pHive/epics/contracts-and-spine/docs/design-discussion.md, "Open
 * Question 5" in §6): "How is 'orchestrator death/restart' actually
 * detected... a process supervisor signal, a PID file, a gap in heartbeat
 * events, a lease-expiry pattern read after the fact?"
 *
 * ## Mechanism chosen: a heartbeat file, checked at the NEXT process start
 *
 * Of the candidates the design discussion lists, this module implements
 * "a heartbeat file with a staleness check read by... the next process
 * start" — explicitly one of the story's own listed candidates
 * (death-restart-detection-mechanism.yaml, step `implement`).
 *
 * This choice was made specifically because **process-supervision-decision
 * (the next story in this epic) has not happened yet** — see that story's
 * own file, .pHive/epics/contracts-and-spine/stories/process-supervision-decision.yaml,
 * `depends_on: [death-restart-detection-mechanism]`, i.e. it comes AFTER
 * this one, precisely so this mechanism doesn't have to assume a specific
 * supervisor already exists. A mechanism that depended on, say, systemd
 * unit failure notifications or a supervisor polling a PID file would be
 * unbuildable/untestable today, and would bake in a supervisor choice this
 * epic has explicitly not made (see this story's own risk note,
 * death-restart-detection-mechanism.yaml `risks[0]`).
 *
 * A heartbeat file checked at next-start is self-contained: nothing external
 * needs to be watching the process while it runs. The tradeoff is honestly
 * documented, not hidden: this mechanism can only ever tell you "the
 * previous run died" the NEXT time some process (an orchestrator restart, or
 * a test, or eventually a supervisor) reads the file — it cannot alert in
 * real time while the death is happening, because nothing is polling
 * staleness live. That real-time capability — a supervisor or watchdog
 * polling the heartbeat file's mtime/timestamp WHILE the orchestrator is
 * (or should be) running, and alerting the moment it goes stale — becomes
 * possible as a FUTURE ENHANCEMENT once process-supervision-decision picks
 * a real supervisor. It is explicitly NOT required now; this module's
 * `detectPreviousDeath` is designed to be called at the start of whatever
 * process runs next, not by a live poller.
 *
 * ## Heartbeat file format
 *
 * A single JSON object, rewritten in place on every heartbeat tick and
 * again (with the shutdown fields added) on clean shutdown:
 *
 * ```json
 * {
 *   "pid": 12345,
 *   "runId": "3d3f5e2a-...",
 *   "updatedAt": "2026-07-24T18:00:00.000Z",
 *   "cleanShutdownAt": "2026-07-24T18:05:00.000Z"
 * }
 * ```
 *
 *   - `pid` — `process.pid` of the writing process. Kept alongside `runId`
 *     (not instead of it) because a PID is cheap, human-legible context
 *     when eyeballing the file during debugging, but PIDs are recycled by
 *     the OS and are useless for telling two runs apart across a restart.
 *   - `runId` — a `randomUUID()` generated once per `HeartbeatWriter`
 *     instance (i.e. once per process lifetime), NOT derived from the PID.
 *     This is the value that actually identifies "which run wrote this
 *     heartbeat" reliably: unlike a PID, it can never collide with a
 *     future run's identifier just because the OS happened to reuse a
 *     process id. `detectPreviousDeath` doesn't strictly need to compare
 *     `runId` across runs today (this module only ever looks at the single
 *     most recent heartbeat file, see below), but it's captured now because
 *     it's exactly the attribution field a future multi-instance or
 *     supervisor-driven consumer of this file would need, and it costs
 *     nothing to record.
 *   - `updatedAt` — ISO 8601 timestamp of this write. This is the
 *     "timestamp of the last known heartbeat" the story's 3rd acceptance
 *     criterion asks for: when a death is detected, `updatedAt` from the
 *     file IS the death event's timestamp (approximately when the process
 *     stopped writing).
 *   - `cleanShutdownAt` — ONLY present when the writing process shut down
 *     in an orderly way (see `markCleanShutdown()` below). Its absence is
 *     exactly what distinguishes a genuine death from a clean stop.
 *
 * ## Distinguishing clean-shutdown from death
 *
 * `HeartbeatWriter` writes `updatedAt` on every tick while the process is
 * alive and behaving normally. If the process is SIGKILLed, OOM-killed, or
 * otherwise dies without warning, the LAST thing ever written to the
 * heartbeat file is a normal tick with no `cleanShutdownAt` — there is no
 * opportunity for anything to run after that. If instead the process stops
 * on purpose (e.g. `SustainedDeclineDetector`'s escalate-and-stop path, see
 * auriga/escalation/index.ts), something calls `markCleanShutdown()` BEFORE
 * the process actually exits, which stops the ticking and performs one
 * final write that sets `cleanShutdownAt` (equal to that same write's
 * `updatedAt`, i.e. "the marker and the last heartbeat agree").
 *
 * So `detectPreviousDeath`, reading the file left behind by whatever ran
 * before it, only has to ask one question: does the file have a
 * `cleanShutdownAt`? Present -> clean exit, not a death. Absent (but the
 * file exists, i.e. the process really was alive and heartbeating at some
 * point) -> the process stopped heartbeating without ever getting a chance
 * to mark itself as cleanly stopped, which is exactly what an unexpected
 * death (SIGKILL/OOM/etc.) looks like from the outside. No heartbeat file
 * at all -> there is no prior process to have died (first-ever run) —
 * distinct from both other cases, and never reported as a death.
 *
 * ## Wiring into SustainedDeclineDetector — future integration step
 *
 * No real process entrypoint exists yet anywhere in this epic to wire
 * `markCleanShutdown()` into for real (every other story in this slice has
 * been in the same position — see e.g. auriga/escalation/index.ts's own
 * `stop` injection, which is called by tests, not a real process exit
 * today). The intended real wiring, once an entrypoint exists: call
 * `heartbeatWriter.markCleanShutdown()` as the FIRST step of
 * `SustainedDeclineDetector`'s `#escalate()` (auriga/escalation/index.ts),
 * before its `dbAdapter.write()` and `stop()` calls — so a heartbeat file
 * belonging to an escalated run always carries the marker before the
 * process actually exits. That wiring is out of scope for this story (it
 * would mean threading a `HeartbeatWriter` instance into
 * `SustainedDeclineDetectorOptions`); this module exposes
 * `markCleanShutdown()` as a standalone public method specifically so that
 * future wiring — and this story's own tests, in the meantime — can call
 * it directly.
 */

/**
 * Default heartbeat file path: alongside this module, mirroring
 * `SustainedDeclineDetector`'s `DEFAULT_DB_PATH` pattern
 * (auriga/escalation/index.ts) and `ObservabilityCounterStore`'s default
 * placement — a predictable on-disk location for the real (eventual)
 * process, while every test in death-detection.test.ts overrides this with
 * its own scratch path so tests never share or pollute this file.
 */
export const DEFAULT_HEARTBEAT_PATH = fileURLToPath(new URL("./heartbeat.json", import.meta.url));

/**
 * Default heartbeat interval: 30 seconds. A documented guess (like
 * `DEFAULT_THRESHOLD_COUNT`/`DEFAULT_WINDOW_MS` in auriga/escalation/index.ts
 * and `DEFAULT_DROPPED_WINDOW_MS` in auriga/observability/counters.ts — no
 * production data exists yet to derive this from). Chosen to be short
 * enough that "how long ago did the last heartbeat land" stays a tight,
 * useful approximation of "when did the process actually die" for the 3rd
 * acceptance criterion's timestamp attribution, while being long enough
 * that writing it isn't meaningful I/O load. Revisit after the P1 soak test
 * (p1-soak-test-run.yaml) once real data exists, same as the other
 * documented-guess constants in this epic.
 */
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** On-disk shape of the heartbeat file — see this module's doc comment,
 * "Heartbeat file format". */
export interface HeartbeatFileContents {
  pid: number;
  runId: string;
  updatedAt: string;
  /** Present only when the writing process shut down cleanly. */
  cleanShutdownAt?: string;
}

/** Constructor options for `HeartbeatWriter` — see class doc. */
export interface HeartbeatWriterOptions {
  /** Default: DEFAULT_HEARTBEAT_PATH. */
  heartbeatPath?: string;
  /**
   * Default: DEFAULT_HEARTBEAT_INTERVAL_MS. Injectable specifically so
   * tests can use a short interval (e.g. 10ms) instead of waiting out a
   * real 30-second sleep — see death-detection.test.ts's periodic-write
   * test.
   */
  intervalMs?: number;
  /**
   * Default: a fresh `randomUUID()`. Injectable so tests can assert on a
   * known value; production callers should never need to pass this.
   */
  runId?: string;
}

/**
 * HeartbeatWriter — while the orchestrator process is alive, periodically
 * (re)writes a heartbeat file proving it. See this module's doc comment for
 * the full design rationale and file format.
 *
 * ## Lifecycle
 *
 * `start()` writes an initial heartbeat immediately, then schedules
 * `setInterval` to keep writing every `intervalMs`. `stop()` clears that
 * timer — this class owns its own lifecycle so tests are never stuck with
 * a real timer running forever (Node's test runner would otherwise hang
 * waiting for the event loop to drain). `markCleanShutdown()` also clears
 * the timer (if still running) and performs one last write carrying
 * `cleanShutdownAt`, then the instance is done — calling `start()` again
 * after `markCleanShutdown()` is not supported (a new run should construct
 * a new `HeartbeatWriter` with its own `runId`, not resurrect a
 * shut-down one).
 *
 * The interval timer is `unref()`d so a real process that constructs a
 * `HeartbeatWriter` and forgets to call `stop()`/`markCleanShutdown()` on
 * exit doesn't hang purely because of this timer — Node will still exit
 * once nothing else keeps the event loop alive. This does NOT affect
 * `stop()`'s job of preventing further writes in tests; `unref()` only
 * changes whether the timer alone keeps the process running, not whether
 * it fires.
 */
export class HeartbeatWriter {
  readonly #heartbeatPath: string;
  readonly #intervalMs: number;
  readonly #runId: string;
  #timer: NodeJS.Timeout | undefined;
  #shutdownMarked = false;

  constructor(options: HeartbeatWriterOptions = {}) {
    this.#heartbeatPath = options.heartbeatPath ?? DEFAULT_HEARTBEAT_PATH;
    this.#intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.#runId = options.runId ?? randomUUID();
  }

  /** The path this writer reads/writes. */
  get heartbeatPath(): string {
    return this.#heartbeatPath;
  }

  /** This process run's identifier — see class doc, `runId` field. */
  get runId(): string {
    return this.#runId;
  }

  /** True once `markCleanShutdown()` has been called on this instance. */
  get shutdownMarked(): boolean {
    return this.#shutdownMarked;
  }

  /** Writes an initial heartbeat and begins periodic ticks. Safe to call
   * once per instance; calling twice just restarts the interval timer. */
  start(): void {
    this.#writeTick();
    if (this.#timer) {
      clearInterval(this.#timer);
    }
    this.#timer = setInterval(() => this.#writeTick(), this.#intervalMs);
    this.#timer.unref?.();
  }

  /** Stops periodic writes without marking a clean shutdown — used when a
   * caller (e.g. a test) wants to assert "no further writes happen" without
   * asserting anything about death-vs-clean-stop semantics. Idempotent. */
  stop(): void {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  /**
   * Records that this process is stopping in an orderly way — see this
   * module's doc comment, "Distinguishing clean-shutdown from death" and
   * "Wiring into SustainedDeclineDetector". Stops the periodic timer (if
   * running) and performs one final write with `cleanShutdownAt` set equal
   * to that write's own `updatedAt`. Idempotent — calling more than once
   * just rewrites the same marker with a fresh timestamp.
   */
  markCleanShutdown(): void {
    this.stop();
    const now = new Date().toISOString();
    const contents: HeartbeatFileContents = {
      pid: process.pid,
      runId: this.#runId,
      updatedAt: now,
      cleanShutdownAt: now,
    };
    writeFileSync(this.#heartbeatPath, JSON.stringify(contents));
    this.#shutdownMarked = true;
  }

  #writeTick(): void {
    const contents: HeartbeatFileContents = {
      pid: process.pid,
      runId: this.#runId,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(this.#heartbeatPath, JSON.stringify(contents));
  }
}

/** Cause string recorded when a heartbeat file is found with no clean-
 * shutdown marker — see this module's doc comment. */
export const DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN = "heartbeat_missing_clean_shutdown_marker" as const;

/** A detected death event — sufficient attribution to feed observability's
 * counters per this story's 3rd acceptance criterion. */
export interface DeathEvent {
  /** Approximately when the death occurred: the last heartbeat's own
   * `updatedAt`, not `detectedAt` below (which is only "when we noticed"). */
  heartbeatTimestamp: string;
  cause: typeof DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN;
  /** When `detectPreviousDeath` actually observed this (may be much later
   * than `heartbeatTimestamp` — e.g. hours later, whenever the next
   * process happens to start). */
  detectedAt: string;
  pid?: number;
  runId?: string;
}

export type DetectPreviousDeathResult =
  | { death: false; reason: "no_prior_heartbeat" }
  | { death: false; reason: "clean_shutdown"; cleanShutdownAt: string }
  | { death: false; reason: "unreadable_heartbeat_file" }
  | { death: true; event: DeathEvent };

/**
 * Reads the heartbeat file left behind by whatever process ran before this
 * one — call this at the START of a new run, BEFORE the new run's own
 * `HeartbeatWriter.start()` overwrites the file. See this module's doc
 * comment for the full decision logic; summarized:
 *
 *   - no file at all             -> `{ death: false, reason: "no_prior_heartbeat" }`
 *     (first-ever run — nothing could have died).
 *   - file with `cleanShutdownAt` -> `{ death: false, reason: "clean_shutdown", ... }`.
 *   - file with no `cleanShutdownAt` -> a genuine death: `{ death: true, event }`,
 *     `event.heartbeatTimestamp` set to the file's own `updatedAt`.
 *   - file present but not valid JSON/shape -> treated as inconclusive, NOT
 *     a false-positive death (`reason: "unreadable_heartbeat_file"`) — a
 *     corrupt file is not evidence of a SIGKILL, and this mechanism should
 *     fail closed (no report) rather than fabricate attribution it can't
 *     back up. Out of scope to harden further here (e.g. partial-write
 *     torn reads) — `HeartbeatWriter` always writes the whole JSON object
 *     in a single `writeFileSync` call, which keeps torn reads unlikely in
 *     practice on the local filesystems this epic targets, but is not a
 *     hard guarantee.
 *
 * This function does not delete or rewrite the file it reads — callers
 * (e.g. a real entrypoint, or this module's own tests) are responsible for
 * starting a fresh `HeartbeatWriter` afterward, which naturally overwrites
 * the file with a new run's own heartbeats going forward.
 */
export function detectPreviousDeath(heartbeatPath: string = DEFAULT_HEARTBEAT_PATH): DetectPreviousDeathResult {
  if (!existsSync(heartbeatPath)) {
    return { death: false, reason: "no_prior_heartbeat" };
  }

  let parsed: Partial<HeartbeatFileContents>;
  try {
    parsed = JSON.parse(readFileSync(heartbeatPath, "utf8")) as Partial<HeartbeatFileContents>;
  } catch {
    return { death: false, reason: "unreadable_heartbeat_file" };
  }

  if (typeof parsed.updatedAt !== "string") {
    return { death: false, reason: "unreadable_heartbeat_file" };
  }

  if (typeof parsed.cleanShutdownAt === "string") {
    return { death: false, reason: "clean_shutdown", cleanShutdownAt: parsed.cleanShutdownAt };
  }

  return {
    death: true,
    event: {
      heartbeatTimestamp: parsed.updatedAt,
      cause: DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN,
      detectedAt: new Date().toISOString(),
      pid: parsed.pid,
      runId: parsed.runId,
    },
  };
}

const DEFAULT_DEATH_EVENTS_DB_PATH = fileURLToPath(new URL("./death-events.db", import.meta.url));

/**
 * DeathEventStore — persists `DeathEvent`s in better-sqlite3, following
 * `ObservabilityCounterStore`'s established style (auriga/observability/counters.ts):
 * WAL mode, a purpose-built table (not a generic KV blob).
 *
 * ## Sibling store, not an extension of ObservabilityCounterStore
 *
 * `ObservabilityCounterStore` was considered as a home for this table too
 * (one store, one file, for all of observability's persisted findings).
 * Chose a separate `DeathEventStore` instead, for the same reason
 * `auriga/escalation/index.ts` writes its `EscalationRecord`s via an
 * injected `DBAdapter` rather than reusing `ObservabilityCounterStore`:
 * death events come from an entirely different derivation source (reading
 * a heartbeat file at process start) than dropped/duplicated counters
 * (deriving from a lock-event stream) — they have no natural shared
 * lifecycle or shared query pattern, and coupling them to the same class
 * would mean every consumer of one now depends on the schema of the other.
 * A small sibling store, following the exact same WAL/purpose-built-table
 * pattern, keeps the precedent consistent without forcing a shared
 * abstraction that doesn't actually fit.
 */
export class DeathEventStore {
  #db: Database.Database;

  constructor(dbPath: string = DEFAULT_DEATH_EVENTS_DB_PATH) {
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS death_events (
        heartbeat_timestamp TEXT NOT NULL,
        cause               TEXT NOT NULL,
        detected_at         TEXT NOT NULL,
        pid                 INTEGER,
        run_id              TEXT,
        recorded_at         INTEGER NOT NULL,
        PRIMARY KEY (heartbeat_timestamp, cause)
      );
    `);
  }

  /**
   * Persists a detected `DeathEvent`. `INSERT OR IGNORE` against the
   * `(heartbeat_timestamp, cause)` primary key gives the same idempotency
   * `ObservabilityCounterStore` documents: re-running `detectPreviousDeath`
   * against the same untouched heartbeat file (e.g. a retry, or re-running
   * this module's own tests against a fixture) never double-counts the
   * same death.
   */
  recordDeath(event: DeathEvent): void {
    this.#db
      .prepare(
        `INSERT OR IGNORE INTO death_events
           (heartbeat_timestamp, cause, detected_at, pid, run_id, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.heartbeatTimestamp, event.cause, event.detectedAt, event.pid ?? null, event.runId ?? null, Date.now());
  }

  /** All persisted death events, oldest heartbeat first. */
  getDeathEvents(): DeathEvent[] {
    const rows = this.#db
      .prepare<
        [],
        { heartbeat_timestamp: string; cause: string; detected_at: string; pid: number | null; run_id: string | null }
      >("SELECT heartbeat_timestamp, cause, detected_at, pid, run_id FROM death_events ORDER BY heartbeat_timestamp ASC")
      .all();
    return rows.map((r) => ({
      heartbeatTimestamp: r.heartbeat_timestamp,
      cause: r.cause as DeathEvent["cause"],
      detectedAt: r.detected_at,
      pid: r.pid ?? undefined,
      runId: r.run_id ?? undefined,
    }));
  }

  /** Closes the underlying sqlite connection. */
  close(): void {
    this.#db.close();
  }
}
