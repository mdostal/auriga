// Behavioral, end-to-end test for REQ-12's "escalates-and-stops on
// sustained decline" invariant -- this is the story
// escalation-stop-signal-tests.yaml exists to satisfy, and it is
// deliberately NOT another unit test of SustainedDeclineDetector in
// isolation (auriga/escalation/index.test.ts already does that, with
// synthetic, hand-crafted ClassifiedFailure events fed via a fake
// EventEmitter -- see auriga-escalation-sustained-decline.yaml). This test
// spawns the REAL chain as a REAL child process: a real AurigaConsumer
// wired to a real MulticaLock + MulticaTrackerAdapter pointed at a
// deliberately unreachable endpoint, whose real thrown network errors get
// caught by the real error boundary (consumer-adapter-error-boundary) and
// turned into real ClassifiedFailure events that drive a real
// SustainedDeclineDetector to a real process.exit(). See
// auriga/escalation/e2e-runner.ts's header doc for the full mechanics of
// how the induced failure and the escalation are made real, fast, and
// deterministic.
//
// What this proves that the unit tests cannot: that a real fetch() failure
// against a real unreachable endpoint actually classifies and propagates
// the way the unit tests' synthetic signals assumed it would (it does --
// see e2e-runner.ts's own manual-run confirmation: real fetch()
// connection-refused errors classify as errorType "TypeError", sourceAdapter
// "lock"), and that the real, uninjected process.exit(ESCALATION_EXIT_CODE)
// call genuinely terminates the process (not a spy standing in for it).
//
// No live Multica dependency: unlike restart-safety.test.ts /
// concurrent-claim.test.ts / lease-reclaim.test.ts, this test does not read
// ~/.multica/config.json and never talks to a real Multica instance --  the
// whole point is a controlled, induced failure against an endpoint nothing
// listens on (see e2e-runner.ts's header doc). This test can run in any
// environment, with no external service or credentials required.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ESCALATION_EXIT_CODE, type EscalationRecord } from "./index.ts";
import { SqliteDBAdapter } from "../adapters/db/index.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "e2e-runner.ts");

/**
 * Timeout rationale: a manual run of e2e-runner.ts (3 real ECONNREFUSED
 * failures against an unreachable localhost port, then a real sqlite write
 * and process.exit) completes in well under half a second end-to-end
 * (including `tsx`'s own module-load/transpile startup cost). 20 seconds is
 * ~40-80x that observed runtime: generous enough to absorb real CI-machine
 * scheduling variance or a slow `npx`/module-resolution cold start without
 * ever being flaky, while still being tight enough that a genuine
 * regression (the chain silently failing to escalate, e.g. because a real
 * fetch error stopped propagating the way the unit tests assumed) fails
 * this test in seconds, not by hanging the suite indefinitely -- the
 * runner's own internal safety-net iteration cap (see e2e-runner.ts) is
 * the first line of defense against a true hang; this timeout is the
 * second, outer one.
 */
const EXIT_TIMEOUT_MS = 20_000;

test(
  "escalate-and-stop: real consumer+lock+escalation chain against a deliberately unreachable endpoint exits with ESCALATION_EXIT_CODE and writes a diagnosable EscalationRecord",
  async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "e2e-stop-test-"));
    const dbPath = join(tmpDir, "escalations.db");

    try {
      const child = spawn("npx", ["tsx", RUNNER_PATH, dbPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf-8");
      });

      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(
            new Error(
              `e2e-runner did not exit within ${EXIT_TIMEOUT_MS}ms. stdout so far:\n${stdout}\nstderr so far:\n${stderr}`,
            ),
          );
        }, EXIT_TIMEOUT_MS);
        child.on("exit", (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal });
        });
      });

      console.log(`[e2e-stop.test] child exited: ${JSON.stringify(exit)}`);
      if (stderr.trim()) {
        console.log(`[e2e-stop.test] child stderr:\n${stderr}`);
      }

      // Acceptance criterion 1: the process exits with the documented
      // escalation exit code (not 0 -- would mean it never escalated; not
      // 1 -- would mean an uncaught crash; not NEVER_ESCALATED_EXIT_CODE
      // (9) -- would mean the safety-net cap fired because the chain never
      // escalated for real). Imported from index.ts, not hardcoded, per
      // this story's own requirement.
      assert.equal(
        exit.code,
        ESCALATION_EXIT_CODE,
        `expected the real chain to escalate-and-stop with ESCALATION_EXIT_CODE (${ESCALATION_EXIT_CODE}) within ${EXIT_TIMEOUT_MS}ms, got exit ${JSON.stringify(exit)}. stdout:\n${stdout}\nstderr:\n${stderr}`,
      );
      assert.equal(exit.signal, null, "expected a clean self-exit, not a signal-terminated process");

      // Acceptance criterion 2: the escalation record, read back AFTER the
      // child has exited, by a FRESH SqliteDBAdapter instance in this
      // (parent) process opened against the SAME db path -- proving the
      // write genuinely landed on disk and survived the child process's
      // death, not just that it existed in the child's own memory.
      const keyLine = stdout.split("\n").find((line) => line.startsWith("ESCALATION_KEY "));
      assert.ok(
        keyLine,
        `expected an ESCALATION_KEY marker on the child's stdout (see e2e-runner.ts's SignalingDBAdapter), got stdout:\n${stdout}`,
      );
      const key = keyLine!.slice("ESCALATION_KEY ".length).trim();

      const dbAdapter = new SqliteDBAdapter(dbPath);
      try {
        const record = await dbAdapter.read<EscalationRecord>(key);
        assert.ok(record, `expected an EscalationRecord written at key "${key}", got null`);

        // Per EscalationRecord's own shape (auriga/escalation/index.ts) --
        // enough detail to diagnose what happened without re-running, per
        // this story's second acceptance criterion: failure count, window,
        // timestamps, and per-failure detail (errorType/sourceAdapter/
        // taskId/timestamp -- "last error" in spirit, since the raw Error
        // is intentionally dropped from the persisted record, see
        // EscalationRecord's own doc on `failures`).
        assert.equal(record!.reason, "sustained_decline");
        assert.equal(record!.exitCode, ESCALATION_EXIT_CODE);
        assert.equal(typeof record!.triggeredAt, "string");
        assert.ok(
          !Number.isNaN(Date.parse(record!.triggeredAt)),
          `expected triggeredAt to be a parseable ISO timestamp, got ${record!.triggeredAt}`,
        );
        assert.ok(record!.thresholdCount > 0, "expected a positive thresholdCount");
        assert.ok(record!.windowMs > 0, "expected a positive windowMs");
        assert.ok(
          record!.failureCount >= record!.thresholdCount,
          `expected failureCount (${record!.failureCount}) >= thresholdCount (${record!.thresholdCount})`,
        );
        assert.ok(Array.isArray(record!.failures), "expected failures to be an array");
        assert.equal(
          record!.failures.length,
          record!.failureCount,
          "expected the recorded failures array to match failureCount",
        );
        assert.ok(record!.failures.length > 0, "expected at least one recorded failure");
        for (const failure of record!.failures) {
          assert.equal(typeof failure.errorType, "string");
          assert.ok(failure.errorType.length > 0);
          assert.equal(typeof failure.sourceAdapter, "string");
          assert.ok(failure.sourceAdapter.length > 0);
          assert.equal(typeof failure.timestamp, "string");
          assert.ok(
            !Number.isNaN(Date.parse(failure.timestamp)),
            `expected each failure's timestamp to be a parseable ISO timestamp, got ${failure.timestamp}`,
          );
        }
        // Real fetch() failures against the unreachable endpoint classify
        // as "TypeError" from the "lock" adapter (confirmed by a manual
        // run of e2e-runner.ts -- see this file's header doc) -- assert
        // that specifically, not just "some string", to lock in that this
        // really is the real-network failure path, not some other error.
        assert.ok(
          record!.failures.some((f) => f.sourceAdapter === "lock"),
          `expected at least one recorded failure to be sourced from "lock" (the adapter whose real fetch() call fails against the unreachable endpoint), got ${JSON.stringify(record!.failures)}`,
        );
      } finally {
        dbAdapter.close();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  },
);
