// Behavioral test for REQ-10's core guarantee: within a single Auriga
// process, concurrent claim() calls on the same task resolve to exactly
// one winner. This is the load-bearing test for the "0 duplicated"
// primary success metric, scoped to what auriga/lock/index.ts actually
// guarantees for P1.
//
// Scope note (see index.ts's class doc, "cross-process race" section):
// a prior version of this test raced TWO SEPARATE MulticaLock instances
// against each other and found that guarantee does not hold — Multica's
// assignee_id cannot distinguish two processes sharing one auth token, so
// cross-process claim safety is 0% effective (20/20 double-claims,
// reproduced 3x). That is a real, accepted limitation, not a bug: P1's
// spine is a single thin consumer (docs/north-star.md, README.md
// "Shape"); multi-worker coordination is explicitly P4
// ("role-tree / squads / workflows"), not P1. Operator-confirmed scope
// decision: this test now covers the guarantee P1 actually needs and
// actually has — same-process concurrency — run against the LIVE Multica
// instance (not a fake), 20 iterations for robustness against any
// wire-level flakiness. Cross-process safety is out of scope until P4.
//
// Auth/workspace read from ~/.multica/config.json at runtime, per this
// repo's established precedent — never hardcoded, never written to disk.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { MulticaLock } from "./index.ts";

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

// ONE MulticaLock instance — the in-scope guarantee is that concurrent
// claim() calls against THIS instance (e.g. two events handled by the same
// P1 consumer process racing to claim the same task) never double-win. The
// #withTaskLock mutex inside index.ts is what's under test here; the live
// Multica calls prove it holds end-to-end, not just in isolation.
let lock: MulticaLock;

const ITERATIONS = 20;
const allCreatedIssueIds = new Set<string>();

before(() => {
  lock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
  });
});

after(async () => {
  for (const id of lock.createdIssueIds) allCreatedIssueIds.add(id);

  console.log(
    `[concurrent-claim.test] cleaning up ${allCreatedIssueIds.size} Multica issue(s) created during this run`,
  );
  for (const id of allCreatedIssueIds) {
    const del = await apiDelete(`/api/issues/${id}`);
    assert.equal(del.status, 204, `expected 204 deleting issue ${id}, got ${del.status}`);
  }

  // Per-id 404 check, not a broad workspace-wide scan — node:test runs
  // sibling test files concurrently against the same shared live
  // workspace, and a broad scan can false-positive on sibling files'
  // in-flight (not-yet-cleaned) data.
  for (const id of allCreatedIssueIds) {
    const check = await apiGet(`/api/issues/${id}`);
    assert.equal(check.status, 404, `expected issue ${id} to be gone (404), got ${check.status}`);
  }
  console.log(
    `[concurrent-claim.test] cleanup verified: all ${allCreatedIssueIds.size} tracked issue(s) confirmed gone`,
  );
});

test("20x: same-instance concurrent claim() calls on the same fresh task -- exactly one wins each time (live Multica)", async () => {
  const winnerCounts: number[] = [];

  for (let i = 0; i < ITERATIONS; i++) {
    const taskId = `lock-behavior-test:concurrent-claim:${i}:${randomUUID()}`;

    const [resA, resB] = await Promise.all([lock.claim(taskId), lock.claim(taskId)]);
    const okCount = [resA, resB].filter((r) => (r as { ok: boolean }).ok === true).length;
    winnerCounts.push(okCount);

    console.log(
      `[concurrent-claim.test] iteration ${i}: A=${JSON.stringify(resA)} B=${JSON.stringify(resB)} (winners=${okCount})`,
    );

    // Release whichever won, so this iteration's issue doesn't linger
    // in_progress for the cleanup pass below (cleanup deletes regardless,
    // but releasing first keeps each iteration self-contained).
    const winner = [resA, resB].find((r) => (r as { ok: boolean }).ok === true) as
      | { ok: true; leaseId: string }
      | undefined;
    if (winner) await lock.release(winner.leaseId);
  }

  console.log(`[concurrent-claim.test] winner-count per iteration: ${JSON.stringify(winnerCounts)}`);

  assert.deepEqual(
    winnerCounts,
    Array(ITERATIONS).fill(1),
    `expected winner-count 1 in all ${ITERATIONS} iterations (same-instance guarantee), got ${JSON.stringify(winnerCounts)}`,
  );
});
