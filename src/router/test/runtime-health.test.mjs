// PANT-1397: a runtime that fails N runs in a row across tickets is taken out of
// dispatch for a cooldown, whatever Heimdall says about its lanes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  RUNTIME_HEALTH_DEFAULTS as D, recordRuns, runtimeHolds, withRuntimeHolds, createRuntimeHealthStore, runtimeHealthOptions,
} from '../lib/runtime-health.mjs';
import { laneUnavailable } from '../lib/core.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-18T05:00:00Z');
const OC = 'opencode-runtime-0001';
const CL = 'claude-runtime-0002';
let seq = 0;
const run = (agentId, runtimeId, at, status, error) => ({
  id: `r${++seq}`, agent_id: agentId, runtime_id: runtimeId, status, error: error ?? null,
  created_at: new Date(at - 30_000).toISOString(), started_at: new Date(at - 20_000).toISOString(),
  completed_at: status === 'running' ? null : new Date(at).toISOString(),
});
const fail = (a, rt, at, e = 'opencode exited with error: exit status 1') => run(a, rt, at, 'failed', e);
const ok = (a, rt, at) => run(a, rt, at, 'completed');
const CFG = {
  AGENTS: {
    'review-gemini': { id: 'G1', available: true },
    'build-grok': { id: 'G2', available: true },
    'review-claude': { id: 'C1', available: true },
  },
};
const holdsFor = (runLists, now = NOW, prior = {}) => runtimeHolds(recordRuns(prior, runLists, now), now);

test('three failures in a row on one runtime across two tickets hold every agent seen on it', () => {
  const lists = [
    ['FFE-1', [fail('G1', OC, NOW - 9 * MIN), fail('G1', OC, NOW - 5 * MIN)]],
    ['FFE-2', [fail('G2', OC, NOW - 2 * MIN)]],
    ['FFE-3', [ok('C1', CL, NOW - MIN)]],
  ];
  const holds = holdsFor(lists);
  assert.deepEqual([...holds.keys()], [OC]);
  const h = holds.get(OC);
  assert.equal(h.streak, 3);
  assert.deepEqual(h.identifiers.sort(), ['FFE-1', 'FFE-2']);
  assert.deepEqual(h.agentIds.sort(), ['G1', 'G2']);
  assert.equal(h.sinceMs, NOW - 9 * MIN);
  assert.equal(h.untilMs, NOW - 2 * MIN + D.cooldownMs);
  assert.match(h.error, /exit status 1/);
});

test('no hold: a success breaks the streak, one ticket alone, quota failures and plain cancels', () => {
  // success newest
  assert.equal(holdsFor([['A', [fail('G1', OC, NOW - 9 * MIN), fail('G1', OC, NOW - 8 * MIN)]], ['B', [fail('G2', OC, NOW - 7 * MIN), ok('G2', OC, NOW - MIN)]]]).size, 0);
  // all on one ticket: that ticket is the problem, not the runtime
  assert.equal(holdsFor([['A', [fail('G1', OC, NOW - 3 * MIN), fail('G1', OC, NOW - 2 * MIN), fail('G1', OC, NOW - MIN)]]]).size, 0);
  // provider limits are the lane's business, cancels without error are Auriga's own
  const quota = "You've hit your usage limit";
  assert.equal(holdsFor([['A', [fail('G1', OC, NOW - 3 * MIN, quota), fail('G1', OC, NOW - 2 * MIN)]], ['B', [fail('G2', OC, NOW - MIN, quota)]]]).size, 0);
  assert.equal(holdsFor([['A', [run('G1', OC, NOW - 3 * MIN, 'cancelled'), fail('G1', OC, NOW - 2 * MIN)]], ['B', [fail('G2', OC, NOW - MIN)]]]).size, 0);
  // still-running and queued runs are neither a failure nor a success
  const queued = { id: 'q', agent_id: 'G1', runtime_id: OC, status: 'queued', created_at: new Date(NOW).toISOString() };
  const h = holdsFor([['A', [fail('G1', OC, NOW - 3 * MIN), fail('G1', OC, NOW - 2 * MIN), queued, run('G1', OC, NOW, 'running')]], ['B', [fail('G2', OC, NOW - MIN)]]]);
  assert.equal(h.get(OC).streak, 3);
});

test('the hold expires after the cooldown (probe), and each further failure doubles it up to the cap', () => {
  const base = [['A', [fail('G1', OC, NOW - 30 * MIN), fail('G1', OC, NOW - 29 * MIN)]], ['B', [fail('G2', OC, NOW - 28 * MIN)]]];
  assert.equal(holdsFor(base, NOW - 28 * MIN + D.cooldownMs + 1).size, 0, 'cooldown over: let a probe through');
  const probeFailed = [...base, ['C', [fail('G1', OC, NOW)]]];
  assert.equal(holdsFor(probeFailed).get(OC).untilMs, NOW + 2 * D.cooldownMs);
  const many = [...probeFailed, ['D', [fail('G1', OC, NOW + MIN), fail('G1', OC, NOW + 2 * MIN), fail('G1', OC, NOW + 3 * MIN), fail('G1', OC, NOW + 4 * MIN)]]];
  assert.equal(holdsFor(many, NOW + 4 * MIN).get(OC).untilMs, NOW + 4 * MIN + D.maxCooldownMs);
  // and a success clears it outright
  assert.equal(holdsFor([...probeFailed, ['E', [ok('G2', OC, NOW + MIN)]]], NOW + 2 * MIN).size, 0);
});

test('history persists across cycles: runs of tickets no longer fetched still count, and old runs are forgotten', () => {
  const s1 = recordRuns({}, [['A', [fail('G1', OC, NOW - 3 * MIN)]], ['B', [fail('G2', OC, NOW - 2 * MIN)]]], NOW);
  assert.equal(runtimeHolds(s1, NOW).size, 0);
  // Next cycle A and B are blocked (not fetched); C's failure completes the streak.
  const cRun = fail('G1', OC, NOW);
  const s2 = recordRuns(JSON.parse(JSON.stringify(s1)), [['C', [cRun]]], NOW + MIN);
  assert.equal(runtimeHolds(s2, NOW + MIN).get(OC).streak, 3);
  // The same run seen twice is counted once.
  const again = recordRuns(s2, [['C', [cRun]]], NOW + MIN);
  assert.equal(again.runtimes[OC].runs.length, 3);
  const later = recordRuns(s2, [], NOW + D.forgetMs);
  assert.equal(later.runtimes[OC].runs.length, 0);
  // An agent that moved runtimes is mapped by its newest run.
  const moved = recordRuns(s2, [['Z', [ok('G1', CL, NOW + 2 * MIN)]]], NOW + 3 * MIN);
  assert.deepEqual(runtimeHolds(moved, NOW + 3 * MIN).get(OC).agentIds, ['G2']);
});

test('withRuntimeHolds marks the agents unavailable with an auriga: reason routing honours', () => {
  const holds = holdsFor([['FFE-1', [fail('G1', OC, NOW - 5 * MIN)]], ['FFE-2', [fail('G2', OC, NOW - 3 * MIN), fail('G2', OC, NOW - 2 * MIN)]]]);
  const cfg = withRuntimeHolds(CFG, holds);
  assert.equal(cfg.AGENTS['review-gemini'].available, false);
  assert.equal(cfg.AGENTS['build-grok'].available, false);
  assert.equal(cfg.AGENTS['review-claude'].available, true);
  assert.match(cfg.AGENTS['review-gemini'].availabilityReason, /^auriga:runtime-opencode:3 runs failed in a row \(FFE-2, FFE-1\) until /);
  assert.equal(laneUnavailable(cfg.AGENTS['review-gemini']), true);
  assert.deepEqual(cfg.runtimeHolds.map((h) => h.runtimeId), [OC]);
  const down = { AGENTS: { ...CFG.AGENTS, 'review-gemini': { id: 'G1', available: false, availabilityReason: 'heimdall:gemini:down' } } };
  assert.equal(withRuntimeHolds(down, holds).AGENTS['review-gemini'].availabilityReason, 'heimdall:gemini:down');
  assert.deepEqual(withRuntimeHolds(CFG, new Map()).runtimeHolds, []);
});

test('options from CAPS; streak 0 turns the gate off', () => {
  assert.equal(runtimeHealthOptions({}).streak, 3);
  assert.equal(runtimeHealthOptions({ runtimeFailureStreak: 5, runtimeFailureCooldownMs: MIN }).cooldownMs, MIN);
  assert.equal(runtimeHealthOptions({ runtimeFailureStreak: -1 }).streak, 3);
  const off = runtimeHealthOptions({ runtimeFailureStreak: 0 });
  const s = recordRuns({}, [['A', [fail('G1', OC, NOW - 2 * MIN)]], ['B', [fail('G2', OC, NOW - MIN), fail('G2', OC, NOW)]]], NOW, off);
  assert.equal(runtimeHolds(s, NOW, off).size, 0);
});

test('file store round-trips, writes holds with ISO times for the nurse, tolerates missing/corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pant1397-'));
  try {
    const f = path.join(dir, 'runtime-health.json');
    const store = createRuntimeHealthStore(f);
    assert.deepEqual(store.read(), {});
    const state = recordRuns({}, [['A', [fail('G1', OC, NOW - 2 * MIN)]], ['B', [fail('G2', OC, NOW - MIN), fail('G2', OC, NOW)]]], NOW);
    const holds = runtimeHolds(state, NOW);
    store.write(state, holds.values(), NOW);
    const back = createRuntimeHealthStore(f).read();
    assert.equal(back.updated_at, new Date(NOW).toISOString());
    assert.equal(back.holds.length, 1);
    assert.equal(back.holds[0].runtimeId, OC);
    assert.equal(back.holds[0].until, new Date(NOW + D.cooldownMs).toISOString());
    assert.equal(runtimeHolds(back, NOW).size, 1, 'the router can resume from the file');
    fs.writeFileSync(f, '{nope');
    assert.deepEqual(store.read(), {});
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
