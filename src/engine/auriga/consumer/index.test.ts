import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { runConsumerContractTests } from "../../contracts/test-harness/consumer.ts";
import type { EventContract } from "../../contracts/event.ts";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type {
  LockResult,
  TaskRecord,
  TaskStatus,
  TrackerAdapter,
} from "../../contracts/tracker-adapter.ts";
import { AurigaConsumer } from "./index.ts";

/**
 * Controllable fake LockContract: claim() always resolves to whatever
 * `claimResult` currently holds (set per-test), and records every taskId
 * it was called with, so tests can assert both the outcome AND that the
 * consumer actually called claim() with the derived taskId.
 */
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

/**
 * Controllable fake TrackerAdapter: records every updateStatus() call so
 * tests can assert dispatch did (or did not) happen.
 */
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

function makeEvent(overrides: Partial<EventContract> = {}): EventContract {
  return {
    id: randomUUID(),
    type: "task.claimable",
    payload: { taskId: `task-${randomUUID()}` },
    timestamp: new Date().toISOString(),
    source: "test-fixture",
    ...overrides,
  };
}

// --- Generic ConsumerContract harness ---------------------------------
// Fake dependencies here: this exercises the ConsumerContract shape
// (structural + "the lifecycle must not throw"), not live Multica. Using
// an always-succeeding claim so the harness's single onEvent() call
// exercises the full claim -> dispatch path without throwing.

test("AurigaConsumer satisfies the generic ConsumerContract harness", async () => {
  const lock = new FakeLock();
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  await runConsumerContractTests(consumer);
});

// --- Behavioral: claim-then-dispatch -----------------------------------

test("claim-then-dispatch: a successful claim causes the tracker adapter to be called", async () => {
  const lock = new FakeLock();
  lock.claimResult = { ok: true, leaseId: "lease-1" };
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const event = makeEvent({ payload: { taskId: "task-abc" } });
  await consumer.onEvent(event);

  assert.deepEqual(lock.claimedTaskIds, ["task-abc"]);
  assert.equal(trackerAdapter.updateStatusCalls.length, 1);
  assert.deepEqual(trackerAdapter.updateStatusCalls[0], {
    taskId: "task-abc",
    status: "in_progress",
  });
});

// --- Behavioral: claim-rejected-then-no-dispatch ------------------------

test("claim-rejected-then-no-dispatch: an already_claimed result causes no dispatch and does not throw", async () => {
  const lock = new FakeLock();
  lock.claimResult = { ok: false, reason: "already_claimed" };
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const event = makeEvent({ payload: { taskId: "task-xyz" } });

  await assert.doesNotReject(() => consumer.onEvent(event));

  assert.deepEqual(lock.claimedTaskIds, ["task-xyz"]);
  assert.equal(trackerAdapter.updateStatusCalls.length, 0);
});

// --- Behavioral: taskId extraction fallback -----------------------------

test("onEvent falls back to the event's own id when payload carries no taskId/id", async () => {
  const lock = new FakeLock();
  const trackerAdapter = new FakeTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const event = makeEvent({ id: "evt-fallback-1", payload: { harness: true } });
  await consumer.onEvent(event);

  assert.deepEqual(lock.claimedTaskIds, ["evt-fallback-1"]);
});
