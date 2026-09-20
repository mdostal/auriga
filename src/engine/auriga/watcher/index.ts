import { EventEmitter } from "node:events";

/**
 * auriga/watcher/index.ts — BoardStateWatcher: a standalone poll loop that
 * detects two board-state transitions Multica has no webhooks for and emits
 * a typed event for each, exactly once per transition:
 *
 *   - "dispatch-eligible": an issue reaches Multica's real "todo" status
 *     (the existing pending->in_progress consumer flow's trigger state).
 *   - "review-eligible": an issue reaches Multica's real "in_review" status
 *     (the contract's newly-widened "review" TaskStatus, once
 *     adapter-in-review-mapping lands the faithful mapping -- this watcher
 *     reads Multica's own "in_review" string directly rather than going
 *     through that adapter, for the same reason MulticaLock's sweep() reads
 *     Multica's real status strings directly: TrackerAdapter has no list
 *     method, only per-id claimTask/updateStatus/getTask, so there is
 *     nothing on that contract to poll a full board through).
 *
 * Mirrors two existing patterns rather than inventing a new one:
 *   - auriga/lock/index.ts's sweep(): polls a live Multica issue list over
 *     HTTP directly, the direct precedent for this watcher's #listIssues().
 *   - auriga/observability/instrumented-lock.ts's InstrumentedLock: an
 *     EventEmitter that observes something and re-emits typed events for
 *     interesting transitions, without doing any of the underlying work
 *     itself.
 *
 * Per this story's scope: detects and emits ONLY. Never calls
 * updateStatus/claim or any other write -- that's auto-dispatch-wiring's
 * and verification-swarm-dispatch's job (both depend on this component but
 * are not wired to it here), matching the mvp-boundary invariant "never let
 * the orchestrator do work itself" inside the watcher.
 *
 * ## Project scoping (added after review, PAN-3951)
 *
 * `projectId` is a required constructor field, not optional. The first
 * pass of this component queried Multica with no project filter at all --
 * `${serverUrl}/api/issues?workspace_id=...` -- which would have watched
 * (and, once wired into dispatch, reacted to) the ENTIRE workspace: every
 * other project sharing this Multica workspace, including this very
 * epic's own tracking issues as they move through todo/in_review during
 * normal orchestration. Fixed two ways, defense in depth:
 *   1. The request itself is scoped server-side via a `project_id` query
 *      param (confirmed empirically against the live API: filtering by
 *      `project_id` returns exactly that project's issues, verified by
 *      comparing counts against an unfiltered call).
 *   2. `#poll()` additionally skips any returned issue whose own
 *      `project_id` doesn't match this instance's configured `#projectId`,
 *      so a server-side filtering bug (or a mocked/future API that ignores
 *      the query param) can't silently reintroduce the original gap.
 *
 * ## Exactly-once per transition
 *
 * Every observed issue's last-known Multica status string is tracked in
 * `#lastKnownStatus` (issueId -> status). On each poll tick, a status is
 * compared against what this instance last saw for that issue (`undefined`
 * the first time an issue is observed at all); an event fires only when the
 * newly-observed status differs from that AND is one of the two eligible
 * statuses. An issue sitting at "todo" across many consecutive polls fires
 * once, on the tick it's first observed there, and stays quiet until it
 * moves to a different status (and, if it ever comes back, fires again --
 * a fresh transition, not a repeat of the same one).
 *
 * ## Poll loop shape -- self-scheduling setTimeout, not setInterval
 *
 * A poll is a real network round-trip whose duration isn't bounded by
 * `pollIntervalMs`. `setInterval` risks overlapping ticks if one poll takes
 * longer than the interval, which would race two `#poll()` calls over
 * `#lastKnownStatus` and could double-emit. Instead, each tick schedules
 * the next `setTimeout` only after the current poll's promise has settled,
 * so ticks are always serialized.
 *
 * ## stop() and an in-flight poll
 *
 * `stop()` clears any pending timer immediately (no new tick starts), and
 * additionally awaits whatever poll is currently in flight so a caller
 * knows the watcher is fully quiescent once `stop()` resolves -- but that
 * in-flight poll's result is discarded: `#poll()` checks `#stopped` after
 * its network call resolves and, if stop() was called while it was
 * in-flight, returns without emitting anything or updating
 * `#lastKnownStatus`. This matches this story's acceptance criteria: a poll
 * already underway when stop() is called completes, but emits nothing.
 */

export interface BoardStateWatcherConfig {
  serverUrl: string;
  workspaceId: string;
  /** Required, not optional -- an unscoped watcher would poll and react to
   * the ENTIRE Multica workspace (all projects), not just this one. Found
   * missing entirely in this component's first review pass (board-state-
   * machine, PAN-3951) -- see the class doc's "Project scoping" section. */
  projectId: string;
  token: string;
  /** Poll interval in ms. Constructor override, mirroring MulticaLock's
   * `staleMs` convention (auriga/lock/index.ts) -- default 30s, tunable per
   * instance/test without subclassing. */
  pollIntervalMs?: number;
}

export interface BoardStateTransitionEvent {
  issueId: string;
  /** This instance's last-known status for the issue before this
   * transition, or undefined if this is the first time the issue has ever
   * been observed. */
  previousStatus: string | undefined;
}

interface MulticaIssue {
  id: string;
  status: string;
  project_id?: string;
  [key: string]: unknown;
}

const DEFAULT_POLL_INTERVAL_MS = 30_000;
/** Multica's real status strings -- deliberately not the contract's
 * TaskStatus values, see this file's doc comment. */
const DISPATCH_ELIGIBLE_STATUS = "todo";
const REVIEW_ELIGIBLE_STATUS = "in_review";

export class BoardStateWatcher extends EventEmitter {
  readonly #serverUrl: string;
  readonly #workspaceId: string;
  readonly #projectId: string;
  readonly #token: string;
  readonly #pollIntervalMs: number;
  readonly #lastKnownStatus = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #stopped = true;
  #inFlightPoll: Promise<void> | undefined;

  constructor(config: BoardStateWatcherConfig) {
    super();
    this.#serverUrl = config.serverUrl.replace(/\/+$/, "");
    this.#workspaceId = config.workspaceId;
    this.#projectId = config.projectId;
    this.#token = config.token;
    this.#pollIntervalMs = config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }

  /** Begins polling. Idempotent -- calling start() again while already running is a no-op. */
  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#scheduleNextPoll();
  }

  /**
   * Stops the watcher: no new poll ticks are scheduled, and the returned
   * promise resolves once any in-flight poll has actually settled -- see
   * class doc, "stop() and an in-flight poll". Safe to call when not
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
          // A poll is self-driving (nothing external calls it per-tick to
          // catch a rejection), so it needs its own boundary or a network
          // failure would surface as an unhandled rejection and silently
          // end the loop. Emitted, never thrown -- "poll-error", not
          // "error", so EventEmitter doesn't throw synchronously when no
          // listener is attached (mirrors AurigaConsumer's "failure" not
          // "error" choice, auriga/consumer/index.ts).
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
    if (this.#stopped) return; // stop() was called while this fetch was in flight -- see class doc.

    for (const issue of issues) {
      // Defense in depth against the original PAN-3951 gap -- see class doc,
      // "Project scoping". Fails closed: an issue with no project_id at all
      // (which real Multica issues always carry) is treated as NOT this
      // project rather than assumed to belong here, since the whole point
      // is never reacting to anything outside this instance's own project.
      if (issue.project_id !== this.#projectId) continue;

      const previousStatus = this.#lastKnownStatus.get(issue.id);
      if (previousStatus === issue.status) continue;
      this.#lastKnownStatus.set(issue.id, issue.status);

      const event: BoardStateTransitionEvent = { issueId: issue.id, previousStatus };
      if (issue.status === DISPATCH_ELIGIBLE_STATUS) {
        this.emit("dispatch-eligible", event);
      } else if (issue.status === REVIEW_ELIGIBLE_STATUS) {
        this.emit("review-eligible", event);
      }
    }
  }

  async #listIssues(): Promise<MulticaIssue[]> {
    // project_id confirmed empirically against the live API (comparing
    // filtered vs. unfiltered issue counts) -- see class doc, "Project
    // scoping". Still followed by a client-side check in #poll() (defense
    // in depth), so this remains correct even if a mocked or future API
    // response ignores the param.
    const url = `${this.#serverUrl}/api/issues?workspace_id=${this.#workspaceId}&project_id=${this.#projectId}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.#token}` },
    });
    if (!res.ok) {
      throw new Error(`BoardStateWatcher: GET ${url} -> ${res.status}`);
    }
    const body = (await res.json()) as { issues: MulticaIssue[] };
    return body.issues;
  }
}
