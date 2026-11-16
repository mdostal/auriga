// PANT-1025 (GH #254): a run that failed on a provider quota/limit is transient.
// It never counts toward reviewMaxAttempts/zombieMaxAttempts, the issue waits out
// the reset instead of re-dispatching every cycle, and a give-up comment quotes
// the real error instead of guessing a startup hang.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isQuotaFailure, countedRuns, quotaResetAtMs, quotaHoldUntilMs, diagnoseFailedRuns,
} from '../lib/run-classification.mjs';
import * as core from '../lib/core.mjs';

const SESSION_LIMIT = "You've hit your session limit · resets 9:20pm (UTC)";
const MIN = 60_000;
// 18:56Z on 2026-10-11, just after PANT-1019's fifth failed review run.
const NOW = Date.parse('2026-10-11T18:56:28Z');

const failedRun = (agentId, at, error = SESSION_LIMIT, extra = {}) => ({
  agent_id: agentId, status: 'failed', error, failure_reason: 'agent_error.unknown',
  created_at: new Date(at).toISOString(), completed_at: new Date(at + 1000).toISOString(), ...extra,
});
// The live PANT-1019 fixture: 5 session-limit review failures in ~7 minutes.
const sessionLimitRuns = (agentId) => [0, 1, 2, 3, 4].map((k) => failedRun(agentId, NOW - (8 - k * 1.4) * MIN));

const CFG = {
  AGENTS: {
    'auriga-build': { id: 'AB', runtime: 'claude', maxInflight: 2 },
    'auriga-review': { id: 'RV', runtime: 'claude-review', maxInflight: 1 },
  },
  REVIEW_LANE: ['auriga-review'],
  HIVE_LANE: [],
  PROJECT_NAMES: { P: 'Proj' },
  CAPS: {
    perCycleReview: 1, reviewMaxAttempts: 5, reviewFairnessMaxAttempts: 3,
    zombieMaxAttempts: 3, zombieStaleMs: 30 * MIN, redispatchCooldownMs: 15 * MIN,
  },
};
const issue = (identifier, status, assignee) => ({
  id: `id-${identifier}`, identifier, status, assignee_id: assignee, project_id: 'P',
  labels: ['not-a-seed'], metadata: {}, title: identifier, description: '',
});

test('isQuotaFailure: provider limit errors match; ordinary failures and successes do not', () => {
  for (const error of [SESSION_LIMIT, 'Claude AI usage limit reached', 'HTTP 429 Too Many Requests', 'rate_limit_error', 'lane out_of_credit', 'Your credit balance is too low']) {
    assert.equal(isQuotaFailure(failedRun('RV', NOW, error), NOW), true, error);
  }
  assert.equal(isQuotaFailure(failedRun('RV', NOW, 'x', { failure_reason: 'out_of_credit' }), NOW), true);
  assert.equal(isQuotaFailure(failedRun('RV', NOW, 'tests failed: 3 assertions'), NOW), false);
  assert.equal(isQuotaFailure({ status: 'failed', error: null }, NOW), false);
  assert.equal(isQuotaFailure({ status: 'completed', error: null, result: { output: 'hit the usage limit section' } }, NOW), false);
});

test('countedRuns drops quota failures only', () => {
  const runs = [...sessionLimitRuns('RV'), failedRun('RV', NOW, 'boom'), { status: 'completed', agent_id: 'RV' }];
  assert.equal(countedRuns(runs, NOW).length, 2);
});

test('quotaResetAtMs: parses the UTC reset time as the next occurrence after the failure', () => {
  assert.equal(quotaResetAtMs(failedRun('RV', NOW)), Date.parse('2026-10-11T21:20:00Z'));
  const lateFailure = failedRun('RV', Date.parse('2026-10-11T22:00:00Z'));
  assert.equal(quotaResetAtMs(lateFailure), Date.parse('2026-10-12T21:20:00Z'));
  assert.equal(quotaResetAtMs(failedRun('RV', NOW, 'HTTP 429')), null);
});

test('quotaHoldUntilMs: holds until the stated reset, else the cooldown; 0 once past or not a quota failure', () => {
  assert.equal(quotaHoldUntilMs(sessionLimitRuns('RV'), NOW, 15 * MIN), Date.parse('2026-10-11T21:20:00Z'));
  assert.equal(quotaHoldUntilMs(sessionLimitRuns('RV'), Date.parse('2026-10-11T21:21:00Z'), 15 * MIN), 0);
  const r429 = [failedRun('RV', NOW - MIN, 'HTTP 429')];
  assert.equal(quotaHoldUntilMs(r429, NOW, 15 * MIN), NOW - MIN + 1000 + 15 * MIN);
  assert.equal(quotaHoldUntilMs(r429, NOW + 20 * MIN, 15 * MIN), 0);
  assert.equal(quotaHoldUntilMs([failedRun('RV', NOW - MIN, 'boom')], NOW, 15 * MIN), 0);
  assert.equal(quotaHoldUntilMs([], NOW, 15 * MIN), 0);
});

test('diagnoseFailedRuns: quotes the newest real error; hang only with no error and no output', () => {
  const errs = [failedRun('RV', NOW - 2 * MIN, 'old error'), failedRun('RV', NOW - MIN, 'npm ERR! missing script: test'), failedRun('RV', NOW - 3 * MIN, 'npm ERR! missing script: test')];
  assert.deepEqual(diagnoseFailedRuns(errs), { kind: 'error', error: 'npm ERR! missing script: test', count: 2, total: 3 });
  const silent = [0, 1].map((k) => ({ agent_id: 'RV', status: 'running', created_at: new Date(NOW - (60 + k) * MIN).toISOString(), usage: [{ output_tokens: 0 }] }));
  assert.equal(diagnoseFailedRuns(silent).kind, 'hang');
  const talked = [{ agent_id: 'RV', status: 'running', created_at: new Date(NOW - 60 * MIN).toISOString(), usage: JSON.stringify([{ output_tokens: 900 }]) }];
  assert.equal(diagnoseFailedRuns(talked).kind, 'unknown');
});

test('selectReviewDispatch: 5 session-limit review failures neither give up nor re-dispatch before the reset', () => {
  const i = issue('PANT-1019', 'in_review', 'RV');
  const picks = core.selectReviewDispatch([i], { 'PANT-1019': sessionLimitRuns('RV') }, CFG, {}, { now: NOW });
  assert.deepEqual(picks, []);
});

test('selectReviewDispatch: after the reset the review is re-run, still with no give-up', () => {
  const i = issue('PANT-1019', 'in_review', 'RV');
  const after = Date.parse('2026-10-11T21:21:00Z');
  const picks = core.selectReviewDispatch([i], { 'PANT-1019': sessionLimitRuns('RV') }, CFG, {}, { now: after });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].action, 'rerun-review');
});

test('selectReviewDispatch: a give-up after real failures carries a diagnosis quoting the error', () => {
  const i = issue('PANT-9', 'in_review', 'RV');
  const runs = [0, 1, 2, 3, 4].map((k) => failedRun('RV', NOW - (60 + k) * MIN, 'fatal: repository not found'));
  const [pick] = core.selectReviewDispatch([i], { 'PANT-9': [...sessionLimitRuns('RV').map((r) => ({ ...r, created_at: new Date(NOW - 90 * MIN).toISOString(), completed_at: new Date(NOW - 90 * MIN).toISOString() })), ...runs] }, CFG, {}, { now: NOW });
  assert.equal(pick.action, 'give-up-review');
  assert.deepEqual(pick.diagnosis, { kind: 'error', error: 'fatal: repository not found', count: 5, total: 5 });
});

test('detectZombies: quota failures do not count toward zombieMaxAttempts and hold off the rerun', () => {
  const i = issue('PANT-77', 'in_progress', 'AB');
  const runs = [0, 1, 2, 3].map((k) => failedRun('AB', NOW - (4 - k) * MIN));
  assert.deepEqual(core.detectZombies([i], { 'PANT-77': runs }, CFG, NOW), []);
  const after = core.detectZombies([i], { 'PANT-77': runs }, CFG, Date.parse('2026-10-11T21:21:00Z'));
  assert.equal(after.length, 1);
  assert.equal(after[0].action, 'rerun');
});
