// auriga/watcher/dispatch-wiring.test.ts — tests the translation/wiring
// this story (auto-dispatch-wiring) adds: BoardStateWatcher's
// "dispatch-eligible" events -> AurigaConsumer.onEvent(). Written before
// the implementation (dispatch-wiring.ts), per this story's `tdd`
// methodology.
//
// Mirrors auriga/watcher/index.test.ts's mocked-Multica pattern (node:test's
// `t.mock.method` on `globalThis.fetch`) for the watcher half, and
// auriga/consumer/index.test.ts's FakeLock/FakeTrackerAdapter pattern for
// the consumer half -- this file exercises both a lightweight test-double
// consumer (to isolate the wiring itself, per this story's own test-spec
// step) AND a real AurigaConsumer wired to fakes (to prove the acceptance
// criteria against the actual production classes, not just a stand-in).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardStateWatcher, type BoardStateWatcherConfig, type BoardStateTransitionEvent } from "./index.ts";
import { toDispatchEvent, wireDispatchEligible, type OnEventConsumer } from "./dispatch-wiring.ts";
import { AurigaConsumer } from "../consumer/index.ts";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type { EventContract } from "../../contracts/event.ts";
import type { LockResult, TaskRecord, TaskStatus, TrackerAdapter } from "../../contracts/tracker-adapter.ts";

interface FakeIssue {
  id: string;
  status: string;
  project_id?: string;
}

function issuesResponse(issues: FakeIssue[]): Response {
  return new Response(JSON.stringify({ issues }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function baseWatcherConfig(overrides: Partial<BoardStateWatcherConfig> = {}): BoardStateWatcherConfig {
  return {
    serverUrl: "http://fake-multica.test",
    workspaceId: "ws-1",
    projectId: "project-1",
    token: "fake-token",
    pollIntervalMs: 15,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Records every onEvent() call it receives -- lets tests assert exactly
 * what wireDispatchEligible() handed the consumer, without needing a real
 * AurigaConsumer for the tests that only care about the translation/wiring
 * itself. */
class RecordingConsumer implements OnEventConsumer {
  events: EventContract[] = [];
  async onEvent(event: EventContract): Promise<void> {
    this.events.push(event);
  }
}

/** Controllable fake LockContract -- same shape as
 * auriga/consumer/index.test.ts's FakeLock, duplicated locally rather than
 * imported since that class isn't exported (test-file-local fixture). */
class FakeLock implements LockContract {
  claimResult: ClaimResult = { ok: true, leaseId: "fake-lease" };
  claimedTaskIds: string[] = [];

  async claim(taskId: string): Promise<ClaimResult> {
    this.claimedTaskIds.push(taskId);
    return this.claimResult;
  }
  async renew(_leaseId: string): Promise<boolean> {
    return true;
  }
  async release(_leaseId: string): Promise<void> {
    // no-op
  }
  async sweep(): Promise<string[]> {
    return [];
  }
}

class FakeTrackerAdapter implements TrackerAdapter {
  updateStatusCalls: { taskId: string; status: TaskStatus }[] = [];

  async claimTask(_taskId: string): Promise<LockResult> {
    return { claimed: true, lockId: "fake-lock-id", expiresAt: null };
  }
  async updateStatus(taskId: string, status: TaskStatus): Promise<void> {
    this.updateStatusCalls.push({ taskId, status });
  }
  async getTask(taskId: string): Promise<TaskRecord> {
    return { id: taskId, status: "pending", title: "fake task" };
  }
}

// --- toDispatchEvent(): pure translation -------------------------------

test("toDispatchEvent derives an EventContract-shaped event with payload.taskId set to the issue id", () => {
  const transition: BoardStateTransitionEvent = { issueId: "issue-123", previousStatus: undefined };
  const event = toDispatchEvent(transition);

  assert.equal(typeof event.id, "string");
  assert.ok(event.id.length > 0);
  assert.equal(event.type, "task.claimable");
  assert.deepEqual(event.payload, { taskId: "issue-123" });
  assert.equal(typeof event.timestamp, "string");
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)), "timestamp should be a parseable ISO string");
  assert.equal(typeof event.source, "string");
  assert.ok(event.source.length > 0);
});

test("toDispatchEvent produces a distinct event id for repeated transitions on the same issue", () => {
  const transition: BoardStateTransitionEvent = { issueId: "issue-repeat", previousStatus: "in_review" };
  const first = toDispatchEvent(transition);
  const second = toDispatchEvent(transition);

  assert.notEqual(first.id, second.id, "two separate transitions on the same issue should not collide on event id");
  assert.deepEqual(first.payload, second.payload, "both should still carry the same taskId");
});

// --- wireDispatchEligible(): watcher -> test-double consumer -----------

test("a dispatch-eligible event causes onEvent() to be called with an EventContract-shaped event derived from that issue", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([{ id: "real-issue-1", status: "todo", project_id: "project-1" }]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const consumer = new RecordingConsumer();
  wireDispatchEligible(watcher, consumer);

  watcher.start();
  await delay(60);
  await watcher.stop();

  assert.equal(consumer.events.length, 1, "onEvent() should have been called exactly once");
  const event = consumer.events[0]!;
  assert.equal(event.type, "task.claimable");
  assert.deepEqual(
    event.payload,
    { taskId: "real-issue-1" },
    "the event must be derived from the real issue's id, not a synthetic payload",
  );
  assert.equal(typeof event.timestamp, "string");
  assert.equal(typeof event.source, "string");
});

test("review-eligible events are NOT wired to onEvent() -- only dispatch-eligible is", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([{ id: "review-issue-1", status: "in_review", project_id: "project-1" }]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const consumer = new RecordingConsumer();
  wireDispatchEligible(watcher, consumer);

  watcher.start();
  await delay(60);
  await watcher.stop();

  assert.equal(consumer.events.length, 0, "review-eligible transitions must not reach onEvent() via this wiring");
});

test("multiple dispatch-eligible issues each produce their own onEvent() call, carrying their own issue id", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([
      { id: "issue-a", status: "todo", project_id: "project-1" },
      { id: "issue-b", status: "todo", project_id: "project-1" },
    ]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const consumer = new RecordingConsumer();
  wireDispatchEligible(watcher, consumer);

  watcher.start();
  await delay(60);
  await watcher.stop();

  const taskIds = consumer.events
    .map((e) => (e.payload as { taskId: string }).taskId)
    .sort();
  assert.deepEqual(taskIds, ["issue-a", "issue-b"]);
});

test("wireDispatchEligible does not throw or crash when onEvent() rejects (defensive backstop, not a new handling path)", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([{ id: "issue-throws", status: "todo", project_id: "project-1" }]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const throwingConsumer: OnEventConsumer = {
    onEvent: async () => {
      throw new Error("simulated unexpected onEvent failure");
    },
  };

  let uncaught: unknown;
  const onUnhandledRejection = (reason: unknown) => {
    uncaught = reason;
  };
  process.on("unhandledRejection", onUnhandledRejection);

  try {
    wireDispatchEligible(watcher, throwingConsumer);
    watcher.start();
    await delay(60);
    await watcher.stop();
    // give any stray microtask a chance to surface as an unhandled rejection
    await delay(10);
  } finally {
    process.off("unhandledRejection", onUnhandledRejection);
  }

  assert.equal(uncaught, undefined, "a rejected onEvent() must not escape as an unhandled rejection");
});

// --- Acceptance criterion 3: claim rejection is handled exactly as -----
// AurigaConsumer already handles it today (silent, no new error path) -----

test("a dispatch-eligible event whose claim is already_claimed is handled silently by the real AurigaConsumer -- no dispatch, no throw, no new error path", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([{ id: "already-claimed-issue", status: "todo", project_id: "project-1" }]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const lock = new FakeLock();
  lock.claimResult = { ok: false, reason: "already_claimed" };
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const failures: unknown[] = [];
  consumer.on("failure", (f: unknown) => failures.push(f));

  wireDispatchEligible(watcher, consumer);

  watcher.start();
  await delay(60);
  await watcher.stop();

  assert.deepEqual(lock.claimedTaskIds, ["already-claimed-issue"], "the consumer's existing claim path was reached");
  assert.equal(
    trackerAdapter.updateStatusCalls.length,
    0,
    "an already-claimed task must never be dispatched to the tracker adapter",
  );
  assert.equal(failures.length, 0, "an already_claimed result is a normal outcome, not a failure -- no failure event");
});

test("a dispatch-eligible event whose claim succeeds is dispatched via the real AurigaConsumer's existing claim -> mark-in_progress path", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    issuesResponse([{ id: "claimable-issue", status: "todo", project_id: "project-1" }]),
  );

  const watcher = new BoardStateWatcher(baseWatcherConfig());
  const lock = new FakeLock();
  lock.claimResult = { ok: true, leaseId: "lease-xyz" };
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  wireDispatchEligible(watcher, consumer);

  watcher.start();
  await delay(60);
  await watcher.stop();

  assert.deepEqual(lock.claimedTaskIds, ["claimable-issue"]);
  assert.equal(trackerAdapter.updateStatusCalls.length, 1);
  assert.deepEqual(trackerAdapter.updateStatusCalls[0], { taskId: "claimable-issue", status: "in_progress" });
});
