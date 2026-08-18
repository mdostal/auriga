import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { StateTracker } from "./tracker.js";

describe("StateTracker", () => {
  let tempDir: string;
  let tracker: StateTracker;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "auriga-state-tracker-"));
    tracker = new StateTracker(join(tempDir, "findings.sqlite"), {
      logger: silentLogger,
    });
    assert.equal(tracker.initialize(), true);
  });

  afterEach(() => {
    tracker.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates a new record with occurrence_count set to 1", () => {
    const record = tracker.recordFinding({
      id: "finding:dispatch-gap:1",
      category: "dispatch_gap",
      title: "Dead-zoned ticket",
      timestamp: epoch(10),
    });

    assert.deepEqual(record, {
      id: "finding:dispatch-gap:1",
      category: "dispatch_gap",
      title: "Dead-zoned ticket",
      first_seen: 10,
      last_seen: 10,
      occurrence_count: 1,
      auto_recovered_count: 0,
      escalated_count: 0,
    });
  });

  it("deduplicates an existing finding by incrementing occurrence_count and last_seen", () => {
    tracker.recordFinding({
      id: "finding:stall:1",
      category: "stall",
      title: "Build stalled",
      timestamp: epoch(10),
    });

    const record = tracker.recordFinding({
      id: "finding:stall:1",
      category: "stall",
      title: "Build still stalled",
      timestamp: epoch(70),
    });

    assert.equal(record?.first_seen, 10);
    assert.equal(record?.last_seen, 70);
    assert.equal(record?.occurrence_count, 2);
    assert.equal(record?.title, "Build still stalled");
  });

  it("does not move last_seen backward for out-of-order duplicate observations", () => {
    tracker.recordFinding({
      id: "finding:stall:out-of-order",
      category: "stall",
      title: "Build stalled",
      timestamp: epoch(70),
    });

    const record = tracker.recordFinding({
      id: "finding:stall:out-of-order",
      category: "stall",
      title: "Older duplicate",
      timestamp: epoch(10),
    });

    assert.equal(record?.first_seen, 70);
    assert.equal(record?.last_seen, 70);
    assert.equal(record?.occurrence_count, 2);
  });

  it("returns findings recurring above a threshold within a time window", () => {
    tracker.recordFinding({
      id: "finding:stall:1",
      category: "stall",
      title: "Recurring stall",
      timestamp: epoch(100),
    });
    tracker.recordFinding({
      id: "finding:stall:1",
      category: "stall",
      title: "Recurring stall",
      timestamp: epoch(140),
    });
    tracker.recordFinding({
      id: "finding:infra:1",
      category: "infra",
      title: "Old infra failure",
      timestamp: epoch(1),
    });
    tracker.recordFinding({
      id: "finding:ship-gap:1",
      category: "ship_gap",
      title: "One-time review gap",
      timestamp: epoch(150),
    });

    const recurring = tracker.getRecurringFindings(60, 2, epoch(150));

    assert.equal(recurring.length, 1);
    assert.equal(recurring[0].id, "finding:stall:1");
    assert.equal(recurring[0].occurrence_count, 2);
  });

  it("records auto-recovery attempts on an existing finding", () => {
    tracker.recordFinding({
      id: "finding:dispatch-gap:2",
      category: "dispatch_gap",
      title: "Dead-zoned seed",
      timestamp: epoch(10),
    });

    tracker.recordAutoRecovery("finding:dispatch-gap:2");
    const record = tracker.recordAutoRecovery("finding:dispatch-gap:2");

    assert.equal(record?.auto_recovered_count, 2);
    assert.equal(record?.occurrence_count, 1);
  });

  it("can initialize the schema repeatedly without dropping data", () => {
    tracker.recordFinding({
      id: "finding:infra:2",
      category: "infra",
      title: "Router unhealthy",
      timestamp: epoch(10),
    });

    assert.equal(tracker.initialize(), true);

    const record = tracker.getFinding("finding:infra:2");
    assert.equal(record?.occurrence_count, 1);
  });

  it("degrades gracefully when the database is unavailable", () => {
    const unavailable = new StateTracker("/dev/null/findings.sqlite", {
      logger: silentLogger,
    });

    assert.equal(unavailable.initialize(), false);
    assert.equal(
      unavailable.recordFinding({
        id: "finding:stall:missing-db",
        category: "stall",
        title: "Missing DB",
      }),
      null,
    );
    assert.deepEqual(unavailable.getRecurringFindings(60, 1), []);
  });
});

function epoch(seconds: number): Date {
  return new Date(seconds * 1_000);
}

const silentLogger = {
  debug() {},
  warn() {},
};
