// Tests for lib/adapters/spawn-dispatch.mjs -- the shared dispatch()/
// describeLanes() logic factored out of multica/spawn.mjs and
// pantheon-v2-l2/index.mjs (t013 dedupe). Exercises the pure factory
// functions directly against fake assignIssue/rerunIssue/getIssueRuns, not
// against a real adapter (both real adapters' own test suites already
// cover dispatch()/describeLanes() end-to-end through this module).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeDispatch, makeDescribeLanes } from '../lib/adapters/spawn-dispatch.mjs';

test('makeDescribeLanes: returns the injected lane map unchanged, under the expected keys', () => {
  const describeLanes = makeDescribeLanes({
    projectLane: { p1: ['a'] }, defaultLane: ['d'], hiveLane: ['h'],
    reviewLane: ['r'], runtimeCap: { claude: 5 },
  });
  assert.deepEqual(describeLanes(), {
    projectLane: { p1: ['a'] }, defaultLane: ['d'], hiveLane: ['h'],
    reviewLane: ['r'], runtimeCap: { claude: 5 },
  });
});

test('makeDispatch: an assign failure short-circuits before sleeping or verifying', () => {
  const sleepCalls = [];
  const dispatch = makeDispatch({
    assignIssue: () => { throw new Error('assign boom'); },
    rerunIssue: () => { throw new Error('should never be called'); },
    getIssueRuns: () => { throw new Error('should never be called'); },
    sleep: (ms) => sleepCalls.push(ms),
    verifyDelayMs: 6000,
  });

  const result = dispatch({ identifier: 'PAN-1' }, 'auriga-dev');

  assert.deepEqual(result, {
    identifier: 'PAN-1', lane: 'auriga-dev', assigned: false,
    assignError: 'assign boom', started: false, forcedRerun: false,
  });
  assert.deepEqual(sleepCalls, [], 'must never sleep when assign itself fails');
});

test('makeDispatch: a started run (any active/done/failed row) does not force-rerun', () => {
  const now = Date.now();
  const sleepCalls = [];
  const dispatch = makeDispatch({
    assignIssue: () => ({ ok: true }),
    rerunIssue: () => { throw new Error('should never be called'); },
    getIssueRuns: () => [{ status: 'in_progress', started_at: new Date(now).toISOString(), runtime_id: 'rt-1' }],
    sleep: (ms) => sleepCalls.push(ms),
    verifyDelayMs: 6000,
  });

  const result = dispatch({ identifier: 'PAN-2' }, 'auriga-dev');

  assert.equal(result.assigned, true);
  assert.equal(result.started, true);
  assert.equal(result.forcedRerun, false);
  assert.equal(result.runtimeId, 'rt-1');
  assert.deepEqual(sleepCalls, [6000], 'must sleep exactly verifyDelayMs after assign, before verifying');
});

test('makeDispatch: no run row within the verify delay force-reruns, catching (not propagating) a rerun failure', () => {
  const dispatch = makeDispatch({
    assignIssue: () => ({ ok: true }),
    rerunIssue: () => { throw new Error('rerun boom'); },
    getIssueRuns: () => [],
    sleep: () => {},
    verifyDelayMs: 6000,
  });

  const result = dispatch({ identifier: 'PAN-3' }, 'auriga-dev');

  assert.equal(result.assigned, true);
  assert.equal(result.started, false);
  assert.equal(result.forcedRerun, true);
  assert.equal(result.rerunError, 'rerun boom');
});
