// Standalone runner spawned as a REAL child process by
// restart-safety.test.ts (never imported/run directly by node:test itself
// -- it is deliberately not a *.test.ts file). Simulates one "consumer
// process" in the restart-safety scenario: loads live Multica config
// (same ~/.multica/config.json pattern as auriga/lock/concurrent-claim.test.ts
// -- never hardcoded), constructs a REAL MulticaLock + MulticaTrackerAdapter
// + AurigaConsumer, and calls onEvent() exactly once for a single fixed
// task id passed as argv[2].
//
// Signal protocol (read by the parent test via this process's stdout):
//   CLAIMED <json>   -- printed the instant lock.claim() resolves, before
//                        onEvent() does anything else (dispatch). Payload:
//                        { result: ClaimResult, issueIds: string[] }.
//                        issueIds is MulticaLock's own createdIssueIds
//                        snapshot at that instant, given here so the parent
//                        test can clean up the right Multica issue even for
//                        a run that gets SIGKILLed before ever reaching this
//                        script's own post-onEvent() cleanup-reporting code.
//   FAILURE <json>   -- printed if AurigaConsumer emits a "failure" event
//                        (e.g. the tracker-adapter dispatch call 404s
//                        because this taskId isn't itself a Multica issue
//                        id -- expected/harmless here, caught by the
//                        consumer's own error boundary; see index.ts's
//                        class doc). Non-fatal, logged for visibility only.
//   DONE             -- printed just before a clean exit(0), i.e. onEvent()
//                        returned and this process was NOT told to hang.
//
// Hang mode: if env RESTART_SAFETY_HANG=1, the injected lock wrapper hangs
// forever (an unresolved promise) immediately after printing CLAIMED and
// BEFORE returning control back to AurigaConsumer.onEvent() -- so onEvent()
// never reaches the tracker-adapter dispatch call, and this process never
// exits on its own. This is what lets the parent test SIGKILL it at a
// deterministic point strictly after the claim has landed in Multica,
// reproducing "claimed and mid-dispatch when the process is killed" (this
// story's first acceptance criterion) rather than a race against this
// process's own natural exit.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MulticaLock } from "../lock/index.ts";
import { MulticaTrackerAdapter } from "../adapters/multica/index.ts";
import { AurigaConsumer, type ClassifiedFailure } from "./index.ts";
import type { ClaimResult, LockContract } from "../../contracts/lock.ts";
import type { EventContract } from "../../contracts/event.ts";

interface MulticaFileConfig {
  server_url: string;
  workspace_id: string;
  token: string;
}

function loadConfig(): MulticaFileConfig {
  const raw = readFileSync(join(homedir(), ".multica", "config.json"), "utf-8");
  const cfg = JSON.parse(raw) as Partial<MulticaFileConfig>;
  if (!cfg.server_url || !cfg.workspace_id || !cfg.token) {
    throw new Error("~/.multica/config.json missing server_url/workspace_id/token");
  }
  return cfg as MulticaFileConfig;
}

/**
 * Thin signaling decorator around a REAL MulticaLock -- delegates every
 * call straight through unchanged, and additionally prints the "CLAIMED"
 * marker line documented above the instant claim() resolves. See this
 * file's header doc for why the marker (and the optional hang) live here
 * rather than inside AurigaConsumer or MulticaLock themselves: this is
 * test-harness plumbing specific to this runner, not a behavior either of
 * those classes should know about.
 */
class SignalingLock implements LockContract {
  constructor(private readonly real: MulticaLock) {}

  async claim(taskId: string): Promise<ClaimResult> {
    const result = await this.real.claim(taskId);
    console.log(`CLAIMED ${JSON.stringify({ result, issueIds: this.real.createdIssueIds })}`);
    if (process.env.RESTART_SAFETY_HANG === "1") {
      await new Promise<never>(() => {}); // never resolves -- see header doc
    }
    return result;
  }
  async renew(leaseId: string): Promise<boolean> {
    return this.real.renew(leaseId);
  }
  async release(leaseId: string): Promise<void> {
    return this.real.release(leaseId);
  }
  async sweep(): Promise<string[]> {
    return this.real.sweep();
  }
}

async function main(): Promise<void> {
  const taskId = process.argv[2];
  if (!taskId) {
    console.error("usage: restart-safety-runner.ts <taskId>");
    process.exit(2);
  }

  const cfg = loadConfig();
  const realLock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
  });
  const trackerAdapter = new MulticaTrackerAdapter({
    server_url: cfg.server_url,
    workspace_id: cfg.workspace_id,
    token: cfg.token,
  });
  const consumer = new AurigaConsumer(new SignalingLock(realLock), trackerAdapter);

  consumer.on("failure", (failure: ClassifiedFailure) => {
    console.log(
      `FAILURE ${JSON.stringify({ errorType: failure.errorType, sourceAdapter: failure.sourceAdapter })}`,
    );
  });

  const event: EventContract = {
    id: `restart-safety-runner:${taskId}`,
    type: "task.claimable",
    payload: { taskId },
    timestamp: new Date().toISOString(),
    source: "restart-safety-runner",
  };

  await consumer.onEvent(event);

  console.log("DONE");
  process.exit(0);
}

main().catch((error) => {
  console.error("restart-safety-runner: unexpected top-level failure:", error);
  process.exit(1);
});
