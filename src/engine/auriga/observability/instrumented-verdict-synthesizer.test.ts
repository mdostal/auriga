// auriga/observability/instrumented-verdict-synthesizer.test.ts — tests
// InstrumentedVerdictSynthesizer, mirroring instrumented-lock.ts's own
// "wrap + observe + re-emit" decorator shape (see that file's class doc)
// applied to VerdictSynthesizer's real "verdict-approved"/"verdict-escalated"
// events (auriga/watcher/verdict-synthesis.ts) instead of LockContract's
// claim/release calls. Written before the implementation, per
// observability-transition-verdict-counters.yaml's tdd methodology.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { InstrumentedVerdictSynthesizer } from "./instrumented-verdict-synthesizer.ts";
import type { VerdictApprovedEvent, VerdictEscalatedEvent } from "../watcher/verdict-synthesis.ts";

/** A minimal fake standing in for a real VerdictSynthesizer -- written
 * against the narrow event-source shape InstrumentedVerdictSynthesizer
 * needs (an EventEmitter emitting "verdict-approved"/"verdict-escalated"),
 * not the concrete class. */
class FakeVerdictSynthesizer extends EventEmitter {}

test("records a verdict-approved outcome as a VerdictEvent", () => {
  const fake = new FakeVerdictSynthesizer();
  const instrumented = new InstrumentedVerdictSynthesizer(fake);

  const verdict: VerdictApprovedEvent = { issueId: "parent-1", subIssueIds: ["s1", "s2"] };
  fake.emit("verdict-approved", verdict);

  assert.equal(instrumented.events.length, 1);
  const event = instrumented.events[0];
  assert.ok(event);
  assert.equal(event.type, "verdict-approved");
  assert.equal(event.issueId, "parent-1");
  assert.deepEqual(event.subIssueIds, ["s1", "s2"]);
  assert.equal(typeof event.timestamp, "number");
});

test("records a verdict-escalated outcome as a VerdictEvent, carrying the escalation key", () => {
  const fake = new FakeVerdictSynthesizer();
  const instrumented = new InstrumentedVerdictSynthesizer(fake);

  const verdict: VerdictEscalatedEvent = {
    issueId: "parent-2",
    subIssueIds: ["s3"],
    escalationKey: "escalation:verdict_disagreement:parent-2:x",
  };
  fake.emit("verdict-escalated", verdict);

  assert.equal(instrumented.events.length, 1);
  const event = instrumented.events[0];
  assert.ok(event);
  assert.equal(event.type, "verdict-escalated");
  assert.equal(event.issueId, "parent-2");
  assert.deepEqual(event.subIssueIds, ["s3"]);
  if (event.type === "verdict-escalated") {
    assert.equal(event.escalationKey, "escalation:verdict_disagreement:parent-2:x");
  } else {
    assert.fail("expected a verdict-escalated event");
  }
});

test("accumulates multiple verdicts across both outcome kinds, in observed order", () => {
  const fake = new FakeVerdictSynthesizer();
  const instrumented = new InstrumentedVerdictSynthesizer(fake);

  fake.emit("verdict-approved", { issueId: "parent-1", subIssueIds: ["s1"] });
  fake.emit("verdict-escalated", { issueId: "parent-2", subIssueIds: ["s2"], escalationKey: "k" });

  assert.deepEqual(
    instrumented.events.map((e) => [e.type, e.issueId]),
    [
      ["verdict-approved", "parent-1"],
      ["verdict-escalated", "parent-2"],
    ],
  );
});

test("events getter returns a defensive-copy snapshot, safe to feed into deriveTransitionVerdictCounts", () => {
  const fake = new FakeVerdictSynthesizer();
  const instrumented = new InstrumentedVerdictSynthesizer(fake);

  fake.emit("verdict-approved", { issueId: "parent-1", subIssueIds: [] });
  const snapshot = instrumented.events;
  fake.emit("verdict-approved", { issueId: "parent-2", subIssueIds: [] });

  assert.equal(snapshot.length, 1, "snapshot taken before the second emit must not grow");
  assert.equal(instrumented.events.length, 2);
});

test('re-emits "event" live for each recorded verdict', () => {
  const fake = new FakeVerdictSynthesizer();
  const instrumented = new InstrumentedVerdictSynthesizer(fake);

  const seen: unknown[] = [];
  instrumented.on("event", (e) => seen.push(e));

  fake.emit("verdict-approved", { issueId: "parent-1", subIssueIds: [] });
  fake.emit("verdict-escalated", { issueId: "parent-2", subIssueIds: [], escalationKey: "k" });

  assert.equal(seen.length, 2);
});

test("observe and record only -- construction and event recording never call any method on the wrapped source", () => {
  const fake = new FakeVerdictSynthesizer();
  assert.doesNotThrow(() => {
    const instrumented = new InstrumentedVerdictSynthesizer(fake);
    fake.emit("verdict-approved", { issueId: "parent-1", subIssueIds: [] });
    void instrumented;
  });
});
