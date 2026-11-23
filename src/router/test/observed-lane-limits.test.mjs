// PANT-1445 (GH pantheon-v2#527): a provider limit Auriga sees on a run takes
// that lane out of routing even when Heimdall still reports it up, until the
// reset passes or a later run on the lane starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  observedLaneLimits, withObservedLaneLimits, createObservedLimitStore, createDecisionStore,
} from '../lib/lane-state.mjs';
import { quotaResetAtMs } from '../lib/run-classification.mjs';
import { laneUnavailable, chooseAgentForProject } from '../lib/core.mjs';

const MIN = 60_000;
const NOW = Date.parse('2026-11-22T12:00:00Z');
const WEEKLY = "You've hit your weekly limit · resets Nov 24, 5am (UTC)";
const failed = (agentId, at, error = WEEKLY) => ({
  agent_id: agentId, status: 'failed', error, failure_reason: 'agent_error.unknown',
  created_at: new Date(at - 1000).toISOString(), completed_at: new Date(at).toISOString(),
});
const running = (agentId, at) => ({
  agent_id: agentId, status: 'running', created_at: new Date(at - 1000).toISOString(), started_at: new Date(at).toISOString(),
});
const CFG = {
  AGENTS: {
    'build-codex': { id: 'A1', laneId: 'codex', available: true, maxInflight: 2 },
    'build-claude': { id: 'A2', laneId: 'claude', available: true, maxInflight: 2 },
  },
};

test('quotaResetAtMs reads the dated weekly-limit form, and ignores far-off dates', () => {
  assert.equal(quotaResetAtMs(failed('A1', NOW)), Date.parse('2026-11-24T05:00:00Z'));
  assert.equal(quotaResetAtMs(failed('A1', NOW, 'limit · resets Feb 3, 5am (UTC)')), null);
  // clock-only form still works
  assert.equal(quotaResetAtMs(failed('A1', NOW, 'session limit · resets 1:30pm (UTC)')), Date.parse('2026-11-22T13:30:00Z'));
});

test('a quota failure as the latest run on a lane limits that lane until the reset', () => {
  const limits = observedLaneLimits([['PANT-1', [failed('A1', NOW - 5 * MIN)]]], CFG, NOW);
  assert.deepEqual([...limits.keys()], ['codex']);
  const l = limits.get('codex');
  assert.equal(l.identifier, 'PANT-1');
  assert.equal(l.agentId, 'A1');
  assert.equal(l.untilMs, Date.parse('2026-11-24T05:00:00Z'));
  assert.equal(l.failedMs, NOW - 5 * MIN);
  assert.match(l.error, /weekly limit/);
});

test('no reset in the error falls back to the cooldown; an expired one does not limit', () => {
  const err = '429 rate limit exceeded';
  const fresh = observedLaneLimits([['P', [failed('A1', NOW - 5 * MIN, err)]]], CFG, NOW, 15 * MIN);
  assert.equal(fresh.get('codex').untilMs, NOW + 10 * MIN);
  const old = observedLaneLimits([['P', [failed('A1', NOW - 20 * MIN, err)]]], CFG, NOW, 15 * MIN);
  assert.equal(old.size, 0);
});

test('a later started run on the lane clears it; other failures and model-scoped limits do not limit', () => {
  const runs = [['P1', [failed('A1', NOW - 10 * MIN)]], ['P2', [running('A1', NOW - 2 * MIN)]]];
  assert.equal(observedLaneLimits(runs, CFG, NOW).size, 0);
  assert.equal(observedLaneLimits([['P', [failed('A1', NOW, 'TypeError: x is undefined')]]], CFG, NOW).size, 0);
  assert.equal(observedLaneLimits([['P', [failed('A2', NOW, "You've hit your Opus limit · resets 5pm (UTC)")]]], CFG, NOW).size, 0);
  // runs from agents with no lane are ignored
  assert.equal(observedLaneLimits([['P', [failed('ZZ', NOW)]]], CFG, NOW).size, 0);
});

test('prior limits persist until reset or until a later run on the lane starts', () => {
  const first = observedLaneLimits([['PANT-1', [failed('A1', NOW - 5 * MIN)]]], CFG, NOW);
  const prior = [...first.values()];
  // Next cycle: PANT-1 was re-routed, its runs are not fetched any more.
  assert.deepEqual([...observedLaneLimits([], CFG, NOW + MIN, 15 * MIN, prior).keys()], ['codex']);
  // After the reset it is gone.
  assert.equal(observedLaneLimits([], CFG, Date.parse('2026-11-24T05:01:00Z'), 15 * MIN, prior).size, 0);
  // A run that started on the lane after the failure supersedes it.
  assert.equal(observedLaneLimits([['PANT-9', [running('A1', NOW)]]], CFG, NOW + MIN, 15 * MIN, prior).size, 0);
  // Malformed prior entries are dropped.
  assert.equal(observedLaneLimits([], CFG, NOW, 15 * MIN, [null, { laneId: 1 }, { laneId: 'x' }]).size, 0);
});

test('withObservedLaneLimits marks the lane unavailable with an auriga: reason routing honours', () => {
  const limits = observedLaneLimits([['PANT-1', [failed('A1', NOW)]]], CFG, NOW);
  const cfg = withObservedLaneLimits(CFG, limits);
  assert.equal(cfg.AGENTS['build-codex'].available, false);
  assert.match(cfg.AGENTS['build-codex'].availabilityReason, /^auriga:codex:provider limit observed on PANT-1 until 2026-11-24T05:00/);
  assert.equal(cfg.AGENTS['build-claude'].available, true);
  assert.equal(laneUnavailable(cfg.AGENTS['build-codex']), true);
  assert.equal(laneUnavailable(cfg.AGENTS['build-claude']), false);
  assert.equal(laneUnavailable({ available: false, availabilityReason: 'manual' }), false);
  assert.deepEqual(cfg.observedLaneLimits.map((l) => l.laneId), ['codex']);
  // An agent Heimdall already took out keeps Heimdall's reason.
  const down = { AGENTS: { ...CFG.AGENTS, 'build-codex': { ...CFG.AGENTS['build-codex'], available: false, availabilityReason: 'heimdall:codex:down' } } };
  assert.equal(withObservedLaneLimits(down, limits).AGENTS['build-codex'].availabilityReason, 'heimdall:codex:down');
  assert.deepEqual(withObservedLaneLimits(CFG, new Map()).observedLaneLimits, []);
});

test('file-backed stores round-trip and tolerate missing/corrupt files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pant1445-'));
  try {
    const f = path.join(dir, 'limits.json');
    const store = createObservedLimitStore(f);
    assert.deepEqual(store.read(), []);
    store.write([{ laneId: 'codex', untilMs: 1 }]);
    assert.deepEqual(createObservedLimitStore(f).read(), [{ laneId: 'codex', untilMs: 1 }]);
    fs.writeFileSync(f, '{nope');
    assert.deepEqual(store.read(), []);

    const df = path.join(dir, 'decisions.json');
    let t = NOW;
    const d = createDecisionStore(df, { now: () => t, maxAgeMs: 60 * MIN });
    d.set('PANT-1', 'dec-1');
    d.set('PANT-2', 'dec-2');
    d.delete('PANT-2');
    assert.equal(createDecisionStore(df, { now: () => t, maxAgeMs: 60 * MIN }).get('PANT-1'), 'dec-1');
    assert.equal(createDecisionStore(df, { now: () => t, maxAgeMs: 60 * MIN }).has('PANT-2'), false);
    t = NOW + 2 * 60 * MIN;
    assert.equal(createDecisionStore(df, { now: () => t, maxAgeMs: 60 * MIN }).has('PANT-1'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
