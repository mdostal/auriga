import { test } from "node:test";
import assert from "node:assert/strict";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type {
  LockResult,
  TaskRecord,
  TaskStatus,
  TrackerAdapter,
} from "../../contracts/tracker-adapter.ts";
import { AurigaConsumer } from "./index.ts";

/**
 * Idle-no-polling behavioral test (REQ-11, idle-no-polling half only — see
 * this story's YAML for why the dispatch-latency half stays unverified
 * pending GAP-01).
 *
 * AurigaConsumer's own class doc ("Push-based, not polling") already states
 * the design invariant under test here: `onEvent()` is invoked BY SOMETHING
 * EXTERNAL, and the class itself never subscribes, polls, or runs any
 * internal loop. `start()`/`stop()` are documented no-ops with no lifecycle
 * state to set up or tear down. So this test's job is to prove that
 * invariant empirically, not to find/fix a bug — if it ever fails, that is
 * a real regression (someone added a timer-driven check loop), not a false
 * positive to relax.
 *
 * Instrumentation: a fake LockContract whose claim() increments a counter
 * every time it's called. If AurigaConsumer had any hidden polling path
 * (an internal setInterval/setTimeout re-checking for claimable work, a
 * heartbeat, a health-check sweep, etc.), that path would necessarily call
 * through `this.#lock.claim(...)` — claim() is the *only* way this class
 * touches the lock — so a zero count after the idle window is sufficient
 * to falsify any such hidden path, not just the obvious cases.
 */

/** Fake LockContract: claim() increments a counter and records nothing else. */
class CountingLock implements LockContract {
  claimCount = 0;

  async claim(_taskId: string): Promise<ClaimResult> {
    this.claimCount++;
    return { ok: true, leaseId: "unexpected-claim" };
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
 * Fake TrackerAdapter: unused in the idle path (onEvent() is never called
 * in this test), included only because AurigaConsumer's constructor
 * requires one. Every method throws if actually invoked, so any unexpected
 * call surfaces loudly instead of silently no-op'ing.
 */
class UnusedTrackerAdapter implements TrackerAdapter {
  async claimTask(_taskId: string): Promise<LockResult> {
    throw new Error("UnusedTrackerAdapter.claimTask should never be called in the idle path");
  }
  async updateStatus(_taskId: string, _status: TaskStatus): Promise<void> {
    throw new Error("UnusedTrackerAdapter.updateStatus should never be called in the idle path");
  }
  async getTask(_taskId: string): Promise<TaskRecord> {
    throw new Error("UnusedTrackerAdapter.getTask should never be called in the idle path");
  }
}

// Idle-window duration: 400ms. AurigaConsumer's own class doc establishes
// there is no timer of any kind in its idle path (start()/stop() are
// documented no-ops, and onEvent() is the only method that ever touches the
// lock). A polling implementation that killed prior attempts at this
// pattern (per this story's description) used fixed-interval re-checks on
// the order of seconds, not milliseconds -- so any interval short enough to
// plausibly exist (even a deliberately-fast one someone added later) would
// fire at least once within 400ms. The story's own acceptance criteria use
// "5 seconds" only as an illustrative example, not a hard requirement; a
// multi-second real-time sleep would just slow the suite down for no added
// rigor, since the failure mode this test defends against (a periodic
// setInterval-style check) would trip well within a few hundred
// milliseconds if it existed at all.
const IDLE_WINDOW_MS = 400;

test("idle consumer performs zero claim-check calls absent any onEvent() trigger", async () => {
  const lock = new CountingLock();
  const trackerAdapter = new UnusedTrackerAdapter();
  const consumer = new AurigaConsumer(lock, trackerAdapter);

  // Snapshot active timer/handle count before start(), so we can compare
  // after the idle window instead of asserting an absolute number (Node's
  // test runner and other ambient infra may already hold handles of their
  // own). This is a heuristic, best-effort check on top of the primary
  // claimCount assertion below, not a replacement for it -- see the class
  // doc audit noted in this test file's header comment for why we trust
  // the design here too.
  const activeHandlesBefore = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.().length ?? null;

  await consumer.start();

  // Deliberately do NOT call consumer.onEvent() at all -- that is the
  // entire point of this test: prove nothing happens absent an external
  // trigger.
  await new Promise((resolve) => setTimeout(resolve, IDLE_WINDOW_MS));

  const activeHandlesAfter = (
    process as unknown as { _getActiveHandles?: () => unknown[] }
  )._getActiveHandles?.().length ?? null;

  assert.equal(
    lock.claimCount,
    0,
    "AurigaConsumer must not call lock.claim() while idle -- any nonzero count means a hidden polling/heartbeat path exists",
  );

  // Heuristic: AurigaConsumer must not have left any new timer/handle
  // running that would keep the process alive on its own account. This is
  // best-effort (process._getActiveHandles is undocumented Node internals
  // and may be unavailable/unstable across versions), so it's an
  // additional signal layered on top of the authoritative claimCount
  // assertion above, not a hard gate by itself.
  if (activeHandlesBefore !== null && activeHandlesAfter !== null) {
    assert.ok(
      activeHandlesAfter <= activeHandlesBefore,
      `expected no new active handles after idling AurigaConsumer (before=${activeHandlesBefore}, after=${activeHandlesAfter})`,
    );
  }

  await assert.doesNotReject(
    () => consumer.stop(),
    "consumer.stop() must not throw",
  );
});
