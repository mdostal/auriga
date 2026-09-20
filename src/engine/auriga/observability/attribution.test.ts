// Full-stack behavioral test for observability-attribution-tests
// (.pHive/epics/contracts-and-spine/stories/observability-attribution-tests.yaml),
// REQ-13's acceptance criterion: a dropped or duplicated task, or a
// simulated death, must be attributable afterward by task id, timestamp,
// and cause -- not just a raw count.
//
// Deliberately NOT a re-run of counters.test.ts's synthetic-array
// derivation tests. Every incident here is induced by driving the REAL
// stack:
//   - dropped:    a real MulticaLock, wrapped in a real InstrumentedLock
//                 (auriga/observability/instrumented-lock.ts), actually
//                 claims a real Multica issue and is deliberately never
//                 released.
//   - duplicated: TWO separate real MulticaLock instances (each wrapped in
//                 its own InstrumentedLock) sharing one Multica auth token
//                 concurrently race a claim() for the same fresh task --
//                 exploiting the ALREADY-DOCUMENTED, ACCEPTED cross-process
//                 gap described in auriga/lock/index.ts's class doc
//                 ("cross-process race... NOT PROTECTED... 20/20
//                 double-claims"), the same scenario the original version
//                 of auriga/lock/concurrent-claim.test.ts exercised before
//                 that test was rescoped to same-instance-only.
//   - death:      a real HeartbeatWriter actually ticks a few times against
//                 a scratch heartbeat file, then stop() is called WITHOUT
//                 markCleanShutdown() -- the real distinguishing signal
//                 detectPreviousDeath() relies on (see death-detection.ts's
//                 class doc) -- and detectPreviousDeath() is run against
//                 that same file.
//
// `deriveCounters()`'s injectable `windowMs`/`now` are used only to avoid a
// real 5-minute sleep for the dropped-task window -- everything upstream of
// that call (the claim, the event stream, the never-firing release) is
// real. See counters.ts's DeriveCountersOptions doc.
//
// Auth/workspace read from ~/.multica/config.json at runtime, per this
// repo's established precedent (concurrent-claim.test.ts,
// restart-safety-runner.ts, e2e-runner.ts) -- never hardcoded, never
// written to disk. Created Multica issues are cleaned up in an `after()`
// hook with per-id 404 verification, same pattern as concurrent-claim.test.ts.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { MulticaLock } from "../lock/index.ts";
import { InstrumentedLock } from "./instrumented-lock.ts";
import { deriveCounters, ObservabilityCounterStore, type LockEvent } from "./counters.ts";
import {
  HeartbeatWriter,
  detectPreviousDeath,
  DeathEventStore,
  DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN,
} from "./death-detection.ts";
import type { ClaimResult } from "../../contracts/lock.ts";

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

function leaseIdOf(result: ClaimResult): string | undefined {
  return result.ok ? result.leaseId : undefined;
}

const allCreatedIssueIds = new Set<string>();

let countersDbPath: string;
let deathDbPath: string;
let heartbeatPath: string;
let counterStore: ObservabilityCounterStore;
let deathStore: DeathEventStore;

// Populated by the individual scenario tests, asserted together at the end
// -- see the final "attribution: exactly one record of each kind" test.
let droppedTaskId: string;
let duplicatedTaskId: string;
let deathRunId: string;

before(() => {
  countersDbPath = join(tmpdir(), `auriga-attribution-counters-${randomUUID()}.sqlite`);
  deathDbPath = join(tmpdir(), `auriga-attribution-death-${randomUUID()}.sqlite`);
  heartbeatPath = join(tmpdir(), `auriga-attribution-heartbeat-${randomUUID()}.json`);
  counterStore = new ObservabilityCounterStore(countersDbPath);
  deathStore = new DeathEventStore(deathDbPath);
});

after(async () => {
  counterStore.close();
  deathStore.close();
  rmSync(countersDbPath, { force: true });
  rmSync(deathDbPath, { force: true });
  rmSync(heartbeatPath, { force: true });

  console.log(
    `[attribution.test] cleaning up ${allCreatedIssueIds.size} Multica issue(s) created during this run`,
  );
  for (const id of allCreatedIssueIds) {
    const del = await apiDelete(`/api/issues/${id}`);
    assert.equal(del.status, 204, `expected 204 deleting issue ${id}, got ${del.status}`);
  }
  // Per-id 404 check, not a broad workspace-wide scan -- see
  // concurrent-claim.test.ts for why (sibling test files run concurrently
  // against the same shared live workspace).
  for (const id of allCreatedIssueIds) {
    const check = await apiGet(`/api/issues/${id}`);
    assert.equal(check.status, 404, `expected issue ${id} to be gone (404), got ${check.status}`);
  }
  console.log(
    `[attribution.test] cleanup verified: all ${allCreatedIssueIds.size} tracked issue(s) confirmed gone`,
  );
});

test("dropped task: real MulticaLock claim via InstrumentedLock, deliberately never released -> attributed correctly", async () => {
  const realLock = new MulticaLock({
    serverUrl: cfg.server_url,
    workspaceId: cfg.workspace_id,
    token: cfg.token,
  });
  const instrumented = new InstrumentedLock(realLock);

  const taskId = `attribution-test:dropped:${randomUUID()}`;
  droppedTaskId = taskId;

  const result = await instrumented.claim(taskId);
  for (const id of realLock.createdIssueIds) allCreatedIssueIds.add(id);
  if (!result.ok) {
    assert.fail(`expected the real claim() to succeed, got ${JSON.stringify(result)}`);
  }
  const leaseId = result.leaseId;

  // Deliberately never released -- this IS the induced incident. Confirm
  // the InstrumentedLock actually captured the real claim as a LockEvent.
  assert.equal(instrumented.events.length, 1);
  const claimEvent = instrumented.events[0];
  assert.ok(claimEvent);
  assert.deepEqual(claimEvent, { type: "claimed", taskId, leaseId, timestamp: claimEvent.timestamp });

  // Short windowMs override so this is fast and deterministic -- no real
  // 5-minute sleep. `now` is set comfortably past the window relative to
  // the REAL claim timestamp captured above, per counters.ts's documented
  // purpose for these options.
  const windowMs = 200;
  const now = claimEvent.timestamp + windowMs + 50;

  const derived = deriveCounters(instrumented.events, { windowMs, now });
  assert.equal(derived.dropped.length, 1, "expected exactly one dropped finding");
  assert.equal(derived.duplicated.length, 0, "a single unreleased claim must not also be flagged duplicated");

  const droppedFinding = derived.dropped[0];
  assert.ok(droppedFinding);
  assert.deepEqual(droppedFinding, {
    taskId,
    leaseId,
    claimedAt: claimEvent.timestamp,
    cause: "claimed_never_released_within_window",
  });

  counterStore.record(derived);

  const persisted = counterStore.getDroppedTasks().filter((d) => d.taskId === taskId);
  assert.equal(persisted.length, 1, "expected exactly one persisted dropped record for this task id");
  assert.deepEqual(persisted[0], {
    taskId,
    leaseId,
    claimedAt: claimEvent.timestamp,
    cause: "claimed_never_released_within_window",
  });
});

test("duplicated task: two MulticaLock instances sharing one token race the same fresh task -> attributed correctly (accepted cross-process gap)", async () => {
  // Two SEPARATE MulticaLock instances, both authenticated with the SAME
  // token -- deliberately exploiting the documented, accepted gap in
  // auriga/lock/index.ts's class doc ("cross-process race... NOT
  // PROTECTED... every process sharing one token has the IDENTICAL
  // #callerId"). Each wrapped in its own InstrumentedLock, per this
  // story's spec (merge both instances' captured event streams).
  const lockA = new MulticaLock({ serverUrl: cfg.server_url, workspaceId: cfg.workspace_id, token: cfg.token });
  const lockB = new MulticaLock({ serverUrl: cfg.server_url, workspaceId: cfg.workspace_id, token: cfg.token });
  const instrumentedA = new InstrumentedLock(lockA);
  const instrumentedB = new InstrumentedLock(lockB);

  // Per the class doc this reliably reproduces (20/20 in
  // lock-concurrent-claim-tests' original run) -- a small retry budget is
  // kept purely as a safety margin against wire-level flakiness, not
  // because the gap is expected to be intermittent.
  const MAX_ATTEMPTS = 5;
  let doubled = false;
  let taskId = "";
  let resA: ClaimResult | undefined;
  let resB: ClaimResult | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS && !doubled; attempt++) {
    taskId = `attribution-test:duplicated:${randomUUID()}`;
    [resA, resB] = await Promise.all([instrumentedA.claim(taskId), instrumentedB.claim(taskId)]);
    doubled = resA.ok === true && resB.ok === true;
    console.log(
      `[attribution.test] duplicated-task attempt ${attempt}: A=${JSON.stringify(resA)} B=${JSON.stringify(resB)} doubled=${doubled}`,
    );
    if (!doubled) {
      // Clean up a single winner immediately so it doesn't linger claimed
      // across retry attempts; the loser needs no cleanup (it never won).
      const soleWinnerLeaseId = leaseIdOf(resA) ?? leaseIdOf(resB);
      if (soleWinnerLeaseId) {
        if (resA.ok) await instrumentedA.release(soleWinnerLeaseId);
        else if (resB.ok) await instrumentedB.release(soleWinnerLeaseId);
      }
    }
  }

  for (const id of lockA.createdIssueIds) allCreatedIssueIds.add(id);
  for (const id of lockB.createdIssueIds) allCreatedIssueIds.add(id);

  assert.ok(
    doubled,
    `expected the documented cross-process double-claim gap (auriga/lock/index.ts class doc) to reproduce within ${MAX_ATTEMPTS} attempts, but it never did`,
  );
  duplicatedTaskId = taskId;

  const merged: LockEvent[] = [...instrumentedA.events, ...instrumentedB.events];
  // Default windowMs/now (real Date.now()) -- real elapsed time in this
  // test is nowhere near the 5-minute default window, so this open double
  // claim must NOT also be flagged dropped.
  const derived = deriveCounters(merged);

  assert.equal(derived.duplicated.length, 1, "expected exactly one duplicated finding");
  assert.equal(
    derived.dropped.length,
    0,
    "an in-flight double claim within this short test must not also be flagged dropped",
  );

  const dup = derived.duplicated[0];
  assert.ok(dup);
  assert.equal(dup.taskId, taskId);
  assert.equal(dup.cause, "concurrent_claims_overlapping_intervals");
  assert.equal(dup.claims.length, 2, "expected exactly the two colliding claims implicated");

  counterStore.record(derived);

  const persisted = counterStore.getDuplicatedTasks().filter((d) => d.taskId === taskId);
  assert.equal(persisted.length, 1, "expected exactly one persisted duplicated record for this task id");
  assert.equal(persisted[0]?.cause, "concurrent_claims_overlapping_intervals");
  assert.equal(persisted[0]?.claims.length, 2);

  // Cleanup: release both leases (each instance genuinely believes it won)
  // before the after() hook deletes the underlying issue.
  const winA = resA?.ok ? resA.leaseId : undefined;
  const winB = resB?.ok ? resB.leaseId : undefined;
  if (winA) await instrumentedA.release(winA);
  if (winB) await instrumentedB.release(winB);
});

test("simulated death: a real HeartbeatWriter ticks, then stop() WITHOUT markCleanShutdown() -> detected and attributed correctly", async () => {
  const writer = new HeartbeatWriter({ heartbeatPath, intervalMs: 15 });
  writer.start();
  deathRunId = writer.runId;

  // Let it really tick a few times -- a faithful simulation of "the
  // process was alive and heartbeating", not a hand-written JSON fixture.
  await new Promise((resolve) => setTimeout(resolve, 90));

  // Simulate the kill: stop() clears the timer WITHOUT writing a
  // clean-shutdown marker -- the last thing on disk is an ordinary tick,
  // exactly what death-detection.ts's doc comment says a SIGKILL/OOM looks
  // like from the outside.
  writer.stop();

  const onDiskBeforeDetect = JSON.parse(readFileSync(heartbeatPath, "utf8")) as { updatedAt: string };

  const result = detectPreviousDeath(heartbeatPath);

  assert.equal(result.death, true, `expected a death to be detected, got ${JSON.stringify(result)}`);
  if (!result.death) {
    assert.fail("unreachable -- narrowed by the assert above");
  }

  assert.equal(result.event.cause, DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN);
  assert.equal(result.event.heartbeatTimestamp, onDiskBeforeDetect.updatedAt);
  assert.equal(result.event.runId, deathRunId);
  assert.equal(result.event.pid, process.pid);
  assert.ok(
    Math.abs(Date.now() - Date.parse(result.event.heartbeatTimestamp)) < 5_000,
    "heartbeatTimestamp should be close to real wall-clock now in this test",
  );

  deathStore.recordDeath(result.event);

  const persisted = deathStore.getDeathEvents().filter((e) => e.runId === deathRunId);
  assert.equal(persisted.length, 1, "expected exactly one persisted death record for this run id");
  assert.deepEqual(persisted[0], result.event);
});

test("attribution: exactly one record of each incident kind, correctly distinguished by task id / run id (no over- or under-counting)", () => {
  const dropped = counterStore.getDroppedTasks();
  const duplicated = counterStore.getDuplicatedTasks();
  const deaths = deathStore.getDeathEvents();

  assert.equal(dropped.length, 1, `expected exactly 1 dropped record total, got ${dropped.length}`);
  assert.equal(duplicated.length, 1, `expected exactly 1 duplicated record total, got ${duplicated.length}`);
  assert.equal(deaths.length, 1, `expected exactly 1 death record total, got ${deaths.length}`);

  assert.equal(dropped[0]?.taskId, droppedTaskId);
  assert.equal(duplicated[0]?.taskId, duplicatedTaskId);
  assert.equal(deaths[0]?.runId, deathRunId);

  // The three incidents are genuinely distinct -- no single real event got
  // double-attributed across stores/kinds.
  assert.notEqual(droppedTaskId, duplicatedTaskId);
  assert.equal(dropped[0]?.cause, "claimed_never_released_within_window");
  assert.equal(duplicated[0]?.cause, "concurrent_claims_overlapping_intervals");
  assert.equal(deaths[0]?.cause, DEATH_CAUSE_HEARTBEAT_MISSING_CLEAN_SHUTDOWN);
});
