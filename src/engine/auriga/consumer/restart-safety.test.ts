// Behavioral test for REQ-09's restart-safety guarantee: "given the
// consumer process restarts, when it comes back up, then it resumes
// without re-executing already-claimed or already-completed work." This is
// one of the two behavioral guarantees the whole P1 soak test rests on
// (see .pHive/epics/contracts-and-spine/stories/consumer-restart-safety-tests.yaml's
// risk notes) -- so per that story, this is proven with a REAL process
// spawn/kill/respawn, not asserted from reading the code.
//
// Why this is expected -- and confirmed here -- to already hold, by design:
// AurigaConsumer (auriga/consumer/index.ts) holds no in-memory state across
// calls beyond its two constructor-injected dependencies (#lock,
// #trackerAdapter -- both just references, not mutable state). It never
// tracks "which tasks am I currently working on" itself; onEvent() derives
// everything it needs from the incoming event and delegates ALL claim
// persistence to `lock.claim()`, which (via MulticaLock) is backed by live
// Multica issue state, not local process memory. So killing the consumer
// process and starting a fresh one loses nothing that mattered: the fresh
// process's lock.claim() call re-reads the SAME Multica issue and sees it's
// still marked in_progress/assigned, and correctly refuses to double-claim
// -- with no code change needed to make that true. This test exists to
// PROVE that empirically (three real, separate child processes, real
// SIGKILL, real live Multica), not just to restate it.
//
// Scenario (mirrors the story's 3 acceptance criteria exactly):
//   1. Process A claims task-1, is confirmed claimed (via the "CLAIMED"
//      stdout marker -- see restart-safety-runner.ts's header doc), then is
//      SIGKILLed while still "mid-dispatch" (hung, by design, right after
//      the claim landed and before any further work).
//   2. Process B (a fresh process = "the restarted consumer"), pointed at
//      the SAME task-1, must get {ok:false, reason:"already_claimed"} --
//      not a duplicate claim. The lease is still live in Multica (nothing
//      here waits for lease expiry/sweep -- that guarantee is
//      lease-reclaim.test.ts's job, not this test's).
//   3. Process C, pointed at a DIFFERENT, fresh task-2, must claim
//      successfully -- proving the "restarted" consumer isn't wedged, just
//      correctly refusing to double-claim the one specific in-flight task.
//
// Auth/workspace read from ~/.multica/config.json at runtime, per this
// repo's established precedent (see concurrent-claim.test.ts /
// lease-reclaim.test.ts) -- never hardcoded, never written to disk. This
// file only uses that config for its own direct-API cleanup calls; each
// spawned child process reads the same file itself (see
// restart-safety-runner.ts), independently, exactly as a real restarted
// process would.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

interface MulticaConfig {
  server_url: string;
  workspace_id: string;
  token: string;
}

function loadConfig(): MulticaConfig {
  const raw = readFileSync(join(homedir(), ".multica", "config.json"), "utf-8");
  const cfg = JSON.parse(raw) as Partial<MulticaConfig>;
  if (!cfg.server_url || !cfg.workspace_id || !cfg.token) {
    throw new Error("~/.multica/config.json missing server_url/workspace_id/token");
  }
  return cfg as MulticaConfig;
}

const cfg = loadConfig();

function authHeaders(extra: Record<string, string> = {}) {
  return { Authorization: `Bearer ${cfg.token}`, ...extra };
}

async function apiGet(path: string) {
  const url = `${cfg.server_url}${path}${path.includes("?") ? "&" : "?"}workspace_id=${cfg.workspace_id}`;
  const res = await fetch(url, { headers: authHeaders() });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function apiDelete(path: string) {
  const url = `${cfg.server_url}${path}${path.includes("?") ? "&" : "?"}workspace_id=${cfg.workspace_id}`;
  const res = await fetch(url, { method: "DELETE", headers: authHeaders() });
  return { status: res.status };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNNER_PATH = join(__dirname, "restart-safety-runner.ts");

interface RunnerHandle {
  child: ChildProcessByStdio<null, Readable, Readable>;
  /** Resolves with the parsed CLAIMED marker payload the instant it appears on stdout. */
  claimed: Promise<{ result: { ok: boolean; reason?: string; leaseId?: string }; issueIds: string[] }>;
  /** All stdout collected so far (for debugging/assertions on later lines). */
  stdoutLines: string[];
  /** Resolves once the child process actually exits, with its exit code/signal. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

/**
 * Spawns restart-safety-runner.ts as a REAL child process (`npx tsx`, the
 * same invocation this repo's own `npm test` script uses for *.test.ts --
 * see package.json). Wires up stdout line parsing so callers can await the
 * "CLAIMED" marker (the signal that lock.claim() has actually landed in
 * Multica, per the runner's own header doc) independently of the process's
 * eventual exit.
 */
function spawnRunner(taskId: string, opts: { hang?: boolean } = {}): RunnerHandle {
  const child = spawn("npx", ["tsx", RUNNER_PATH, taskId], {
    env: {
      ...process.env,
      ...(opts.hang ? { RESTART_SAFETY_HANG: "1" } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const stdoutLines: string[] = [];
  let claimedResolve!: (v: { result: { ok: boolean; reason?: string; leaseId?: string }; issueIds: string[] }) => void;
  let claimedReject!: (e: Error) => void;
  const claimed = new Promise<{ result: { ok: boolean; reason?: string; leaseId?: string }; issueIds: string[] }>(
    (res, rej) => {
      claimedResolve = res;
      claimedReject = rej;
    },
  );

  let buf = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.length === 0) continue;
      stdoutLines.push(line);
      if (line.startsWith("CLAIMED ")) {
        try {
          claimedResolve(JSON.parse(line.slice("CLAIMED ".length)));
        } catch (e) {
          claimedReject(e as Error);
        }
      }
    }
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf-8");
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      if (stderrBuf.trim()) {
        console.log(`[restart-safety.test] child ${child.pid} stderr:\n${stderrBuf}`);
      }
      resolve({ code, signal });
    });
  });

  // Give up waiting on the CLAIMED marker if the process dies/exits first
  // without ever printing it (e.g. a startup crash) -- surfaces a clear
  // error instead of hanging the test forever.
  exited.then((result) => {
    if (result.code !== 0 && result.signal === null) {
      claimedReject(
        new Error(
          `runner exited with code ${result.code} before printing CLAIMED. stdout so far: ${stdoutLines.join(" | ")}`,
        ),
      );
    }
  });

  return { child, claimed, stdoutLines, exited };
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms waiting for: ${label}`)), ms)),
  ]);
}

const allIssueIds = new Set<string>();

after(async () => {
  console.log(`[restart-safety.test] cleaning up ${allIssueIds.size} Multica issue(s) created during this run`);
  for (const id of allIssueIds) {
    const del = await apiDelete(`/api/issues/${id}`);
    assert.ok(
      del.status === 204 || del.status === 404,
      `expected 204 (or already-gone 404) deleting issue ${id}, got ${del.status}`,
    );
  }
  for (const id of allIssueIds) {
    const check = await apiGet(`/api/issues/${id}`);
    assert.equal(check.status, 404, `expected issue ${id} to be gone (404), got ${check.status}`);
  }
  console.log(`[restart-safety.test] cleanup verified: all ${allIssueIds.size} tracked issue(s) confirmed gone`);
});

test(
  "restart safety: SIGKILLed mid-dispatch consumer's claim survives; a respawned process refuses to double-claim the same task but claims a fresh one normally (live Multica, real process spawn/kill/respawn)",
  async () => {
    const taskId1 = `restart-safety-test:task:${randomUUID()}`;
    const taskId3 = `restart-safety-test:task:${randomUUID()}`;

    // --- Process A: claims task-1, then hangs (simulating "mid-dispatch") ---
    const procA = spawnRunner(taskId1, { hang: true });
    const claimedA = await withTimeout(procA.claimed, 15_000, "process A's CLAIMED marker");
    console.log(`[restart-safety.test] process A claimed: ${JSON.stringify(claimedA)}`);
    assert.equal(claimedA.result.ok, true, `expected process A to win the claim on a fresh task, got ${JSON.stringify(claimedA.result)}`);
    for (const id of claimedA.issueIds) allIssueIds.add(id);

    // --- Kill process A (SIGKILL, simulating a crash) and confirm it's actually dead ---
    procA.child.kill("SIGKILL");
    const exitA = await withTimeout(procA.exited, 10_000, "process A's exit after SIGKILL");
    console.log(`[restart-safety.test] process A exited: ${JSON.stringify(exitA)}`);
    assert.equal(exitA.signal, "SIGKILL", `expected process A to have been terminated by SIGKILL, got ${JSON.stringify(exitA)}`);

    // --- Process B: "the restarted consumer" -- same task-1, must NOT double-claim ---
    const procB = spawnRunner(taskId1, {});
    const claimedB = await withTimeout(procB.claimed, 15_000, "process B's CLAIMED marker");
    console.log(`[restart-safety.test] process B claimed: ${JSON.stringify(claimedB)}`);
    for (const id of claimedB.issueIds) allIssueIds.add(id);
    const exitB = await withTimeout(procB.exited, 10_000, "process B's exit");
    console.log(`[restart-safety.test] process B exited: ${JSON.stringify(exitB)}`);

    assert.deepEqual(
      claimedB.result,
      { ok: false, reason: "already_claimed" },
      `expected the respawned process to be refused the still-live lease on task-1 (not re-claim it), got ${JSON.stringify(claimedB.result)}`,
    );
    assert.equal(exitB.code, 0, "process B should exit cleanly (0) -- it correctly declines a taken task, it does not crash");

    // --- Process C: the "restarted consumer" is not wedged -- a fresh task claims normally ---
    const procC = spawnRunner(taskId3, {});
    const claimedC = await withTimeout(procC.claimed, 15_000, "process C's CLAIMED marker");
    console.log(`[restart-safety.test] process C claimed: ${JSON.stringify(claimedC)}`);
    for (const id of claimedC.issueIds) allIssueIds.add(id);
    const exitC = await withTimeout(procC.exited, 10_000, "process C's exit");
    console.log(`[restart-safety.test] process C exited: ${JSON.stringify(exitC)}`);

    assert.equal(claimedC.result.ok, true, `expected process C to claim its own fresh task normally, got ${JSON.stringify(claimedC.result)}`);
    assert.equal(exitC.code, 0, "process C should exit cleanly (0)");
  },
);
