import Database from "better-sqlite3";

/**
 * auriga/observability/counters.ts — dropped-task and duplicated-task
 * counter derivation, per AD-6 (.pHive/planning/architecture.md):
 *
 *   "Counters (dropped, duplicated, deaths/restarts) plus per-event
 *    attribution are computed from the event stream + lock state and
 *    cached locally in better-sqlite3 purely for reporting."
 *
 * IMPORTANT — this is a derived, LOCAL REPORTING CACHE, not a competing
 * source of truth. Multica stays the system of record for task/issue
 * state. Nothing in this module writes back to Multica, mutates lock
 * state, or is consulted by `auriga/lock/` or `auriga/consumer/` to make
 * claim/release decisions — it only observes a stream of lock-related
 * events after the fact and persists a report.
 *
 * ## Why this module consumes an EVENT STREAM, not "MulticaLock's history"
 *
 * The story that spawned this file describes deriving counters from
 * "auriga/lock/'s claim/lease state". Read literally that's not buildable:
 * `MulticaLock` (auriga/lock/index.ts) keeps no durable, queryable log of
 * claim/release activity — its only internal state is a `#leases` Map used
 * for live lease bookkeeping (see that class's doc comment), and entries
 * are deleted from that Map the moment a lease is released or reclaimed by
 * sweep(). There is nothing there to "query" after the fact, and there
 * shouldn't be — MulticaLock is built for correctness against live
 * Multica, not to double as an event store.
 *
 * So this module instead defines a minimal `LockEvent` shape (below) and
 * derives both counters as a pure function over an explicit array/stream
 * of those events. Something upstream — out of scope for this story, not
 * yet wired anywhere in this epic — would be responsible for actually
 * emitting this stream from real claim()/release() calls (e.g. an
 * event-emitting wrapper around a LockContract, or instrumentation inside
 * a future LockContract implementation). This file is purely the
 * derivation + persistence layer, consuming whatever stream it's given;
 * the tests below feed it synthetic sequences per the story's own
 * test-spec step.
 *
 * ## Event shape
 *
 * Three event kinds are sufficient to derive both counters:
 *
 *   - `claimed`         — a successful `claim()` (LockContract's
 *                          `{ok: true, leaseId}` branch). Carries the
 *                          `leaseId` Multica/MulticaLock synthesizes.
 *   - `released`        — a `release(leaseId)` call for a previously
 *                          claimed lease (normal completion) OR an
 *                          equivalent completion signal such as
 *                          `sweep()` reclaiming a stale lease (which also
 *                          ends the lease's "held" interval, just via a
 *                          different code path than an explicit
 *                          release()). Either should be reported as
 *                          `released` here — this module only cares that
 *                          the lease's held-interval has a known end, not
 *                          which LockContract method ended it.
 *   - `claim_rejected`  — a `claim()` call that lost
 *                          (`{ok: false, reason: "already_claimed"}`).
 *                          Not used by either counter today, but included
 *                          in the event shape because it's part of the
 *                          complete claim-attempt picture a future
 *                          counter (e.g. contention rate) would need, and
 *                          costs nothing to define now alongside the
 *                          other two.
 */
export type LockEvent =
  | { type: "claimed"; taskId: string; leaseId: string; timestamp: number }
  | { type: "released"; taskId: string; leaseId: string; timestamp: number }
  | { type: "claim_rejected"; taskId: string; timestamp: number };

/**
 * A single observed board-state transition -- `"dispatch-eligible"` or
 * `"review-eligible"` -- as emitted by `BoardStateWatcher`
 * (`auriga/watcher/index.ts`, `BoardStateTransitionEvent`). Added by
 * observability-transition-verdict-counters, mirroring `LockEvent`'s own
 * "one type carries the vocabulary the real component already emits"
 * shape: `type`/`issueId`/`previousStatus` are exactly
 * `BoardStateTransitionEvent`'s own fields plus the discriminant
 * BoardStateWatcher already emits it under (its real Node `EventEmitter`
 * event name), plus a `timestamp` (the instant `InstrumentedWatcher`
 * observed it -- see `instrumented-watcher.ts`), matching `LockEvent`'s own
 * "timestamp = the instant the call resolved" convention.
 */
export type TransitionEvent = {
  type: "dispatch-eligible" | "review-eligible";
  issueId: string;
  previousStatus: string | undefined;
  timestamp: number;
};

/**
 * A single observed verdict-synthesis outcome -- `"verdict-approved"` or
 * `"verdict-escalated"` -- as emitted by `VerdictSynthesizer`
 * (`auriga/watcher/verdict-synthesis.ts`, `VerdictApprovedEvent`/
 * `VerdictEscalatedEvent`). Kept as a discriminated union (not one flat
 * shape) because only the escalated variant carries an `escalationKey`,
 * mirroring `LockEvent`'s own per-variant field shape.
 */
export type VerdictEvent =
  | { type: "verdict-approved"; issueId: string; subIssueIds: string[]; timestamp: number }
  | {
      type: "verdict-escalated";
      issueId: string;
      subIssueIds: string[];
      escalationKey: string;
      timestamp: number;
    };

/**
 * Default "how long is too long to hold a claim before we call it
 * dropped" window: 5 minutes.
 *
 * Chosen to match `DEFAULT_STALE_MS` in auriga/lock/index.ts (also 5
 * minutes) rather than invent an unrelated number: both constants answer
 * the same underlying question ("how long can a claimed task go without
 * being finished before something is wrong?") for the same P1 spine, just
 * from two different vantage points — MulticaLock's sweep() uses it to
 * decide when to reclaim a lease it still holds, this module uses it to
 * decide when to *report* that a claim was effectively abandoned. Keeping
 * them aligned means a task that sweep() would reclaim as stale is, not
 * coincidentally, exactly the kind of task this counter calls "dropped" —
 * one policy number, two consumers. Like MulticaLock's constant, this is
 * a documented guess (no production failure-rate data exists yet — see
 * auriga-observability-counters.yaml risks[0]); revisit after the P1 soak
 * test (p1-soak-test-run.yaml) once real data exists.
 */
export const DEFAULT_DROPPED_WINDOW_MS = 5 * 60 * 1000;

/** A dropped-task finding: a claim that never saw a matching release. */
export interface DroppedTaskRecord {
  taskId: string;
  leaseId: string;
  /** The claim event's timestamp (ms epoch) — when the lease was taken. */
  claimedAt: number;
  /**
   * Attribution cause. Only one cause is derivable from lock-state alone
   * today; kept as a string union (not a bare boolean) so a future
   * derivation source (e.g. a death/restart signal) can add causes
   * without changing this record's shape.
   */
  cause: "claimed_never_released_within_window";
}

/**
 * A duplicated-task finding: two or more claim events for the same taskId
 * whose held-intervals overlapped in time. `claims` carries every claim
 * event implicated in the overlap (at minimum 2), each with its own
 * leaseId and timestamp, so attribution can point at exactly which leases
 * collided.
 *
 * `cause` was added by observability-attribution-tests
 * (.pHive/epics/contracts-and-spine/stories/observability-attribution-tests.yaml)
 * after finding a genuine attribution gap while building that story's
 * full-stack test: `DroppedTaskRecord` already carried a `cause` string
 * (REQ-13 AC: "attributable by task id, timestamp, and cause"), but this
 * record had no equivalent field — only `taskId` and `claims`. A caller
 * reading a persisted duplicated-task row had no machine-readable answer to
 * "why was this flagged", only what could be inferred by re-deriving the
 * overlap logic. Fixed by adding a single string-union `cause` per record
 * (one cause per taskId group, same as one `cause` per dropped record),
 * kept as a union (not a bare string) for the same forward-compatibility
 * reason `DroppedTaskRecord.cause` is a union: today only one cause is
 * derivable, but the shape doesn't need to change when a second one is.
 */
export interface DuplicatedTaskRecord {
  taskId: string;
  claims: Array<{ leaseId: string; timestamp: number }>;
  cause: "concurrent_claims_overlapping_intervals";
}

export interface DerivedCounters {
  dropped: DroppedTaskRecord[];
  duplicated: DuplicatedTaskRecord[];
}

export interface DeriveCountersOptions {
  /** See DEFAULT_DROPPED_WINDOW_MS. */
  windowMs?: number;
  /**
   * The instant "now" is evaluated as, for the purpose of deciding
   * whether a still-open claim's window has elapsed. Defaults to
   * `Date.now()`. Exposed so tests can express "the window elapsed"
   * without sleeping wall-clock time — pass a fixed `now` that is
   * `windowMs` (or more) past the synthetic claim's timestamp.
   */
  now?: number;
}

/**
 * Derives dropped-task and duplicated-task counters from a stream of
 * `LockEvent`s. Pure function — no I/O, no mutation of its input. Persist
 * the result with `ObservabilityCounterStore` (below) if you need it to
 * survive process exit.
 *
 * ## "Dropped" — precise definition
 *
 * A task is dropped iff:
 *   1. it has a `claimed` event (some `leaseId`), AND
 *   2. there is no `released` event carrying that SAME `leaseId`
 *      anywhere in the stream, AND
 *   3. `now - claimedAt >= windowMs`.
 *
 * Matching is by `leaseId`, not just `taskId` — a taskId can be
 * legitimately re-claimed after a prior lease was released (retry,
 * sweep-then-reclaim, etc.), and only the specific lease that never got a
 * matching release is the one that's "dropped". A claim younger than
 * `windowMs` is never reported as dropped yet, even if unreleased — it's
 * simply still in flight (this mirrors sweep()'s own staleness check in
 * auriga/lock/index.ts, which also waits for `staleMs` before treating a
 * held lease as abandoned).
 *
 * ## "Duplicated" — precise definition
 *
 * A set of `claimed` events for the SAME `taskId` counts as duplicated
 * iff at least two of them have OVERLAPPING held-intervals — i.e. an
 * earlier claim's lease had not yet seen its `released` event (in this
 * stream) by the time a later claim for the same taskId occurred.
 *
 * This is deliberately an overlap check, not "any two claims ever share a
 * taskId": a taskId claimed, released, and later re-claimed (a normal,
 * expected lifecycle — e.g. sweep() reclaims a stale lease and a
 * different lease later claims the same task) must NOT be flagged as
 * duplicated. What this counter exists to catch is the scenario
 * documented as an accepted P1 gap in auriga/lock/index.ts's class doc
 * ("cross-process race... NOT PROTECTED... 20/20 double-claims"): two
 * DISTINCT leases simultaneously believing they hold the same task,
 * which `lock-concurrent-claim-tests` guarantees cannot happen within one
 * MulticaLock instance but is explicitly NOT guaranteed across two
 * instances/processes sharing one Multica identity. This counter is part
 * of how that gap would actually get caught in practice during the P1
 * soak test, once a future story wires a real event stream from
 * multi-process usage into this derivation.
 *
 * An open claim with no `released` event yet (including one that will
 * later be found "dropped") is treated as open-ended for overlap purposes
 * — it overlaps any later claim for the same taskId, since we have no
 * evidence it ended before that later claim began.
 */
export function deriveCounters(
  events: readonly LockEvent[],
  options: DeriveCountersOptions = {},
): DerivedCounters {
  const windowMs = options.windowMs ?? DEFAULT_DROPPED_WINDOW_MS;
  const now = options.now ?? Date.now();

  const claimsByTask = new Map<string, Array<{ leaseId: string; timestamp: number }>>();
  const releasedAtByLease = new Map<string, number>();

  for (const event of events) {
    if (event.type === "claimed") {
      const list = claimsByTask.get(event.taskId) ?? [];
      list.push({ leaseId: event.leaseId, timestamp: event.timestamp });
      claimsByTask.set(event.taskId, list);
    } else if (event.type === "released") {
      releasedAtByLease.set(event.leaseId, event.timestamp);
    }
    // "claim_rejected" carries no lease and never gets counted here — see
    // class-level doc comment.
  }

  // --- dropped ---
  const dropped: DroppedTaskRecord[] = [];
  for (const [taskId, claims] of claimsByTask) {
    for (const claim of claims) {
      const releasedAt = releasedAtByLease.get(claim.leaseId);
      const stillOpen = releasedAt === undefined;
      const windowElapsed = now - claim.timestamp >= windowMs;
      if (stillOpen && windowElapsed) {
        dropped.push({
          taskId,
          leaseId: claim.leaseId,
          claimedAt: claim.timestamp,
          cause: "claimed_never_released_within_window",
        });
      }
    }
  }

  // --- duplicated ---
  const duplicated: DuplicatedTaskRecord[] = [];
  for (const [taskId, claims] of claimsByTask) {
    if (claims.length < 2) continue;

    const ordered = [...claims].sort((a, b) => a.timestamp - b.timestamp);
    const overlapping = new Set<number>(); // indices into `ordered`

    for (let i = 0; i < ordered.length; i++) {
      const earlier = ordered[i];
      if (!earlier) continue;
      const earlierEnd = releasedAtByLease.get(earlier.leaseId) ?? Infinity; // open-ended if never released
      for (let j = i + 1; j < ordered.length; j++) {
        const later = ordered[j];
        if (!later) continue;
        // Overlap iff the earlier claim was still open when the later one
        // began (earlier hadn't been released yet at `later.timestamp`).
        if (later.timestamp < earlierEnd) {
          overlapping.add(i);
          overlapping.add(j);
        }
      }
    }

    if (overlapping.size >= 2) {
      duplicated.push({
        taskId,
        cause: "concurrent_claims_overlapping_intervals",
        claims: [...overlapping]
          .sort((a, b) => a - b)
          .map((idx) => ordered[idx])
          .filter((c): c is { leaseId: string; timestamp: number } => c !== undefined),
      });
    }
  }

  return { dropped, duplicated };
}

/**
 * A persisted verdict-synthesis finding, as read back from
 * `ObservabilityCounterStore.getVerdicts()`. Deliberately a DIFFERENT shape
 * than the live `VerdictEvent` stream, mirroring the existing
 * `LockEvent` (verb-based stream: `claimed`/`released`) vs.
 * `DroppedTaskRecord`/`DuplicatedTaskRecord` (noun-based persisted finding)
 * split already established in this file: `outcome` uses the domain
 * vocabulary this story's acceptance criteria asks for ("done"/"escalated"
 * -- the same two words `VerdictSynthesizer` itself uses, see
 * `auriga/watcher/verdict-synthesis.ts`'s `APPROVE_STATUS`/its
 * `updateStatus(parentId, "done")` call), not the raw event-name
 * discriminant (`"verdict-approved"`/`"verdict-escalated"`) the live stream
 * carries. `escalationKey` is optional -- present only for `"escalated"`
 * rows, mirroring `VerdictEscalatedEvent`'s own field only existing on that
 * variant.
 */
export interface VerdictRecord {
  issueId: string;
  outcome: "done" | "escalated";
  subIssueIds: string[];
  escalationKey?: string;
  timestamp: number;
}

/** Counts derived by `deriveTransitionVerdictCounts()` (below). */
export interface TransitionVerdictCounts {
  /** Every observed transition, both kinds (`dispatch-eligible` + `review-eligible`). */
  transitionsFired: number;
  /**
   * Approximated as the `review-eligible` transition count -- see this
   * story's own yaml ("swarms dispatched (approximated as review-eligible
   * count, since this story doesn't need to correlate 1:1 with
   * verification-swarm-dispatch's own internal state)"). A `review-eligible`
   * transition is what actually triggers `VerificationSwarmDispatcher`
   * (auriga/watcher/verification-swarm.ts), so this is the closest signal
   * this module can compute without importing that component's own
   * idempotency state.
   */
  swarmsDispatched: number;
  /** Verdict-synthesis outcomes where every verifier approved. */
  unanimousApproveCount: number;
  /** Verdict-synthesis outcomes where at least one verifier disagreed. */
  escalationCount: number;
}

/**
 * Derives transition/verdict counters from a stream of `TransitionEvent`s
 * and `VerdictEvent`s. Pure function — no I/O, no mutation of its input —
 * matching `deriveCounters()`'s own contract exactly (see that function's
 * doc comment and this story's third acceptance criterion). Persist the
 * result's underlying events with `ObservabilityCounterStore.recordTransitions()`/
 * `recordVerdicts()` (below) if you need them to survive process exit; this
 * function itself never touches sqlite or any other I/O.
 */
export function deriveTransitionVerdictCounts(
  events: readonly (TransitionEvent | VerdictEvent)[],
): TransitionVerdictCounts {
  let transitionsFired = 0;
  let swarmsDispatched = 0;
  let unanimousApproveCount = 0;
  let escalationCount = 0;

  for (const event of events) {
    switch (event.type) {
      case "dispatch-eligible":
        transitionsFired++;
        break;
      case "review-eligible":
        transitionsFired++;
        swarmsDispatched++;
        break;
      case "verdict-approved":
        unanimousApproveCount++;
        break;
      case "verdict-escalated":
        escalationCount++;
        break;
    }
  }

  return { transitionsFired, swarmsDispatched, unanimousApproveCount, escalationCount };
}

/**
 * ObservabilityCounterStore — persists `deriveCounters()`'s output in
 * better-sqlite3 (AD-6), following the WAL-mode pattern established by
 * `SqliteDBAdapter` (auriga/adapters/db/index.ts).
 *
 * ## Purpose-built tables, not the generic KV shape
 *
 * `SqliteDBAdapter` offers a generic `key -> JSON` KV table, and reusing
 * it here (e.g. one JSON blob per counter) was considered. Chose
 * purpose-built tables (`dropped_tasks`, `duplicated_tasks`) instead: the
 * acceptance criteria explicitly wants counts/attribution to be
 * "readable" for reporting, which in practice means queryable by taskId
 * or cause (`SELECT * FROM dropped_tasks WHERE task_id = ?`) without
 * deserializing and re-scanning a JSON blob first. A dedicated schema
 * also gives natural idempotency: a `PRIMARY KEY (task_id, lease_id)`
 * plus `INSERT OR IGNORE` means re-deriving and re-persisting the same
 * event stream (e.g. a soak-test harness that periodically re-runs
 * deriveCounters over a growing log) never double-counts a
 * previously-recorded finding.
 *
 * Each row in `duplicated_tasks` is ONE implicated claim (task_id,
 * lease_id, timestamp); a duplicate "group" is simply every row sharing a
 * `task_id` — `getDuplicatedTasks()` groups them back into
 * `DuplicatedTaskRecord[]` for callers.
 */
export class ObservabilityCounterStore {
  #db: Database.Database;

  constructor(dbPath: string) {
    this.#db = new Database(dbPath);
    this.#db.pragma("journal_mode = WAL");
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS dropped_tasks (
        task_id     TEXT NOT NULL,
        lease_id    TEXT NOT NULL,
        claimed_at  INTEGER NOT NULL,
        cause       TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, lease_id)
      );

      CREATE TABLE IF NOT EXISTS duplicated_tasks (
        task_id     TEXT NOT NULL,
        lease_id    TEXT NOT NULL,
        claimed_at  INTEGER NOT NULL,
        cause       TEXT NOT NULL,
        recorded_at INTEGER NOT NULL,
        PRIMARY KEY (task_id, lease_id)
      );

      -- Added by observability-transition-verdict-counters: EXTENDS this
      -- same store/db file with two new purpose-built tables, alongside
      -- dropped_tasks/duplicated_tasks above -- not a second store (see
      -- this story's own design_decisions). PRIMARY KEY (issue_id,
      -- transition_type, occurred_at) gives the same INSERT-OR-IGNORE
      -- idempotency dropped_tasks/duplicated_tasks already rely on: an
      -- issue can legitimately fire the SAME transition kind more than
      -- once over its lifetime (BoardStateWatcher's "exactly-once PER
      -- transition, not per issue" -- see its own class doc), so occurred_at
      -- must be part of the key, not just issue_id+transition_type.
      CREATE TABLE IF NOT EXISTS transitions (
        issue_id        TEXT NOT NULL,
        transition_type TEXT NOT NULL,
        previous_status TEXT,
        occurred_at     INTEGER NOT NULL,
        recorded_at     INTEGER NOT NULL,
        PRIMARY KEY (issue_id, transition_type, occurred_at)
      );

      -- VerdictSynthesizer resolves a given parent issue id AT MOST ONCE
      -- per instance (its own "#synthesized" exactly-once guard -- see its
      -- class doc), so issue_id+occurred_at is already effectively unique
      -- in practice; kept as the primary key anyway for the same
      -- re-derive-safely idempotency guarantee the other three tables give.
      CREATE TABLE IF NOT EXISTS verdicts (
        issue_id       TEXT NOT NULL,
        outcome        TEXT NOT NULL,
        sub_issue_ids  TEXT NOT NULL,
        escalation_key TEXT,
        occurred_at    INTEGER NOT NULL,
        recorded_at    INTEGER NOT NULL,
        PRIMARY KEY (issue_id, occurred_at)
      );
    `);
  }

  /** Persists a full `DerivedCounters` result (both counters at once). */
  record(derived: DerivedCounters): void {
    this.recordDropped(derived.dropped);
    this.recordDuplicated(derived.duplicated);
  }

  recordDropped(records: readonly DroppedTaskRecord[]): void {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO dropped_tasks (task_id, lease_id, claimed_at, cause, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const recordedAt = Date.now();
    const insertAll = this.#db.transaction((rows: readonly DroppedTaskRecord[]) => {
      for (const row of rows) {
        stmt.run(row.taskId, row.leaseId, row.claimedAt, row.cause, recordedAt);
      }
    });
    insertAll(records);
  }

  recordDuplicated(records: readonly DuplicatedTaskRecord[]): void {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO duplicated_tasks (task_id, lease_id, claimed_at, cause, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const recordedAt = Date.now();
    const insertAll = this.#db.transaction((rows: readonly DuplicatedTaskRecord[]) => {
      for (const row of rows) {
        for (const claim of row.claims) {
          stmt.run(row.taskId, claim.leaseId, claim.timestamp, row.cause, recordedAt);
        }
      }
    });
    insertAll(records);
  }

  /** All persisted dropped-task findings, oldest claim first. */
  getDroppedTasks(): DroppedTaskRecord[] {
    const rows = this.#db
      .prepare<
        [],
        { task_id: string; lease_id: string; claimed_at: number; cause: string }
      >("SELECT task_id, lease_id, claimed_at, cause FROM dropped_tasks ORDER BY claimed_at ASC")
      .all();
    return rows.map((r) => ({
      taskId: r.task_id,
      leaseId: r.lease_id,
      claimedAt: r.claimed_at,
      cause: r.cause as DroppedTaskRecord["cause"],
    }));
  }

  /** All persisted duplicated-task findings, grouped back by task id. */
  getDuplicatedTasks(): DuplicatedTaskRecord[] {
    const rows = this.#db
      .prepare<
        [],
        { task_id: string; lease_id: string; claimed_at: number; cause: string }
      >("SELECT task_id, lease_id, claimed_at, cause FROM duplicated_tasks ORDER BY task_id ASC, claimed_at ASC")
      .all();

    const byTask = new Map<string, DuplicatedTaskRecord>();
    for (const r of rows) {
      const existing = byTask.get(r.task_id);
      const claim = { leaseId: r.lease_id, timestamp: r.claimed_at };
      if (existing) {
        existing.claims.push(claim);
      } else {
        byTask.set(r.task_id, {
          taskId: r.task_id,
          cause: r.cause as DuplicatedTaskRecord["cause"],
          claims: [claim],
        });
      }
    }
    return [...byTask.values()];
  }

  /**
   * Persists a stream of observed `TransitionEvent`s (see this module's own
   * doc comment). Unlike `record()`/`recordDropped()`/`recordDuplicated()`,
   * no derivation step happens first -- every observed transition IS a
   * record; there is no threshold/overlap computation like dropped/
   * duplicated require. `INSERT OR IGNORE` on `(issue_id, transition_type,
   * occurred_at)` gives the same re-persist-safely idempotency as the other
   * two tables.
   */
  recordTransitions(events: readonly TransitionEvent[]): void {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO transitions (issue_id, transition_type, previous_status, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const recordedAt = Date.now();
    const insertAll = this.#db.transaction((rows: readonly TransitionEvent[]) => {
      for (const row of rows) {
        stmt.run(row.issueId, row.type, row.previousStatus ?? null, row.timestamp, recordedAt);
      }
    });
    insertAll(events);
  }

  /** All persisted transitions, oldest first. */
  getTransitions(): TransitionEvent[] {
    const rows = this.#db
      .prepare<
        [],
        { issue_id: string; transition_type: string; previous_status: string | null; occurred_at: number }
      >(
        "SELECT issue_id, transition_type, previous_status, occurred_at FROM transitions ORDER BY occurred_at ASC",
      )
      .all();
    return rows.map((r) => ({
      type: r.transition_type as TransitionEvent["type"],
      issueId: r.issue_id,
      previousStatus: r.previous_status ?? undefined,
      timestamp: r.occurred_at,
    }));
  }

  /**
   * Persists a stream of observed `VerdictEvent`s, translating each into
   * the `outcome`-based vocabulary `VerdictRecord`/this table use (see
   * `VerdictRecord`'s own doc comment): `"verdict-approved"` -> `"done"`,
   * `"verdict-escalated"` -> `"escalated"`. Like `recordTransitions()`,
   * every observed verdict IS a record -- no derivation step.
   */
  recordVerdicts(events: readonly VerdictEvent[]): void {
    const stmt = this.#db.prepare(
      `INSERT OR IGNORE INTO verdicts (issue_id, outcome, sub_issue_ids, escalation_key, occurred_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const recordedAt = Date.now();
    const insertAll = this.#db.transaction((rows: readonly VerdictEvent[]) => {
      for (const row of rows) {
        const outcome: VerdictRecord["outcome"] = row.type === "verdict-approved" ? "done" : "escalated";
        const escalationKey = row.type === "verdict-escalated" ? row.escalationKey : null;
        stmt.run(row.issueId, outcome, JSON.stringify(row.subIssueIds), escalationKey, row.timestamp, recordedAt);
      }
    });
    insertAll(events);
  }

  /** All persisted verdicts, oldest first. */
  getVerdicts(): VerdictRecord[] {
    const rows = this.#db
      .prepare<
        [],
        {
          issue_id: string;
          outcome: string;
          sub_issue_ids: string;
          escalation_key: string | null;
          occurred_at: number;
        }
      >(
        "SELECT issue_id, outcome, sub_issue_ids, escalation_key, occurred_at FROM verdicts ORDER BY occurred_at ASC",
      )
      .all();
    return rows.map((r) => {
      const base: VerdictRecord = {
        issueId: r.issue_id,
        outcome: r.outcome as VerdictRecord["outcome"],
        subIssueIds: JSON.parse(r.sub_issue_ids) as string[],
        timestamp: r.occurred_at,
      };
      return r.escalation_key !== null ? { ...base, escalationKey: r.escalation_key } : base;
    });
  }

  /** Closes the underlying sqlite connection. */
  close(): void {
    this.#db.close();
  }
}
