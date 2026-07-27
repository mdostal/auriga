import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClassifiedFailure } from "../consumer/index.ts";
import { SqliteDBAdapter } from "../adapters/db/index.ts";
import {
  ESCALATION_EXIT_CODE,
  SustainedDeclineDetector,
  type EscalationRecord,
} from "./index.ts";

/** A fixed base instant so synthetic failure timestamps are deterministic
 * and don't depend on wall-clock time when the test runs. */
const BASE_MS = Date.parse("2026-01-01T00:00:00.000Z");

/** Builds a synthetic ClassifiedFailure at `offsetMs` after BASE_MS. */
function makeFailure(offsetMs: number, index: number): ClassifiedFailure {
  return {
    errorType: "Error",
    sourceAdapter: "lock",
    taskId: `task-${index}`,
    timestamp: new Date(BASE_MS + offsetMs).toISOString(),
    error: new Error(`synthetic failure #${index}`),
  };
}

/** A spy for the injectable `stop` function — records calls instead of
 * actually killing the test process (see index.ts's
 * SustainedDeclineDetectorOptions.stop doc for why this must be
 * injectable). */
function makeStopSpy(): { calls: number[]; stop: (exitCode: number) => void } {
  const calls: number[] = [];
  return {
    calls,
    stop: (exitCode: number) => {
      calls.push(exitCode);
    },
  };
}

/** Fresh, isolated on-disk sqlite path per test so tests can't interfere
 * with each other or leave a shared db file behind. Caller is responsible
 * for closing the returned adapter and removing the directory. */
function makeTempDbAdapter(): { adapter: SqliteDBAdapter; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "escalation-test-"));
  const adapter = new SqliteDBAdapter(join(dir, "escalations.db"));
  return { adapter, dir };
}

// --- 1. Exactly N consecutive failures within the window: escalates ----

test("escalates and stops when exactly N (5) failures land within the window (60s)", async () => {
  const source = new EventEmitter();
  const { calls, stop } = makeStopSpy();
  const { adapter, dir } = makeTempDbAdapter();

  try {
    const detector = new SustainedDeclineDetector(source, { stop, dbAdapter: adapter });

    const escalatedPromise = once(detector, "escalated");

    // 5 failures, 10s apart — well within the 60s window (span 40s).
    for (let i = 0; i < 5; i++) {
      source.emit("failure", makeFailure(i * 10_000, i));
    }

    await escalatedPromise;

    // Stop was called exactly once, with the distinct escalation exit code.
    assert.equal(calls.length, 1);
    assert.equal(calls[0], ESCALATION_EXIT_CODE);
    assert.equal(ESCALATION_EXIT_CODE, 3);
    assert.notEqual(ESCALATION_EXIT_CODE, 0);
    assert.notEqual(ESCALATION_EXIT_CODE, 1);

    assert.equal(detector.escalated, true);
    assert.ok(detector.lastEscalationKey);

    // Read the written escalation record back and check its shape.
    const record = await adapter.read<EscalationRecord>(detector.lastEscalationKey!);
    assert.ok(record);
    assert.equal(record!.reason, "sustained_decline");
    assert.equal(record!.exitCode, ESCALATION_EXIT_CODE);
    assert.equal(record!.thresholdCount, 5);
    assert.equal(record!.windowMs, 60_000);
    assert.equal(record!.failureCount, 5);
    assert.equal(typeof record!.triggeredAt, "string");
    assert.equal(Number.isNaN(Date.parse(record!.triggeredAt)), false);
    assert.equal(record!.failures.length, 5);
    record!.failures.forEach((f, i) => {
      assert.equal(f.errorType, "Error");
      assert.equal(f.sourceAdapter, "lock");
      assert.equal(f.taskId, `task-${i}`);
      assert.equal(typeof f.timestamp, "string");
    });
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 2. Fewer than N failures within the window: does not escalate -----

test("does not escalate when only N-1 (4) failures land within the window", async () => {
  const source = new EventEmitter();
  const { calls, stop } = makeStopSpy();
  const { adapter, dir } = makeTempDbAdapter();

  try {
    const detector = new SustainedDeclineDetector(source, { stop, dbAdapter: adapter });

    // 4 failures, well within the 60s window.
    for (let i = 0; i < 4; i++) {
      source.emit("failure", makeFailure(i * 10_000, i));
    }

    // Let any pending microtasks (e.g. an errant async escalate call)
    // settle before asserting nothing happened.
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 0);
    assert.equal(detector.escalated, false);
    assert.equal(detector.lastEscalationKey, undefined);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 3. Failures spread across longer than the window: does not escalate

test("does not escalate when N failures are spread across a period longer than the window", async () => {
  const source = new EventEmitter();
  const { calls, stop } = makeStopSpy();
  const { adapter, dir } = makeTempDbAdapter();

  try {
    const detector = new SustainedDeclineDetector(source, { stop, dbAdapter: adapter });

    // 5 failures (== thresholdCount) but spread across 70s, longer than
    // the 60s window. Sliding-window semantics (see index.ts's class doc,
    // "Windowing semantics"): each failure prunes the buffer to entries
    // within windowMs of *that* failure's own timestamp. Offsets chosen
    // (0, 15s, 30s, 45s, 70s) so that at the 5th failure (t=70s), the
    // window [10s, 70s] excludes the t=0 failure, leaving only 4 in the
    // buffer — one short of the threshold — even though 5 failures did
    // occur in total across the observed period.
    const offsets = [0, 15_000, 30_000, 45_000, 70_000];
    offsets.forEach((offset, i) => {
      source.emit("failure", makeFailure(offset, i));
    });

    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 0);
    assert.equal(detector.escalated, false);
    assert.equal(detector.lastEscalationKey, undefined);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Custom thresholds/window are honored (not hardcoded) --------------

test("honors custom thresholdCount/windowMs options instead of the defaults", async () => {
  const source = new EventEmitter();
  const { calls, stop } = makeStopSpy();
  const { adapter, dir } = makeTempDbAdapter();

  try {
    const detector = new SustainedDeclineDetector(source, {
      stop,
      dbAdapter: adapter,
      thresholdCount: 2,
      windowMs: 5_000,
    });

    const escalatedPromise = once(detector, "escalated");

    source.emit("failure", makeFailure(0, 0));
    source.emit("failure", makeFailure(1_000, 1));

    await escalatedPromise;

    assert.equal(calls.length, 1);
    assert.equal(calls[0], ESCALATION_EXIT_CODE);

    const record = await adapter.read<EscalationRecord>(detector.lastEscalationKey!);
    assert.equal(record!.reason, "sustained_decline");
    assert.equal(record!.thresholdCount, 2);
    assert.equal(record!.windowMs, 5_000);
    assert.equal(record!.failureCount, 2);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Once escalated, further failures don't trigger a second escalation

test("does not escalate a second time (or call stop again) after already escalating", async () => {
  const source = new EventEmitter();
  const { calls, stop } = makeStopSpy();
  const { adapter, dir } = makeTempDbAdapter();

  try {
    const detector = new SustainedDeclineDetector(source, { stop, dbAdapter: adapter });

    const escalatedPromise = once(detector, "escalated");
    for (let i = 0; i < 5; i++) {
      source.emit("failure", makeFailure(i * 10_000, i));
    }
    await escalatedPromise;

    assert.equal(calls.length, 1);
    const firstKey = detector.lastEscalationKey;

    // More failures arrive after escalation (e.g. supervisor hasn't
    // actually killed the process yet in this fake-stop test scenario).
    for (let i = 5; i < 10; i++) {
      source.emit("failure", makeFailure(i * 10_000, i));
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(calls.length, 1, "stop must not be called a second time");
    assert.equal(detector.lastEscalationKey, firstKey);
  } finally {
    adapter.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
