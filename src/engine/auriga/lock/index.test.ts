// Runs the generic LockContract harness (contracts/test-harness/lock.ts)
// against the REAL MulticaLock implementation, talking to the LIVE Multica
// instance at http://localhost:8090 (workspace "Pantheon"). Not a fake —
// every claim()/renew()/release()/sweep() call in this run is a real HTTP
// round-trip.
//
// Auth/workspace are read from ~/.multica/config.json at runtime, per the
// findings doc's own precedent — never hardcoded, never written to disk by
// this file. The token is held only in memory.
//
// The harness's uniqueTaskId() helper hands claim() arbitrary opaque
// strings, not real Multica issue ids — MulticaLock handles this itself by
// auto-provisioning one throwaway issue per never-before-seen taskId (see
// the class's JSDoc in ./index.ts, "taskId -> Multica issue mapping"). This
// file tracks every issue MulticaLock creates (via its `createdIssueIds`
// getter) and deletes all of them in an after() hook, then asserts none of
// our "lock-impl-dev:"-prefixed issues remain in the workspace.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runLockContractTests } from "../../contracts/test-harness/lock.ts";
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

let lock: MulticaLock;

before(() => {
  // Short staleMs so sweep() reclaims quickly once expireLeaseForTesting()
  // rewinds a lease's claimedAt — we never wait on the real 5-minute
  // production default in this test.
  lock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
    staleMs: 1_000,
  });
});

after(async () => {
  const createdIds = lock.createdIssueIds;
  console.log(`[lock.index.test] cleaning up ${createdIds.length} Multica issue(s) created during this run`);
  for (const id of createdIds) {
    const del = await apiDelete(`/api/issues/${id}`);
    assert.equal(del.status, 204, `expected 204 deleting issue ${id}, got ${del.status}`);
  }

  // Confirm each of OUR OWN tracked issues is actually gone, by id --
  // NOT via a broad workspace-wide title-prefix scan. node:test runs
  // sibling test FILES concurrently by default, and every MulticaLock
  // instance (regardless of which test file owns it) creates issues
  // titled "lock-impl-dev: <taskId>" -- so a workspace-wide "does any
  // 'lock-impl-dev:'-prefixed issue remain" scan can false-positive on
  // another concurrently-running file's (e.g. concurrent-claim.test.ts's
  // or lease-reclaim.test.ts's) in-flight, not-yet-cleaned-up issues. A
  // per-id 404 check is precise and immune to that cross-file race.
  for (const id of createdIds) {
    const check = await apiGet(`/api/issues/${id}`);
    assert.equal(check.status, 404, `expected issue ${id} to be gone (404), got ${check.status}`);
  }
  console.log(`[lock.index.test] cleanup verified: all ${createdIds.length} tracked issue(s) confirmed gone`);
});

test("MulticaLock (real, live Multica) satisfies the generic LockContract harness", async () => {
  await runLockContractTests(lock, {
    expireLease: (leaseId) => lock.expireLeaseForTesting(leaseId),
  });
});
