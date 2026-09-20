import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  HeartbeatWriter,
  detectPreviousDeath,
  DeathEventStore,
  DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN,
  type HeartbeatFileContents,
} from "./death-detection.ts";

function scratchHeartbeatPath(): string {
  return join(tmpdir(), `auriga-death-detection-heartbeat-${randomUUID()}.json`);
}

function scratchDbPath(): string {
  return join(tmpdir(), `auriga-death-detection-events-${randomUUID()}.sqlite`);
}

test("genuine death: heartbeat file with no clean-shutdown marker -> death detected with correct attribution", () => {
  const heartbeatPath = scratchHeartbeatPath();
  try {
    // Simulate: the process was writing heartbeats, then a SIGKILL/OOM
    // ended it with no chance to mark clean shutdown. The last thing on
    // disk is an ordinary tick -- no `cleanShutdownAt`.
    const lastHeartbeatAt = new Date().toISOString();
    const contents: HeartbeatFileContents = {
      pid: 4242,
      runId: "run-that-died",
      updatedAt: lastHeartbeatAt,
    };
    writeFileSync(heartbeatPath, JSON.stringify(contents));

    const result = detectPreviousDeath(heartbeatPath);

    assert.equal(result.death, true);
    assert.ok(result.death);
    assert.equal(result.event.cause, DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN);
    assert.equal(result.event.heartbeatTimestamp, lastHeartbeatAt);
    assert.equal(result.event.pid, 4242);
    assert.equal(result.event.runId, "run-that-died");
    // detectedAt is "now" (whenever detection ran), not the heartbeat's own
    // timestamp -- but it should be close in this synchronous test.
    assert.ok(
      Math.abs(Date.parse(result.event.detectedAt) - Date.parse(lastHeartbeatAt)) < 5_000,
      "detectedAt should be close to the heartbeat's own timestamp in this test",
    );
  } finally {
    rmSync(heartbeatPath, { force: true });
  }
});

test("clean escalate-and-stop exit: markCleanShutdown() writes a marker -> NOT detected as a death", () => {
  const heartbeatPath = scratchHeartbeatPath();
  try {
    const writer = new HeartbeatWriter({ heartbeatPath, intervalMs: 10 });
    writer.start();
    // Simulate the clean escalate-and-stop path (SustainedDeclineDetector's
    // #escalate(), see auriga/escalation/index.ts) marking a clean exit
    // before the process actually stops.
    writer.markCleanShutdown();

    const result = detectPreviousDeath(heartbeatPath);

    assert.equal(result.death, false);
    assert.ok(!result.death);
    assert.equal(result.reason, "clean_shutdown");
    assert.ok("cleanShutdownAt" in result);

    // The marker and the file's own updatedAt must agree, per this
    // module's documented "matching its last heartbeat" contract.
    const onDisk = JSON.parse(readFileSync(heartbeatPath, "utf8")) as HeartbeatFileContents;
    assert.equal(onDisk.cleanShutdownAt, onDisk.updatedAt);
  } finally {
    rmSync(heartbeatPath, { force: true });
  }
});

test("first-ever run: no heartbeat file present -> no prior death (not an error, not a false positive)", () => {
  const heartbeatPath = scratchHeartbeatPath(); // never written
  const result = detectPreviousDeath(heartbeatPath);

  assert.equal(result.death, false);
  assert.ok(!result.death);
  assert.equal(result.reason, "no_prior_heartbeat");
});

test("HeartbeatWriter: periodic writes update the file's timestamp over several ticks, and stop() prevents further writes", async () => {
  const heartbeatPath = scratchHeartbeatPath();
  try {
    const writer = new HeartbeatWriter({ heartbeatPath, intervalMs: 10 });
    writer.start();

    // First tick happens synchronously inside start().
    const first = JSON.parse(readFileSync(heartbeatPath, "utf8")) as HeartbeatFileContents;

    // Wait long enough for several 10ms ticks to have fired.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const second = JSON.parse(readFileSync(heartbeatPath, "utf8")) as HeartbeatFileContents;

    assert.notEqual(second.updatedAt, first.updatedAt, "timestamp should have advanced across ticks");
    assert.equal(second.runId, first.runId, "runId must stay stable across ticks within one process run");

    writer.stop();
    const afterStop = JSON.parse(readFileSync(heartbeatPath, "utf8")) as HeartbeatFileContents;

    // Wait again -- if the timer weren't really cleared, a further write
    // would land in this window.
    await new Promise((resolve) => setTimeout(resolve, 80));
    const afterWaiting = JSON.parse(readFileSync(heartbeatPath, "utf8")) as HeartbeatFileContents;

    assert.equal(afterWaiting.updatedAt, afterStop.updatedAt, "no further writes should happen after stop()");
  } finally {
    rmSync(heartbeatPath, { force: true });
  }
});

test("persistence: a recorded death event survives closing and reopening a fresh DeathEventStore against the same file", () => {
  const heartbeatPath = scratchHeartbeatPath();
  const dbPath = scratchDbPath();
  try {
    const lastHeartbeatAt = new Date().toISOString();
    const contents: HeartbeatFileContents = {
      pid: 9999,
      runId: "run-persisted",
      updatedAt: lastHeartbeatAt,
    };
    writeFileSync(heartbeatPath, JSON.stringify(contents));

    const result = detectPreviousDeath(heartbeatPath);
    assert.equal(result.death, true);
    assert.ok(result.death);

    // "Process 1": record the detected death, close.
    const writer = new DeathEventStore(dbPath);
    writer.recordDeath(result.event);
    writer.close();

    // "Process 2": brand new store instance pointed at the same file.
    const reader = new DeathEventStore(dbPath);
    const events = reader.getDeathEvents();
    reader.close();

    assert.equal(events.length, 1);
    assert.deepEqual(events[0], {
      heartbeatTimestamp: lastHeartbeatAt,
      cause: DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN,
      detectedAt: result.event.detectedAt,
      pid: 9999,
      runId: "run-persisted",
    });
  } finally {
    rmSync(heartbeatPath, { force: true });
    rmSync(dbPath, { force: true });
  }
});
