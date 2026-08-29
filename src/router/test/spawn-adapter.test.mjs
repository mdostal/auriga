// Unit tests for createMulticaSpawnAdapter (../lib/adapters/multica/spawn.mjs)
// against MOCKED multica CLI output — no live CLI is ever invoked, and no
// real synchronous sleep ever blocks (cfg.sleep is always injected). Mirrors
// test/backlog-adapter.test.mjs's execFileSync-mocking pattern (see that
// file's header comment for the module-mocking mechanics / cache-busting
// import rationale).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PROJECT_LANE, DEFAULT_LANE, HIVE_LANE, REVIEW_LANE, RUNTIME_CAP,
} from '../lib/config-substrate.mjs';

let importCounter = 0;
async function freshAdapterModule() {
  importCounter++;
  return import(`../lib/adapters/multica/spawn.mjs?t=${importCounter}`);
}

const MULTICA_CLI = 'multica-test-cli';

function stripProfile(args) {
  const i = args.indexOf('--profile');
  return i === -1 ? args : [...args.slice(0, i), ...args.slice(i + 2)];
}

function makeExecMock(t, handler = () => null) {
  const calls = [];
  const fn = t.mock.fn((cmd, args, options) => {
    calls.push({ cmd, args, options });
    if (cmd !== MULTICA_CLI) throw new Error('unexpected exec cmd: ' + cmd);
    const result = handler(stripProfile(args));
    if (result instanceof Error) throw result;
    return JSON.stringify(result);
  });
  t.mock.module('node:child_process', { exports: { execFileSync: fn } });
  return calls;
}

// ---- describeLanes(): byte-for-byte snapshot equality --------------------

test('describeLanes(): structurally identical to today\'s exact PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/REVIEW_LANE/RUNTIME_CAP values, including the unmapped-names gap', async (t) => {
  makeExecMock(t);
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });

  const lanes = adapter.describeLanes();

  assert.deepEqual(lanes.projectLane, PROJECT_LANE);
  assert.deepEqual(lanes.defaultLane, DEFAULT_LANE);
  assert.deepEqual(lanes.hiveLane, HIVE_LANE);
  assert.deepEqual(lanes.reviewLane, REVIEW_LANE);
  assert.deepEqual(lanes.runtimeCap, RUNTIME_CAP);

  // PRUNED 2026-08-29: the 4 aligned-repo entries (Consus, Heimdall, Auriga,
  // and the original stale-workspace "Pantheon Core") were all scoped to a
  // DIFFERENT Multica workspace this host no longer talks to -- confirmed
  // live (GET /api/projects against the real, current workspace) that none
  // of those 4 ids exist in it. PROJECT_LANE now covers exactly 2 entries:
  // the one real, live "Pantheon Core" project plus Minerva's dispatch-
  // ineligible lane-fallback placeholder (not a real project either, but
  // intentionally kept -- see projects.json's own notes on both entries).
  assert.equal(Object.keys(lanes.projectLane).length, 2, 'PROJECT_LANE must have exactly 2 mapped project UUIDs after the 2026-08-29 stale-workspace prune');
});

test('describeLanes(): a cfg-supplied fixture lane map overrides the live config-substrate.mjs defaults', async (t) => {
  makeExecMock(t);
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const fixtureRuntimeCap = { fakeRuntime: 1 };
  const adapter = createMulticaSpawnAdapter({
    cli: MULTICA_CLI,
    projectLane: {}, defaultLane: ['fake-dev'], hiveLane: ['fake-hive'],
    reviewLane: ['fake-review'], runtimeCap: fixtureRuntimeCap,
  });
  const lanes = adapter.describeLanes();
  assert.deepEqual(lanes.defaultLane, ['fake-dev']);
  assert.deepEqual(lanes.runtimeCap, fixtureRuntimeCap);
});

// ---- assignIssue / rerunIssue / unassignIssue: ported CLI shape ----------

test('assignIssue invokes `issue assign <id> --to <agent>` and returns the parsed CLI result', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });

  const result = adapter.assignIssue('PAN-1', 'auriga-dev');
  assert.deepEqual(result, { ok: true });
  const call = calls.find((c) => c.cmd === MULTICA_CLI);
  const args = stripProfile(call.args);
  assert.deepEqual(args, ['issue', 'assign', 'PAN-1', '--to', 'auriga-dev', '--output', 'json']);
});

test('assignIssue propagates a CLI failure (writes do not degrade gracefully)', async (t) => {
  makeExecMock(t, () => new Error('multica: conflict'));
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });
  assert.throws(() => adapter.assignIssue('PAN-1', 'auriga-dev'), /conflict/);
});

test('rerunIssue invokes `issue rerun <id>` and returns the parsed CLI result', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'rerun') return { ok: true };
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });

  const result = adapter.rerunIssue('PAN-1');
  assert.deepEqual(result, { ok: true });
  const call = calls.find((c) => c.cmd === MULTICA_CLI);
  assert.deepEqual(stripProfile(call.args), ['issue', 'rerun', 'PAN-1', '--output', 'json']);
});

test('rerunIssue propagates a CLI failure', async (t) => {
  makeExecMock(t, () => new Error('multica: not found'));
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });
  assert.throws(() => adapter.rerunIssue('PAN-1'), /not found/);
});

test('unassignIssue invokes `issue assign <id> --unassign` and returns the parsed CLI result', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });

  const result = adapter.unassignIssue('PAN-1');
  assert.deepEqual(result, { ok: true });
  const call = calls.find((c) => c.cmd === MULTICA_CLI);
  assert.deepEqual(stripProfile(call.args), ['issue', 'assign', 'PAN-1', '--unassign', '--output', 'json']);
});

test('unassignIssue propagates a CLI failure', async (t) => {
  makeExecMock(t, () => new Error('multica: down'));
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });
  assert.throws(() => adapter.unassignIssue('PAN-1'), /down/);
});

// ---- dispatch(issue, lane): verify-delay / force-rerun sequence ----------
// Ports auriga-router.mjs's cycle() "route new todos" assign -> verify a
// run started -> force-rerun block. CAPS.verifyDelayMs semantics: sleep is
// injected via cfg.sleep (never a real block in these tests) and its call
// (ms argument) is itself asserted, proving the delay is honored.

test('dispatch(): a run that started (any run row) within the verify delay does NOT force-rerun', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    if (args[0] === 'issue' && args[1] === 'runs') {
      return [{ status: 'in_progress', created_at: '2026-08-16T00:00:00Z', dispatched_at: '2026-08-16T00:00:00Z', runtime_id: 'rt-1' }];
    }
    throw new Error('unexpected args ' + args.join(' '));
  });
  const sleepCalls = [];
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({
    cli: MULTICA_CLI, verifyDelayMs: 6000, sleep: (ms) => sleepCalls.push(ms),
  });

  const result = adapter.dispatch({ identifier: 'PAN-1' }, 'auriga-dev');

  assert.equal(result.started, true);
  assert.equal(result.forcedRerun, false);
  assert.equal(result.runStatus, 'in_progress');
  assert.equal(result.runtimeId, 'rt-1');
  assert.deepEqual(sleepCalls, [6000], 'must sleep exactly CAPS.verifyDelayMs after assign, before verifying');
  assert.ok(!calls.some((c) => stripProfile(c.args)[1] === 'rerun'), 'must NOT force-rerun when a run already started');
});

test('dispatch(): no run row within the verify delay -> force-reruns exactly as today\'s inline dispatch loop does', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    if (args[0] === 'issue' && args[1] === 'runs') return [];
    if (args[0] === 'issue' && args[1] === 'rerun') return { ok: true };
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({
    cli: MULTICA_CLI, verifyDelayMs: 6000, sleep: () => {},
  });

  const result = adapter.dispatch({ identifier: 'PAN-2' }, 'auriga-dev');

  assert.equal(result.started, false);
  assert.equal(result.forcedRerun, true);
  const assignCall = calls.find((c) => stripProfile(c.args)[1] === 'assign');
  const rerunCall = calls.find((c) => stripProfile(c.args)[1] === 'rerun');
  assert.ok(assignCall, 'must assign first');
  assert.ok(rerunCall, 'must force-rerun when verify finds no run row');
  assert.deepEqual(stripProfile(rerunCall.args), ['issue', 'rerun', 'PAN-2', '--output', 'json']);
});

test('dispatch(): a run row present but not yet classifiable as active/done/failed still force-reruns', async (t) => {
  makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    // A run row whose status is unrecognized and has no completed_at is
    // treated as failed=false/hasCompleted=false/active=(status==='' or in
    // ACTIVE_RUN_STATUSES) per classifyRun — 'weird-unknown-status' is
    // neither, so active/done/failed are all false -> NOT started.
    if (args[0] === 'issue' && args[1] === 'runs') {
      return [{ status: 'weird-unknown-status', created_at: '2026-08-16T00:00:00Z' }];
    }
    if (args[0] === 'issue' && args[1] === 'rerun') return { ok: true };
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI, sleep: () => {} });

  const result = adapter.dispatch({ identifier: 'PAN-3' }, 'auriga-dev');
  assert.equal(result.started, false);
  assert.equal(result.forcedRerun, true);
});

test('dispatch(): an assign failure short-circuits — never sleeps, never checks runs, never reruns, never throws', async (t) => {
  const calls = makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return new Error('multica: rate limited');
    throw new Error('unexpected args ' + args.join(' '));
  });
  const sleepCalls = [];
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI, sleep: (ms) => sleepCalls.push(ms) });

  const result = adapter.dispatch({ identifier: 'PAN-4' }, 'auriga-dev');

  assert.equal(result.assigned, false);
  assert.match(result.assignError, /rate limited/);
  assert.deepEqual(sleepCalls, [], 'must never sleep after a failed assign');
  assert.equal(calls.length, 1, 'must never call runs/rerun after a failed assign');
});

test('dispatch(): a rerun failure during force-rerun is captured on the result, never thrown', async (t) => {
  makeExecMock(t, (args) => {
    if (args[0] === 'issue' && args[1] === 'assign') return { ok: true };
    if (args[0] === 'issue' && args[1] === 'runs') return [];
    if (args[0] === 'issue' && args[1] === 'rerun') return new Error('multica: rerun failed');
    throw new Error('unexpected args ' + args.join(' '));
  });
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI, sleep: () => {} });

  const result = adapter.dispatch({ identifier: 'PAN-5' }, 'auriga-dev');
  assert.equal(result.forcedRerun, true);
  assert.match(result.rerunError, /rerun failed/);
});

// ---- no provisioning method of any kind (locked design decision) ---------

test('the adapter exposes exactly the SpawnAdapter surface — no provision/ensureProvisioned/bootstrap/hook method of any kind', async (t) => {
  makeExecMock(t);
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });

  const keys = Object.keys(adapter).sort();
  assert.deepEqual(keys, ['assignIssue', 'describeLanes', 'dispatch', 'rerunIssue', 'unassignIssue']);
  for (const k of keys) {
    assert.doesNotMatch(k.toLowerCase(), /provision|bootstrap|createenvironment|middleware|^hook/);
  }
});

test('createMulticaSpawnAdapter returns a frozen object (no class, plain factory)', async (t) => {
  makeExecMock(t);
  const { createMulticaSpawnAdapter } = await freshAdapterModule();
  const adapter = createMulticaSpawnAdapter({ cli: MULTICA_CLI });
  assert.ok(Object.isFrozen(adapter));
});
