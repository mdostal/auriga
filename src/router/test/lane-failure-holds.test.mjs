// PANT-1445 (pantheon-v2#527, 2026-11-23): Gemini failed every run while the
// opencode runtime's other lanes succeeded and Heimdall said `gemini` was up.
// Reviews kept going to the Gemini reviewers and PANT-706 was parked blocked.
// A lane with a failure streak is taken out, and a lane failure never blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUNTIME_HEALTH_DEFAULTS as D, recordRuns, laneFailureHolds, withLaneFailureHolds, runtimeHolds,
  runtimeHealthOptions, createRuntimeHealthStore,
} from '../lib/runtime-health.mjs';
import { laneUnavailable, selectReviewDispatch } from '../lib/core.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN = 60_000;
const NOW = Date.parse('2026-11-23T12:40:00Z');
const OC = 'opencode-runtime-dragon';
let seq = 0;
const run = (agentId, runtimeId, at, status, error) => ({
  id: `r${++seq}`, agent_id: agentId, runtime_id: runtimeId, status, error: error ?? null,
  created_at: new Date(at - 30_000).toISOString(), started_at: new Date(at - 20_000).toISOString(),
  completed_at: status === 'running' ? null : new Date(at).toISOString(),
});
const fail = (a, rt, at, e = 'opencode exited with error: exit status 1') => run(a, rt, at, 'failed', e);
const ok = (a, rt, at) => run(a, rt, at, 'completed');

// Two Gemini reviewers and an xAI builder share the opencode runtime.
const CFG = {
  AGENTS: {
    'flayr-review-gemini': { id: 'GF', laneId: 'gemini', available: true },
    'auriga-review-gemini': { id: 'GA', laneId: 'gemini', available: true },
    'build-grok': { id: 'XB', laneId: 'xai', available: true },
    'auriga-review': { id: 'CR', laneId: 'claude', available: true },
  },
};
const geminiOutage = () => [
  ['FFE-2202', [fail('GF', OC, NOW - 17 * MIN), fail('GF', OC, NOW - 15 * MIN)]],
  ['PANT-1006', [fail('GA', OC, NOW - 9 * MIN)]],
  ['PANT-900', [ok('XB', OC, NOW - 12 * MIN), ok('XB', OC, NOW - 3 * MIN)]], // the runtime is fine
];

test('a lane failing across tickets is held while its runtime, still serving other lanes, is not', () => {
  const state = recordRuns({}, geminiOutage(), NOW);
  assert.equal(runtimeHolds(state, NOW).size, 0, 'the xAI successes keep the runtime in');
  const holds = laneFailureHolds(state, CFG, NOW);
  assert.deepEqual([...holds.keys()], ['gemini']);
  const h = holds.get('gemini');
  assert.equal(h.streak, 3);
  assert.deepEqual(h.identifiers.sort(), ['FFE-2202', 'PANT-1006']);
  assert.deepEqual(h.agentIds.sort(), ['GA', 'GF']);
  assert.equal(h.untilMs, NOW - 9 * MIN + D.cooldownMs);
  assert.match(h.error, /exit status 1/);
});

test('no lane hold: one ticket alone, a success on the lane, provider limits, unmapped agents, gate off', () => {
  const holds = (lists, cfg = CFG, opts) => laneFailureHolds(recordRuns({}, lists, NOW), cfg, NOW, opts);
  assert.equal(holds([['A', [fail('GF', OC, NOW - 3 * MIN), fail('GF', OC, NOW - 2 * MIN), fail('GF', OC, NOW - MIN)]]]).size, 0);
  assert.equal(holds([...geminiOutage(), ['B', [ok('GA', OC, NOW - MIN)]]]).size, 0);
  const quota = "You've hit your weekly limit";
  assert.equal(holds([['A', [fail('GF', OC, NOW - 3 * MIN, quota), fail('GF', OC, NOW - 2 * MIN, quota)]], ['B', [fail('GA', OC, NOW - MIN, quota)]]]).size, 0);
  const unmapped = { AGENTS: { x: { id: 'GF' }, y: { id: 'GA' } } };
  assert.equal(holds(geminiOutage(), unmapped).size, 0);
  assert.equal(holds(geminiOutage(), CFG, runtimeHealthOptions({ laneFailureStreak: 0 })).size, 0);
});

test('the lane hold expires after its cooldown, doubling per further failure', () => {
  const state = recordRuns({}, geminiOutage(), NOW);
  assert.equal(laneFailureHolds(state, CFG, NOW - 9 * MIN + D.cooldownMs).size, 0, 'cooldown over: next run probes');
  const more = recordRuns(state, [['FFE-565', [fail('GF', OC, NOW - MIN)]]], NOW);
  assert.equal(laneFailureHolds(more, CFG, NOW).get('gemini').untilMs, NOW - MIN + 2 * D.cooldownMs);
});

test('withLaneFailureHolds marks the lane\'s agents out with an auriga: reason; others untouched', () => {
  const holds = laneFailureHolds(recordRuns({}, geminiOutage(), NOW), CFG, NOW);
  const out = withLaneFailureHolds(CFG, holds);
  for (const n of ['flayr-review-gemini', 'auriga-review-gemini']) {
    assert.equal(out.AGENTS[n].available, false);
    assert.match(out.AGENTS[n].availabilityReason, /^auriga:gemini:3 runs failed in a row on the lane/);
    assert.ok(laneUnavailable(out.AGENTS[n]));
  }
  assert.equal(out.AGENTS['build-grok'].available, true);
  assert.equal(out.AGENTS['auriga-review'].available, true);
  assert.deepEqual(out.laneFailureHolds.map((h) => h.laneId), ['gemini']);
  assert.deepEqual(withLaneFailureHolds(CFG, new Map()).laneFailureHolds, []);
});

test('the store keeps lane holds for readers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-holds-'));
  const store = createRuntimeHealthStore(path.join(dir, 'runtime-health.json'));
  const state = recordRuns({}, geminiOutage(), NOW);
  store.write(state, [], NOW, laneFailureHolds(state, CFG, NOW).values());
  const back = store.read();
  assert.deepEqual(back.laneHolds.map((h) => h.laneId), ['gemini']);
  assert.equal(back.laneHolds[0].until, new Date(NOW - 9 * MIN + D.cooldownMs).toISOString());
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- review dispatch: a lane failure never blocks the ticket ----------------
const RCFG = {
  AGENTS: {
    'review-gemini': { id: 'GR', laneId: 'gemini', runtime: 'opencode', maxInflight: 5, available: true },
    'review-claude': { id: 'CR', laneId: 'claude', runtime: 'claude', maxInflight: 5, available: true },
  },
  REVIEW_LANE: ['review-gemini', 'review-claude'],
  CAPS: { reviewMaxAttempts: 5, perCycleReview: 1, zombieStaleMs: 30 * MIN },
};
const inReview = (identifier, assignee) => ({ identifier, id: `id-${identifier}`, project_id: 'p', status: 'in_review', assignee_id: assignee, created_at: new Date(NOW - 5 * 3600_000).toISOString() });
const failed = (agentId, minsAgo) => ({
  id: `f${++seq}`, agent_id: agentId, status: 'failed', error: 'opencode exited with error: exit status 1',
  created_at: new Date(NOW - (minsAgo + 1) * MIN).toISOString(), started_at: new Date(NOW - (minsAgo + 1) * MIN).toISOString(),
  completed_at: new Date(NOW - minsAgo * MIN).toISOString(),
});
const out = (cfg, name, reason) => ({ ...cfg, AGENTS: { ...cfg.AGENTS, [name]: { ...cfg.AGENTS[name], available: false, availabilityReason: reason } } });

test('a ticket held by a reviewer whose lane is out moves to a reviewer on a lane that is up', () => {
  const cfg = out(RCFG, 'review-gemini', 'auriga:gemini:3 runs failed in a row on the lane (FFE-2202, PANT-1006) until x');
  const i = inReview('PANT-1006', 'GR');
  const picks = selectReviewDispatch([i], { 'PANT-1006': [failed('GR', 40), failed('GR', 35)] }, cfg, {}, { now: NOW });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].action, 'dispatch-review');
  assert.equal(picks[0].agent, 'review-claude');
  assert.equal(picks[0].reason, 'assignee-lane-unavailable');
  assert.match(picks[0].availabilityReason, /^auriga:gemini:/);
});

test('PANT-706: five failures on a lane that is out never give up; it waits when no other reviewer is up', () => {
  const runs = { 'PANT-706': [50, 45, 40, 35, 31].map((m) => failed('GR', m)) };
  const geminiOut = out(RCFG, 'review-gemini', 'heimdall:gemini:down');
  const moved = selectReviewDispatch([inReview('PANT-706', 'GR')], runs, geminiOut, {}, { now: NOW });
  assert.deepEqual(moved.map((p) => [p.action, p.agent]), [['dispatch-review', 'review-claude']]);
  const bothOut = out(geminiOut, 'review-claude', 'heimdall:claude:out_of_credit');
  assert.deepEqual(selectReviewDispatch([inReview('PANT-706', 'GR')], runs, bothOut, {}, { now: NOW }), []);
});

test('five failures all on one lane (still up) try a reviewer on another lane before giving up', () => {
  const runs = { 'PANT-706': [50, 45, 40, 35, 31].map((m) => failed('GR', m)) };
  const picks = selectReviewDispatch([inReview('PANT-706', 'GR')], runs, RCFG, {}, { now: NOW });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].action, 'dispatch-review');
  assert.equal(picks[0].agent, 'review-claude');
  assert.equal(picks[0].reason, 'review-failed-on-one-lane');
  assert.equal(picks[0].failedLane, 'gemini');
  // Budget spent this cycle: wait for the next one, don't give up.
  assert.deepEqual(selectReviewDispatch([inReview('PANT-706', 'GR')], runs, RCFG, {}, { now: NOW, maxTotal: 0 }), []);
  // The other lane's reviewer is busy: wait too.
  assert.deepEqual(selectReviewDispatch([inReview('PANT-706', 'GR')], runs, RCFG, { 'review-claude': 5 }, { now: NOW }), []);
});

test('failures across two lanes still give up (the ticket, not a lane, is the problem)', () => {
  const runs = { 'PANT-706': [failed('GR', 50), failed('GR', 45), failed('GR', 40), failed('GR', 35), failed('CR', 31)] };
  const picks = selectReviewDispatch([inReview('PANT-706', 'CR')], runs, RCFG, {}, { now: NOW });
  assert.deepEqual(picks.map((p) => p.action), ['give-up-review']);
});

test('with a single review lane, the PANT-262 give-up is unchanged', () => {
  const one = { ...RCFG, REVIEW_LANE: ['review-gemini'] };
  const runs = { 'PANT-706': [50, 45, 40, 35, 31].map((m) => failed('GR', m)) };
  assert.deepEqual(selectReviewDispatch([inReview('PANT-706', 'GR')], runs, one, {}, { now: NOW }).map((p) => p.action), ['give-up-review']);
});
