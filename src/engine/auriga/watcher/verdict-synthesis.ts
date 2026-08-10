import { EventEmitter } from "node:events";
import type { TrackerAdapter } from "../../contracts/tracker-adapter.ts";
import type { DBAdapter } from "../../contracts/db-adapter.ts";
import type { VerdictDisagreementEscalationRecord } from "../escalation/index.ts";

/**
 * auriga/watcher/verdict-synthesis.ts — VerdictSynthesizer: reads back the
 * verdicts `VerificationSwarmDispatcher` (auriga/watcher/verification-
 * swarm.ts) leaves behind and resolves them, per this epic's
 * verdict-synthesis-escalation story.
 *
 * ## Why this needs its own poll loop (not "the woken dispatch")
 *
 * `VerificationSwarmDispatcher`'s class doc documents a real Multica
 * mechanism: completing the last sub-issue in a stage causes Multica's own
 * server to post a system comment on the parent and dispatch a fresh agent
 * run against WHATEVER'S ASSIGNED TO THE PARENT inside Multica's own agent
 * runtime — a separate system from this Node process, with no webhook or
 * callback into this codebase. This class therefore cannot be triggered by
 * that mechanism; it needs its own in-process poll over live Multica, the
 * same way `BoardStateWatcher` (auriga/watcher/index.ts) already does —
 * consistent with this whole epic's architecture (auriga/run.ts polls live
 * Multica in-process; nothing relies on Multica calling back into it).
 *
 * ## What a poll does
 *
 * Each tick: list this project's `in_review`-status issues (Multica's own
 * status string — see BoardStateWatcher's class doc for why this reads
 * Multica's raw status directly rather than through TrackerAdapter, which
 * has no list method, only per-id claimTask/updateStatus/getTask). For each
 * one not already synthesized (see "Exactly-once" below), fetch its
 * children (`GET /api/issues/{parent}/children`, the same endpoint
 * `VerificationSwarmDispatcher`'s idempotency check and `multica issue
 * children` both use):
 *
 *   - No children at all -> the swarm hasn't been dispatched yet (or hasn't
 *     been observed as dispatched). Do nothing. An empty children array
 *     must NEVER be treated as a vacuous "every child approved" — `[].every
 *     (...)` is `true` in JS, which would silently auto-approve a parent
 *     nothing has actually reviewed yet. Checked and rejected explicitly,
 *     before the terminal/approve checks below ever run.
 *   - At least one child not yet terminal (`done`/`blocked`) -> not all
 *     verdicts are in. Do nothing this tick — no premature read, no
 *     partial-verdict guess. Retried on a later tick once the rest land.
 *   - Every child terminal, all `done` -> unanimous approve. Mark the
 *     parent `done` via the injected `TrackerAdapter.updateStatus` (no new
 *     adapter method — reusing the existing write path per this story's
 *     design_decisions).
 *   - Every child terminal, at least one `blocked` -> disagreement. Write a
 *     `VerdictDisagreementEscalationRecord` (auriga/escalation/index.ts —
 *     the SAME `EscalationRecord` union `SustainedDeclineDetector` already
 *     writes, widened with a second variant rather than a parallel type)
 *     via the injected `DBAdapter`. The parent issue is NEVER written on
 *     this path — no `updateStatus` call exists in this branch at all, so
 *     "the parent stays in review, unchanged" holds structurally, the same
 *     way `VerificationSwarmDispatcher`'s class doc notes its own
 *     "parent status is never written" guarantee holds by omission rather
 *     than by a guard that could be bypassed.
 *
 * ## Escalate, never auto-resolve (mvp-boundary invariant)
 *
 * This is the concrete satisfaction of `docs/initial-info/04-mvp-
 * boundary.md`'s "never a reviewer / second-opinion model as a hard gate":
 * disagreement among verifiers never silently resolves to `done` (that
 * would auto-approve past a real rejection), and it never blocks the parent
 * any harder than "stays in review, pending human/Consus-level judgment"
 * (no `blocked` write, no other side effect). There are exactly two
 * terminal outcomes this class ever produces, and no third:
 * `updateStatus(parentId, "done")` on unanimous approve, or an
 * `EscalationRecord` write on any disagreement — never both, never neither
 * once children are all terminal, and never a status write in the
 * disagreement branch.
 *
 * ## Project scoping
 *
 * Mirrors `BoardStateWatcher` exactly (auriga/watcher/index.ts, "Project
 * scoping" section) — `projectId` is a required constructor field, and
 * every poll is scoped two ways, defense in depth: a server-side
 * `project_id` query param on the list request, AND a client-side
 * fail-closed filter (`issue.project_id !== this.#projectId` is skipped,
 * including issues with no `project_id` at all) so a server-side filtering
 * bug — or a mocked/future API that ignores the query param — can't
 * reintroduce the exact cross-project bug `board-state-watcher-component`
 * was sent back for (PAN-3951).
 *
 * ## Exactly-once (idempotency)
 *
 * Mirrors `BoardStateWatcher`'s `#lastKnownStatus` pattern (an in-memory
 * Map/Set keyed by issue id, checked before ever acting), adapted to this
 * class's shape: `#synthesized` is a `Set<string>` of parent issue ids this
 * instance has already resolved (either branch). A synthesized parent is
 * skipped on every later tick before any children fetch, status write, or
 * db write is attempted again. This matters most for the disagreement
 * branch: an escalated parent's status is deliberately left at `review`
 * (see above), so an unmodified Multica keeps returning it in every future
 * poll's review-status list forever — without this tracking, every
 * subsequent tick would write a duplicate `EscalationRecord` for the same
 * already-escalated disagreement. (The unanimous-approve branch is
 * naturally self-limiting too, once written — a real Multica issue's status
 * changes away from `in_review` after `updateStatus(..., "done")` and stops
 * appearing in the review-status list at all — but `#synthesized` still
 * guards that branch the same way, so this holds even against a stale or
 * slow-to-update list response, not just by relying on the status having
 * already visibly changed.) This is in-memory, per-instance state, the same
 * as `BoardStateWatcher`'s own tracking — a restarted process re-observes a
 * previously-synthesized parent from scratch, but by then its children are
 * unchanged (still terminal, same verdicts) so a re-run of the resolution
 * logic reproduces the same outcome it already reached; the design does not
 * try to prevent that specific case (a fresh instance, not a live one
 * double-firing), matching `VerificationSwarmDispatcher`'s own children-
 * check idempotency being the cross-restart safety net rather than its
 * in-process `#inFlight` guard.
 *
 * ## Poll loop shape — self-scheduling setTimeout, not setInterval
 *
 * Same reasoning as `BoardStateWatcher`: a poll (plus however many
 * per-parent children fetches and writes it triggers) is a real,
 * unbounded-duration round trip. `setInterval` risks overlapping ticks
 * racing `#synthesized` and double-processing a parent; each tick instead
 * schedules its own next `setTimeout` only after the current poll's promise
 * has settled, so ticks are always serialized and `#synthesized` never
 * needs its own lock.
 *
 * ## stop() and an in-flight poll
 *
 * Same contract as `BoardStateWatcher`: `stop()` clears any pending timer
 * immediately and awaits whatever poll is currently in flight, but that
 * in-flight poll's remaining work is abandoned once `#stopped` is observed
 * true again (checked after the list fetch, and again between each parent
 * processed) — no further status/db writes happen once stop() has been
 * called, though a single parent's write already in flight when stop() was
 * called is allowed to finish (not aborted mid-network-call).
 */

export interface VerdictSynthesizerConfig {
  serverUrl: string;
  workspaceId: string;
  /** Required, not optional — see class doc's "Project scoping" section.
   * An unscoped poll would react to review-status issues across the ENTIRE
   * Multica workspace, not just this project. */
  projectId: string;
  token: string;
  /** Reused, not reinvented — the parent's status write on unanimous
   * approve goes through this existing contract's `updateStatus`, per this
   * story's design_decisions ("no new adapter method"). */
  trackerAdapter: TrackerAdapter;
  /** Reused, not reinvented — disagreement escalation records are written
   * through this existing contract, the same one `SustainedDeclineDetector`
   * (auriga/escalation/index.ts) already uses. */
  dbAdapter: DBAdapter;
  /** Poll interval in ms. Default 30s, mirroring BoardStateWatcherConfig's
   * convention. */
  pollIntervalMs?: number;
}

export interface VerdictApprovedEvent {
  issueId: string;
  subIssueIds: string[];
}

export interface VerdictEscalatedEvent {
  issueId: string;
  subIssueIds: string[];
  /** The DBAdapter key the written EscalationRecord was stored under. */
  escalationKey: string;
}

interface MulticaIssue {
  id: string;
  status: string;
  project_id?: string;
  [key: string]: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Multica's real status string for the contract's `review` TaskStatus —
 * see BoardStateWatcher's class doc for why this reads Multica's raw string
 * directly rather than through TrackerAdapter. */
const REVIEW_STATUS = "in_review";
/** Verdict convention from VerificationSwarmDispatcher's class doc: a
 * verifier sub-issue's own status records its verdict directly — `done` =
 * approve, `blocked` = reject. Not a comment, not a label. */
const APPROVE_STATUS = "done";
const REJECT_STATUS = "blocked";
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([APPROVE_STATUS, REJECT_STATUS]);

export class VerdictSynthesizer extends EventEmitter {
  readonly #serverUrl: string;
  readonly #workspaceId: string;
  readonly #projectId: string;
  readonly #token: string;
  readonly #trackerAdapter: TrackerAdapter;
  readonly #dbAdapter: DBAdapter;
  readonly #pollIntervalMs: number;
  /** Parent issue ids already resolved by this instance — see class doc,
   * "Exactly-once (idempotency)". */
  readonly #synthesized = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #inFlightPoll: Promise<void> | undefined;

  constructor(config: VerdictSynthesizerConfig) {
    super();
    this.#serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.#workspaceId = config.workspaceId;
    this.#projectId = config.projectId;
    this.#token = config.token;
    this.#trackerAdapter = config.trackerAdapter;
    this.#dbAdapter = config.dbAdapter;
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Begins polling. Idempotent — calling start() again while already running is a no-op. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleNextPoll();
  }

  /**
   * Stops the synthesizer: no new poll ticks are scheduled, and the
   * returned promise resolves once any in-flight poll has actually settled
   * — see class doc, "stop() and an in-flight poll". Safe to call when not
   * running. Idempotent.
   */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    if (this.#inFlightPoll) {
      await this.#inFlightPoll;
    }
  }

  #scheduleNextPoll(): void {
    this.#timer = setTimeout(() => {
      this.#inFlightPoll = this.#poll()
        .catch((error: unknown) => {
          // Mirrors BoardStateWatcher's "poll-error", not "error" -- a poll
          // is self-driving, so it needs its own boundary or a network/
          // adapter failure would surface as an unhandled rejection and
          // silently end the loop. "poll-error" (not "error") so
          // EventEmitter doesn't throw synchronously when no listener is
          // attached.
          this.emit("poll-error", error);
        })
        .finally(() => {
          this.#inFlightPoll = undefined;
          if (!this.#stopped) this.#scheduleNextPoll();
        });
    }, this.#pollIntervalMs);
  }

  async #poll(): Promise<void> {
    const issues = await this.#listIssues();
    if (this.#stopped) return; // stop() was called while this fetch was in flight.

    for (const issue of issues) {
      // Project scoping, defense in depth -- see class doc. Fails closed:
      // an issue with no project_id at all is treated as NOT this project.
      if (issue.project_id !== this.#projectId) continue;
      if (issue.status !== REVIEW_STATUS) continue;
      if (this.#synthesized.has(issue.id)) continue;

      await this.#trySynthesize(issue.id);
      if (this.#stopped) return;
    }
  }

  async #trySynthesize(parentId: string): Promise<void> {
    const children = await this.#getChildren(parentId);

    // No children at all -> swarm not dispatched (or not yet observed) for
    // this parent. Must be checked BEFORE the terminal/approve checks
    // below: `[].every(...)` is vacuously `true` in JS, which would
    // otherwise silently auto-approve a parent nothing has reviewed yet.
    if (children.length === 0) return;

    const allTerminal = children.every((c) => TERMINAL_STATUSES.has(c.status));
    if (!allTerminal) return; // not every verdict is in yet -- don't guess.

    // Defensive re-check (see class doc, "Exactly-once") -- this instance's
    // own serialized poll loop makes this unreachable in practice, but
    // mirrors the defense-in-depth style this codebase already uses for
    // project scoping.
    if (this.#synthesized.has(parentId)) return;

    const subIssueIds = children.map((c) => c.id);
    const allApprove = children.every((c) => c.status === APPROVE_STATUS);

    if (allApprove) {
      await this.#trackerAdapter.updateStatus(parentId, "done");
      this.#synthesized.add(parentId);
      this.emit("verdict-approved", { issueId: parentId, subIssueIds } satisfies VerdictApprovedEvent);
      return;
    }

    // At least one reject -- escalate. Never auto-approve past a
    // disagreement, never block harder than "stays in review": no
    // TrackerAdapter call exists on this path at all. See class doc,
    // "Escalate, never auto-resolve".
    const record: VerdictDisagreementEscalationRecord = {
      reason: "verdict_disagreement",
      triggeredAt: new Date().toISOString(),
      parentIssueId: parentId,
      verdicts: children.map((c) => ({ issueId: c.id, status: c.status })),
    };
    const key = `escalation:verdict_disagreement:${parentId}:${record.triggeredAt}`;
    await this.#dbAdapter.write(key, record);
    this.#synthesized.add(parentId);
    this.emit("verdict-escalated", {
      issueId: parentId,
      subIssueIds,
      escalationKey: key,
    } satisfies VerdictEscalatedEvent);
  }

  async #listIssues(): Promise<MulticaIssue[]> {
    const url = `${this.#serverUrl}/api/issues?workspace_id=${this.#workspaceId}&project_id=${this.#projectId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    if (!res.ok) {
      throw new Error(`VerdictSynthesizer: GET ${url} -> ${res.status}`);
    }
    const body = (await res.json()) as { issues: MulticaIssue[] };
    return body.issues;
  }

  async #getChildren(parentId: string): Promise<MulticaIssue[]> {
    const url = `${this.#serverUrl}/api/issues/${parentId}/children?workspace_id=${this.#workspaceId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    if (!res.ok) {
      throw new Error(`VerdictSynthesizer: GET ${url} -> ${res.status}`);
    }
    const body = (await res.json()) as { issues: MulticaIssue[] };
    return body.issues;
  }
}
