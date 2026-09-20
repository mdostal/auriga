// Behavioral test for REQ-03's sweeper guarantee: a claimed-but-unrenewed
// lease is reclaimed by sweep() exactly once, and the reclaimed task is
// genuinely claimable again afterward -- not just marked-reclaimed
// client-side while Multica still shows it assigned.
//
// Run against the LIVE Multica instance at http://localhost:8090,
// workspace "Pantheon". Auth/workspace read from ~/.multica/config.json at
// runtime -- never hardcoded, never written to disk by this file.
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

const allCreatedIssueIds = new Set<string>();

after(async () => {
  console.log(
    `[lease-reclaim.test] cleaning up ${allCreatedIssueIds.size} Multica issue(s) created during this run`,
  );
  for (const id of allCreatedIssueIds) {
    const del = await apiDelete(`/api/issues/${id}`);
    assert.equal(del.status, 204, `expected 204 deleting issue ${id}, got ${del.status}`);
  }

  // Verify each of OUR OWN tracked issues is actually gone, by id -- NOT
  // via a broad workspace-wide title-substring scan, which is racy
  // against sibling test FILES node:test runs concurrently against the
  // same shared live workspace (see concurrent-claim.test.ts's identical
  // note). A per-id 404 check is precise and immune to that cross-file
  // race.
  for (const id of allCreatedIssueIds) {
    const check = await apiGet(`/api/issues/${id}`);
    assert.equal(check.status, 404, `expected issue ${id} to be gone (404), got ${check.status}`);
  }
  console.log(
    `[lease-reclaim.test] cleanup verified: all ${allCreatedIssueIds.size} tracked issue(s) confirmed gone`,
  );
});

test("(a)+(b): expired, unrenewed lease is reclaimed exactly once by sweep(), and the task is genuinely re-claimable afterward", async () => {
  // Small staleMs so we can just wait past the threshold with a real
  // wall-clock delay rather than needing the expireLeaseForTesting() hook
  // -- either is fine per this story, wall-clock wait is simplest/most
  // faithful to a real "no renew() call happened" scenario.
  const lock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
    staleMs: 100,
  });

  const taskId = `lock-behavior-test:lease-reclaim:${randomUUID()}`;
  const claimResult = await lock.claim(taskId);
  for (const id of lock.createdIssueIds) allCreatedIssueIds.add(id);

  assert.equal(claimResult.ok, true, `expected initial claim to succeed, got ${JSON.stringify(claimResult)}`);
  assert.ok((claimResult as { ok: true; leaseId: string }).leaseId, "expected a leaseId on success");

  // Do NOT renew. Wait past staleMs so the lease is genuinely stale by
  // wall-clock time (not just forced via the test-only hook).
  await new Promise((resolve) => setTimeout(resolve, 250));

  const reclaimed = await lock.sweep();
  console.log(`[lease-reclaim.test] sweep() reclaimed: ${JSON.stringify(reclaimed)}`);

  const occurrences = reclaimed.filter((id) => id === taskId).length;
  assert.equal(
    occurrences,
    1,
    `expected taskId to appear in reclaimed[] exactly once, got ${occurrences} occurrences in ${JSON.stringify(reclaimed)}`,
  );

  // (b) After reclaim, claim() on the same task must succeed again -- the
  // task is genuinely claimable, not just marked-reclaimed client-side.
  const reclaimAttempt = await lock.claim(taskId);
  for (const id of lock.createdIssueIds) allCreatedIssueIds.add(id);
  console.log(`[lease-reclaim.test] post-reclaim claim(): ${JSON.stringify(reclaimAttempt)}`);
  assert.equal(
    reclaimAttempt.ok,
    true,
    `expected task to be genuinely re-claimable after sweep(), got ${JSON.stringify(reclaimAttempt)}`,
  );
});

test("(c): concurrent sweep() safety -- a single stale lease is reclaimed in exactly one of two concurrent sweep() calls on the SAME instance (no double-reclaim)", async () => {
  const lock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
    staleMs: 100,
  });

  const taskId = `lock-behavior-test:concurrent-sweep:${randomUUID()}`;
  const claimResult = await lock.claim(taskId);
  for (const id of lock.createdIssueIds) allCreatedIssueIds.add(id);
  assert.equal(claimResult.ok, true, `expected initial claim to succeed, got ${JSON.stringify(claimResult)}`);

  // Force the lease stale via the test-only hook here (rather than a
  // wall-clock wait) so both concurrent sweep() calls race against a lease
  // that is DEFINITELY already stale at the moment Promise.all fires --
  // this maximizes the chance of exposing an interleaving bug rather than
  // depending on timing luck.
  const leaseId = (claimResult as { ok: true; leaseId: string }).leaseId;
  lock.expireLeaseForTesting(leaseId);

  const [reclaimedA, reclaimedB] = await Promise.all([lock.sweep(), lock.sweep()]);
  console.log(
    `[lease-reclaim.test] concurrent sweep(): A=${JSON.stringify(reclaimedA)} B=${JSON.stringify(reclaimedB)}`,
  );

  const combinedOccurrences =
    reclaimedA.filter((id) => id === taskId).length + reclaimedB.filter((id) => id === taskId).length;

  console.log(`[lease-reclaim.test] combined occurrences of taskId across both sweep() results: ${combinedOccurrences}`);

  assert.equal(
    combinedOccurrences,
    1,
    `expected taskId to be reclaimed in EXACTLY ONE of the two concurrent sweep() results (no double-reclaim), got ${combinedOccurrences}. A=${JSON.stringify(reclaimedA)} B=${JSON.stringify(reclaimedB)}`,
  );

  // Task should be genuinely claimable again after the (single) reclaim.
  const reclaimAttempt = await lock.claim(taskId);
  for (const id of lock.createdIssueIds) allCreatedIssueIds.add(id);
  assert.equal(
    reclaimAttempt.ok,
    true,
    `expected task to be re-claimable after concurrent-sweep reclaim, got ${JSON.stringify(reclaimAttempt)}`,
  );
});
