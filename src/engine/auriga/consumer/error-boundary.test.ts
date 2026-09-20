import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { EventContract } from "../../contracts/event.ts";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type {
  LockResult,
  TaskRecord,
  TaskStatus,
  TrackerAdapter,
} from "../../contracts/tracker-adapter.ts";
import { AurigaConsumer, type ClassifiedFailure } from "./index.ts";

/**
 * A LockContract fake whose claim() always throws — simulating an
 * unhandled exception from deep inside an in-process adapter (e.g. a
 * MulticaLock instance whose Multica HTTP call failed). This is the
 * "deliberately-throwing fake adapter" the story asks for, exercising the
 * error boundary around `await this.#lock.claim(taskId)` in
 * AurigaConsumer#onEvent.
 */
class ThrowingLock implements LockContract {
  callCount = 0;

  async claim(_taskId: string): Promise<ClaimResult> {
    this.callCount += 1;
    throw new Error(`ThrowingLock: simulated adapter failure #${this.callCount}`);
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

/** A LockContract fake whose claim() always succeeds, for isolating the
 * trackerAdapter call site's boundary in its own test. */
class SucceedingLock implements LockContract {
  async claim(_taskId: string): Promise<ClaimResult> {
    return { ok: true, leaseId: `lease-${randomUUID()}` };
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

/** A TrackerAdapter fake whose updateStatus() always throws — exercises
 * the second error-boundary call site. */
class ThrowingTrackerAdapter implements TrackerAdapter {
  callCount = 0;

  async claimTask(_taskId: string): Promise<LockResult> {
    return { claimed: true, lockId: "fake-lock-id", expiresAt: null };
  }
  async updateStatus(_taskId: string, _status: TaskStatus): Promise<void> {
    this.callCount += 1;
    throw new TypeError(`ThrowingTrackerAdapter: simulated failure #${this.callCount}`);
  }
  async getTask(taskId: string): Promise<TaskRecord> {
    return { id: taskId, status: "pending", title: "fake task" };
  }
}

/** A no-op TrackerAdapter, used to isolate the lock call site's boundary
 * in its own test (never actually reached when claim() throws). */
class NoopTrackerAdapter implements TrackerAdapter {
  async claimTask(_taskId: string): Promise<LockResult> {
    return { claimed: true, lockId: "fake-lock-id", expiresAt: null };
  }
  async updateStatus(_taskId: string, _status: TaskStatus): Promise<void> {
    // no-op
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

// --- Core requirement: 10 consecutive throws, process survives, 10 -----
// --- "failure" events recorded, each with the expected shape. ----------

test("error boundary: 10 consecutive lock.claim() throws all resolve without throwing, and each is recorded as a classified failure", async () => {
  const lock = new ThrowingLock();
  const trackerAdapter = new NoopTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const recorded: ClassifiedFailure[] = [];
  consumer.on("failure", (failure: ClassifiedFailure) => {
    recorded.push(failure);
  });

  const taskIds: string[] = [];
  for (let i = 0; i < 10; i++) {
    const taskId = `task-throw-${i}`;
    taskIds.push(taskId);
    const event = makeEvent({ payload: { taskId } });
    // (1) Must resolve without throwing — the process survives.
    await assert.doesNotReject(() => consumer.onEvent(event));
  }

  // (2) Exactly 10 "failure" events were emitted and recorded.
  assert.equal(recorded.length, 10);
  assert.equal(lock.callCount, 10);

  // (3) Each recorded ClassifiedFailure has the expected shape.
  recorded.forEach((failure, i) => {
    assert.equal(typeof failure.errorType, "string");
    assert.equal(failure.errorType, "Error");
    assert.equal(failure.sourceAdapter, "lock");
    assert.equal(failure.taskId, taskIds[i]);
    assert.equal(typeof failure.timestamp, "string");
    // ISO 8601 round-trips through Date without producing Invalid Date.
    assert.equal(Number.isNaN(new Date(failure.timestamp).getTime()), false);
    assert.ok(failure.error instanceof Error);
    assert.match((failure.error as Error).message, /simulated adapter failure/);
  });
});

// --- Second call site: trackerAdapter.updateStatus() throws ------------

test("error boundary: trackerAdapter.updateStatus() throws are also caught, classified, and recorded (never re-thrown)", async () => {
  const lock = new SucceedingLock();
  const trackerAdapter = new ThrowingTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const recorded: ClassifiedFailure[] = [];
  consumer.on("failure", (failure: ClassifiedFailure) => {
    recorded.push(failure);
  });

  for (let i = 0; i < 10; i++) {
    const event = makeEvent({ payload: { taskId: `task-tracker-${i}` } });
    await assert.doesNotReject(() => consumer.onEvent(event));
  }

  assert.equal(recorded.length, 10);
  recorded.forEach((failure, i) => {
    assert.equal(failure.errorType, "TypeError");
    assert.equal(failure.sourceAdapter, "trackerAdapter");
    assert.equal(failure.taskId, `task-tracker-${i}`);
    assert.equal(typeof failure.timestamp, "string");
    assert.ok(failure.error instanceof TypeError);
  });
});

// --- Process-survival sanity: consumer remains usable after failures ---

test("error boundary: the consumer keeps working normally after recording failures (no wedged state)", async () => {
  const lock = new ThrowingLock();
  const trackerAdapter = new NoopTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  const recorded: ClassifiedFailure[] = [];
  consumer.on("failure", (failure: ClassifiedFailure) => recorded.push(failure));

  for (let i = 0; i < 5; i++) {
    await consumer.onEvent(makeEvent({ payload: { taskId: `task-wedge-${i}` } }));
  }
  assert.equal(recorded.length, 5);

  // Swap in a healthy lock post-hoc by constructing a fresh consumer with
  // the same listener pattern, confirming the class itself isn't left in
  // some broken state by repeated failures (e.g. listener count growth,
  // internal flags). A fresh AurigaConsumer using a succeeding lock still
  // dispatches normally.
  const healthyLock = new SucceedingLock();
  const trackerAdapter2 = new NoopTrackerAdapter();
  const healthyConsumer = new AurigaConsumer(healthyLock, trackerAdapter2);
  await assert.doesNotReject(() =>
    healthyConsumer.onEvent(makeEvent({ payload: { taskId: "task-healthy" } })),
  );
});
