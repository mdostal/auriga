// auriga/observability/instrumented-watcher.test.ts — tests InstrumentedWatcher,
// mirroring instrumented-lock.ts's own "wrap + observe + re-emit" decorator
// shape (see that file's class doc) applied to BoardStateWatcher's real
// "dispatch-eligible"/"review-eligible" events (auriga/watcher/index.ts)
// instead of LockContract's claim/release calls. Written before the
// implementation, per observability-transition-verdict-counters.yaml's tdd
// methodology.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { InstrumentedWatcher } from "./instrumented-watcher.ts";
import type { BoardStateTransitionEvent } from "../watcher/index.ts";

/** A minimal fake standing in for a real BoardStateWatcher -- InstrumentedWatcher
 * is written against the narrow event-source shape it needs (an EventEmitter
 * emitting "dispatch-eligible"/"review-eligible"), not the concrete class, so
 * a fake works identically here to how InstrumentedLock's own callers can
 * wrap any LockContract-conforming fake. */
class FakeWatcher extends EventEmitter {}

test("records a dispatch-eligible transition as a TransitionEvent", () => {
  const fake = new FakeWatcher();
  const instrumented = new InstrumentedWatcher(fake);

  const transition: BoardStateTransitionEvent = { issueId: "issue-1", previousStatus: undefined };
  fake.emit("dispatch-eligible", transition);

  assert.equal(instrumented.events.length, 1);
  const event = instrumented.events[0];
  assert.ok(event);
  assert.equal(event.type, "dispatch-eligible");
  assert.equal(event.issueId, "issue-1");
  assert.equal(event.previousStatus, undefined);
  assert.equal(typeof event.timestamp, "number");
});

test("records a review-eligible transition as a TransitionEvent, carrying previousStatus", () => {
  const fake = new FakeWatcher();
  const instrumented = new InstrumentedWatcher(fake);

  const transition: BoardStateTransitionEvent = { issueId: "issue-2", previousStatus: "in_progress" };
  fake.emit("review-eligible", transition);

  assert.equal(instrumented.events.length, 1);
  assert.equal(instrumented.events[0]?.type, "review-eligible");
  assert.equal(instrumented.events[0]?.issueId, "issue-2");
  assert.equal(instrumented.events[0]?.previousStatus, "in_progress");
});

test("accumulates multiple transitions across both event kinds, in observed order", () => {
  const fake = new FakeWatcher();
  const instrumented = new InstrumentedWatcher(fake);

  fake.emit("dispatch-eligible", { issueId: "issue-1", previousStatus: undefined });
  fake.emit("review-eligible", { issueId: "issue-2", previousStatus: "in_progress" });
  fake.emit("dispatch-eligible", { issueId: "issue-3", previousStatus: "backlog" });

  assert.deepEqual(
    instrumented.events.map((e) => [e.type, e.issueId]),
    [
      ["dispatch-eligible", "issue-1"],
      ["review-eligible", "issue-2"],
      ["dispatch-eligible", "issue-3"],
    ],
  );
});

test("events getter returns a defensive-copy snapshot, safe to feed into deriveTransitionVerdictCounts", () => {
  const fake = new FakeWatcher();
  const instrumented = new InstrumentedWatcher(fake);

  fake.emit("dispatch-eligible", { issueId: "issue-1", previousStatus: undefined });
  const snapshot = instrumented.events;
  fake.emit("dispatch-eligible", { issueId: "issue-2", previousStatus: undefined });

  assert.equal(snapshot.length, 1, "snapshot taken before the second emit must not grow");
  assert.equal(instrumented.events.length, 2);
});

test('re-emits "event" live for each recorded transition, mirroring InstrumentedLock\'s own live-consumption path', () => {
  const fake = new FakeWatcher();
  const instrumented = new InstrumentedWatcher(fake);

  const seen: unknown[] = [];
  instrumented.on("event", (e) => seen.push(e));

  fake.emit("dispatch-eligible", { issueId: "issue-1", previousStatus: undefined });
  fake.emit("review-eligible", { issueId: "issue-2", previousStatus: "in_progress" });

  assert.equal(seen.length, 2);
});

test("observe and record only -- construction and event recording never call any method on the wrapped source", () => {
  // InstrumentedWatcher must not proxy/delegate start()/stop()/etc -- it
  // only subscribes to events an already-constructed watcher emits (no
  // behavioral coupling, per this story's own risk mitigation). Proven here
  // with a fake exposing nothing but EventEmitter's own on()/emit().
  const fake = new FakeWatcher();
  assert.doesNotThrow(() => {
    const instrumented = new InstrumentedWatcher(fake);
    fake.emit("dispatch-eligible", { issueId: "issue-1", previousStatus: undefined });
    void instrumented;
  });
});
