import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  deriveCounters,
  deriveTransitionVerdictCounts,
  ObservabilityCounterStore,
  DEFAULT_DROPPED_WINDOW_MS,
  type LockEvent,
  type TransitionEvent,
  type VerdictEvent,
  type VerdictRecord,
} from "./counters.ts";

function scratchDbPath(): string {
  return join(tmpdir(), `auriga-observability-counters-${randomUUID()}.sqlite`);
}

// A fixed base instant for all synthetic event timestamps, so tests never
// depend on real wall-clock time.
const T0 = 1_700_000_000_000;

test("dropped: claimed with no matching release, window elapsed -> counted dropped with attribution", () => {
  const events: LockEvent[] = [
    { type: "claimed", taskId: "task-a", leaseId: "lease-a1", timestamp: T0 },
  ];

  // Evaluate at exactly the window boundary past the claim.
  const now = T0 + DEFAULT_DROPPED_WINDOW_MS;

  const result = deriveCounters(events, { now });

  assert.equal(result.dropped.length, 1);
  assert.deepEqual(result.dropped[0], {
    taskId: "task-a",
    leaseId: "lease-a1",
    claimedAt: T0,
    cause: "claimed_never_released_within_window",
  });
  assert.equal(result.duplicated.length, 0, "a single claimed-but-unreleased task must not be counted as duplicated");
});

test("dropped: claimed with no release but window NOT yet elapsed -> not counted (still in flight)", () => {
  const events: LockEvent[] = [
    { type: "claimed", taskId: "task-a", leaseId: "lease-a1", timestamp: T0 },
  ];

  const now = T0 + DEFAULT_DROPPED_WINDOW_MS - 1;

  const result = deriveCounters(events, { now });

  assert.equal(result.dropped.length, 0);
});

test("duplicated: two distinct claimed events for the same task id, overlapping -> counted duplicated with attribution", () => {
  const events: LockEvent[] = [
    { type: "claimed", taskId: "task-b", leaseId: "lease-b1", timestamp: T0 },
    // A second, distinct lease claims the SAME task id before the first
    // lease was ever released -- the cross-process double-claim scenario
    // documented as an accepted P1 gap in auriga/lock/index.ts.
    { type: "claimed", taskId: "task-b", leaseId: "lease-b2", timestamp: T0 + 1_000 },
  ];

  const now = T0 + 2_000; // well within the window; duplication must still fire

  const result = deriveCounters(events, { now });

  assert.equal(result.duplicated.length, 1);
  const dup = result.duplicated[0];
  assert.ok(dup);
  assert.equal(dup.taskId, "task-b");
  assert.deepEqual(
    [...dup.claims].sort((a, b) => a.leaseId.localeCompare(b.leaseId)),
    [
      { leaseId: "lease-b1", timestamp: T0 },
      { leaseId: "lease-b2", timestamp: T0 + 1_000 },
    ],
  );
});

test("healthy: claimed then released within the window -> neither counter fires", () => {
  const events: LockEvent[] = [
    { type: "claimed", taskId: "task-c", leaseId: "lease-c1", timestamp: T0 },
    { type: "released", taskId: "task-c", leaseId: "lease-c1", timestamp: T0 + 5_000 },
  ];

  // Evaluate well past the window -- a completed task must never be
  // reported dropped just because time has passed since it finished.
  const now = T0 + DEFAULT_DROPPED_WINDOW_MS * 10;

  const result = deriveCounters(events, { now });

  assert.equal(result.dropped.length, 0, "a released task must never be counted as dropped");
  assert.equal(result.duplicated.length, 0, "a single claim/release pair must never be counted as duplicated");
});

test("healthy: released then re-claimed later (legitimate reclaim) -> not counted as duplicated", () => {
  // taskId claimed, released, and later re-claimed by a different lease
  // (e.g. a normal retry, or sweep() reclaiming a stale lease and someone
  // else picking the task back up). This must NOT be flagged as
  // duplicated -- the two leases' held-intervals do not overlap.
  const events: LockEvent[] = [
    { type: "claimed", taskId: "task-d", leaseId: "lease-d1", timestamp: T0 },
    { type: "released", taskId: "task-d", leaseId: "lease-d1", timestamp: T0 + 1_000 },
    { type: "claimed", taskId: "task-d", leaseId: "lease-d2", timestamp: T0 + 2_000 },
    { type: "released", taskId: "task-d", leaseId: "lease-d2", timestamp: T0 + 3_000 },
  ];

  const now = T0 + 4_000;

  const result = deriveCounters(events, { now });

  assert.equal(result.duplicated.length, 0);
  assert.equal(result.dropped.length, 0);
});

test("persistence: dropped/duplicated findings survive process exit (close + reopen against same file)", () => {
  const dbPath = scratchDbPath();

  try {
    const events: LockEvent[] = [
      // dropped: claimed, never released, window elapses.
      { type: "claimed", taskId: "task-e", leaseId: "lease-e1", timestamp: T0 },
      // duplicated: two overlapping claims for the same task id, BOTH
      // released (so this group is unambiguously a duplication finding,
      // not also incidentally a dropped-task finding).
      { type: "claimed", taskId: "task-f", leaseId: "lease-f1", timestamp: T0 },
      { type: "released", taskId: "task-f", leaseId: "lease-f1", timestamp: T0 + 2_000 },
      { type: "claimed", taskId: "task-f", leaseId: "lease-f2", timestamp: T0 + 500 },
      { type: "released", taskId: "task-f", leaseId: "lease-f2", timestamp: T0 + 2_500 },
    ];
    const now = T0 + DEFAULT_DROPPED_WINDOW_MS;
    const derived = deriveCounters(events, { now });
    assert.equal(derived.dropped.length, 1);
    assert.equal(derived.duplicated.length, 1);

    // "Process 1": derive, persist, close -- simulating shutdown.
    const writer = new ObservabilityCounterStore(dbPath);
    writer.record(derived);
    writer.close();

    // "Process 2": brand new store instance pointed at the same file.
    const reader = new ObservabilityCounterStore(dbPath);
    const droppedAfterReopen = reader.getDroppedTasks();
    const duplicatedAfterReopen = reader.getDuplicatedTasks();
    reader.close();

    assert.equal(droppedAfterReopen.length, 1);
    assert.deepEqual(droppedAfterReopen[0], {
      taskId: "task-e",
      leaseId: "lease-e1",
      claimedAt: T0,
      cause: "claimed_never_released_within_window",
    });

    assert.equal(duplicatedAfterReopen.length, 1);
    assert.equal(duplicatedAfterReopen[0]?.taskId, "task-f");
    assert.deepEqual(
      [...(duplicatedAfterReopen[0]?.claims ?? [])].sort((a, b) => a.leaseId.localeCompare(b.leaseId)),
      [
        { leaseId: "lease-f1", timestamp: T0 },
        { leaseId: "lease-f2", timestamp: T0 + 500 },
      ],
    );
    // task-f's claims were both released -- they must not ALSO show up as
    // dropped-task findings.
    assert.equal(
      droppedAfterReopen.some((d) => d.taskId === "task-f"),
      false,
    );
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("persistence: re-recording the same derived counters is idempotent (no duplicate rows)", () => {
  const dbPath = scratchDbPath();

  try {
    const events: LockEvent[] = [
      { type: "claimed", taskId: "task-g", leaseId: "lease-g1", timestamp: T0 },
    ];
    const derived = deriveCounters(events, { now: T0 + DEFAULT_DROPPED_WINDOW_MS });

    const store = new ObservabilityCounterStore(dbPath);
    store.record(derived);
    store.record(derived); // re-persisting the same finding must not duplicate it
    const dropped = store.getDroppedTasks();
    store.close();

    assert.equal(dropped.length, 1);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

// --- deriveTransitionVerdictCounts -----------------------------------------
//
// Mirrors deriveCounters()'s own test shape: a pure function fed a synthetic
// stream of TransitionEvent/VerdictEvent, no I/O, no mutation. Per
// observability-transition-verdict-counters.yaml's NOTE, these events mirror
// BoardStateWatcher's real "dispatch-eligible"/"review-eligible" events
// (auriga/watcher/index.ts) and VerdictSynthesizer's real "verdict-approved"/
// "verdict-escalated" events (auriga/watcher/verdict-synthesis.ts).

test("deriveTransitionVerdictCounts: transitionsFired counts both dispatch-eligible and review-eligible; swarmsDispatched counts review-eligible only", () => {
  const events: (TransitionEvent | VerdictEvent)[] = [
    { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
    { type: "dispatch-eligible", issueId: "issue-2", previousStatus: "backlog", timestamp: T0 + 1_000 },
    { type: "review-eligible", issueId: "issue-3", previousStatus: "in_progress", timestamp: T0 + 2_000 },
  ];

  const result = deriveTransitionVerdictCounts(events);

  assert.deepEqual(result, {
    transitionsFired: 3,
    swarmsDispatched: 1,
    unanimousApproveCount: 0,
    escalationCount: 0,
  });
});

test("deriveTransitionVerdictCounts: counts unanimous-approve and escalation verdict outcomes independently of transitions", () => {
  const events: (TransitionEvent | VerdictEvent)[] = [
    { type: "verdict-approved", issueId: "parent-1", subIssueIds: ["s1", "s2"], timestamp: T0 },
    {
      type: "verdict-escalated",
      issueId: "parent-2",
      subIssueIds: ["s3", "s4"],
      escalationKey: "escalation:verdict_disagreement:parent-2:x",
      timestamp: T0 + 1_000,
    },
    { type: "verdict-approved", issueId: "parent-3", subIssueIds: ["s5"], timestamp: T0 + 2_000 },
  ];

  const result = deriveTransitionVerdictCounts(events);

  assert.deepEqual(result, {
    transitionsFired: 0,
    swarmsDispatched: 0,
    unanimousApproveCount: 2,
    escalationCount: 1,
  });
});

test("deriveTransitionVerdictCounts: a mixed stream of transitions and verdicts computes all four counts together", () => {
  const events: (TransitionEvent | VerdictEvent)[] = [
    { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
    { type: "review-eligible", issueId: "issue-2", previousStatus: "in_progress", timestamp: T0 + 1_000 },
    { type: "verdict-approved", issueId: "parent-1", subIssueIds: ["s1"], timestamp: T0 + 2_000 },
    {
      type: "verdict-escalated",
      issueId: "parent-2",
      subIssueIds: ["s2"],
      escalationKey: "escalation:verdict_disagreement:parent-2:x",
      timestamp: T0 + 3_000,
    },
  ];

  const result = deriveTransitionVerdictCounts(events);

  assert.deepEqual(result, {
    transitionsFired: 2,
    swarmsDispatched: 1,
    unanimousApproveCount: 1,
    escalationCount: 1,
  });
});

test("deriveTransitionVerdictCounts: empty stream -> all counts zero", () => {
  const result = deriveTransitionVerdictCounts([]);
  assert.deepEqual(result, {
    transitionsFired: 0,
    swarmsDispatched: 0,
    unanimousApproveCount: 0,
    escalationCount: 0,
  });
});

test("deriveTransitionVerdictCounts: pure -- does not mutate its input, works on a frozen array", () => {
  const events = Object.freeze([
    { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
  ]) as readonly (TransitionEvent | VerdictEvent)[];

  assert.doesNotThrow(() => deriveTransitionVerdictCounts(events));
  assert.equal(events.length, 1, "input array must not be mutated");
});

// --- ObservabilityCounterStore: transitions/verdicts (extended, not a second store) ---

test("transitions: persisted to sqlite with issue id, transition type, and timestamp, readable through the SAME store instance dropped/duplicated already use", () => {
  const dbPath = scratchDbPath();

  try {
    const store = new ObservabilityCounterStore(dbPath);

    const events: TransitionEvent[] = [
      { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
      { type: "review-eligible", issueId: "issue-2", previousStatus: "in_progress", timestamp: T0 + 1_000 },
    ];
    store.recordTransitions(events);

    const readBack = store.getTransitions();
    store.close();

    assert.equal(readBack.length, 2);
    assert.deepEqual(
      [...readBack].sort((a, b) => a.timestamp - b.timestamp),
      events,
    );
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("transitions: re-recording the same transition is idempotent (no duplicate rows)", () => {
  const dbPath = scratchDbPath();

  try {
    const store = new ObservabilityCounterStore(dbPath);
    const events: TransitionEvent[] = [
      { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
    ];
    store.recordTransitions(events);
    store.recordTransitions(events); // re-persisting the same transition must not duplicate it
    const readBack = store.getTransitions();
    store.close();

    assert.equal(readBack.length, 1);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("verdicts: persisted to sqlite with parent issue id, outcome (done/escalated), and timestamp, readable through the SAME store instance", () => {
  const dbPath = scratchDbPath();

  try {
    const store = new ObservabilityCounterStore(dbPath);

    const events: VerdictEvent[] = [
      { type: "verdict-approved", issueId: "parent-1", subIssueIds: ["s1", "s2"], timestamp: T0 },
      {
        type: "verdict-escalated",
        issueId: "parent-2",
        subIssueIds: ["s3"],
        escalationKey: "escalation:verdict_disagreement:parent-2:x",
        timestamp: T0 + 1_000,
      },
    ];
    store.recordVerdicts(events);

    const readBack = store.getVerdicts();
    store.close();

    const expected: VerdictRecord[] = [
      { issueId: "parent-1", outcome: "done", subIssueIds: ["s1", "s2"], timestamp: T0 },
      {
        issueId: "parent-2",
        outcome: "escalated",
        subIssueIds: ["s3"],
        escalationKey: "escalation:verdict_disagreement:parent-2:x",
        timestamp: T0 + 1_000,
      },
    ];

    assert.equal(readBack.length, 2);
    assert.deepEqual(
      [...readBack].sort((a, b) => a.timestamp - b.timestamp),
      expected,
    );
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("verdicts: re-recording the same verdict is idempotent (no duplicate rows)", () => {
  const dbPath = scratchDbPath();

  try {
    const store = new ObservabilityCounterStore(dbPath);
    const events: VerdictEvent[] = [
      { type: "verdict-approved", issueId: "parent-1", subIssueIds: ["s1"], timestamp: T0 },
    ];
    store.recordVerdicts(events);
    store.recordVerdicts(events); // re-persisting the same verdict must not duplicate it
    const readBack = store.getVerdicts();
    store.close();

    assert.equal(readBack.length, 1);
  } finally {
    rmSync(dbPath, { force: true });
  }
});

test("transitions and verdicts are readable through the SAME ObservabilityCounterStore instance that already serves dropped/duplicated tasks -- extended, not a parallel store", () => {
  const dbPath = scratchDbPath();

  try {
    const store = new ObservabilityCounterStore(dbPath);

    // Pre-existing P1 surface still works, same instance.
    store.record(
      deriveCounters([{ type: "claimed", taskId: "task-x", leaseId: "lease-x1", timestamp: T0 }], {
        now: T0 + DEFAULT_DROPPED_WINDOW_MS,
      }),
    );
    // New P2 surfaces, same instance -- not a second store.
    store.recordTransitions([
      { type: "dispatch-eligible", issueId: "issue-1", previousStatus: undefined, timestamp: T0 },
    ]);
    store.recordVerdicts([
      { type: "verdict-approved", issueId: "parent-1", subIssueIds: ["s1"], timestamp: T0 },
    ]);

    assert.equal(store.getDroppedTasks().length, 1);
    assert.equal(store.getTransitions().length, 1);
    assert.equal(store.getVerdicts().length, 1);

    store.close();
  } finally {
    rmSync(dbPath, { force: true });
  }
});
