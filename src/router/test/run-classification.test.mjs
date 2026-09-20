// Tests for lib/run-classification.mjs (t011 decomposition) — exercised
// directly against the module's own public API, independent of whether
// core.mjs's re-export happens to work (core.test.mjs already covers these
// functions extensively via that re-export; this file is the module's own
// direct contract test).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRun, hasActiveRun, latestRun } from '../lib/run-classification.mjs';

test('classifyRun: a running run with no completed_at is active, not done, not failed', () => {
  const c = classifyRun({ status: 'running', started_at: new Date().toISOString() });
  assert.equal(c.active, true);
  assert.equal(c.done, false);
  assert.equal(c.failed, false);
});

test('classifyRun: completed_at or a done/completed/succeeded status marks done (and not active)', () => {
  assert.equal(classifyRun({ status: 'running', completed_at: new Date().toISOString() }).done, true);
  assert.equal(classifyRun({ status: 'done' }).done, true);
  assert.equal(classifyRun({ status: 'completed' }).done, true);
  assert.equal(classifyRun({ status: 'succeeded' }).done, true);
  assert.equal(classifyRun({ status: 'done' }).active, false);
});

test('classifyRun: a failed-status run, or one carrying a non-empty error, is failed', () => {
  assert.equal(classifyRun({ status: 'failed' }).failed, true);
  assert.equal(classifyRun({ status: 'errored' }).failed, true);
  assert.equal(classifyRun({ status: 'running', error: 'boom' }).failed, true);
  assert.equal(classifyRun({ status: 'running', error: '' }).failed, false);
});

test('classifyRun: ageMs is computed from the best available timestamp, Infinity when none exist', () => {
  const now = Date.now();
  const c = classifyRun({ status: 'running', started_at: new Date(now - 5000).toISOString() }, now);
  assert.ok(c.ageMs >= 4900 && c.ageMs <= 5100);
  assert.equal(classifyRun({ status: 'running' }, now).ageMs, Infinity);
});

test('hasActiveRun: true only when a run is both active AND fresher than staleMs', () => {
  const now = Date.now();
  const fresh = [{ status: 'running', started_at: new Date(now - 1000).toISOString() }];
  const stale = [{ status: 'running', started_at: new Date(now - 30 * 60 * 1000).toISOString() }];
  assert.equal(hasActiveRun(fresh, now, 20 * 60 * 1000), true);
  assert.equal(hasActiveRun(stale, now, 20 * 60 * 1000), false);
  assert.equal(hasActiveRun([], now, 20 * 60 * 1000), false);
});

test('latestRun: picks the most recently created/dispatched run; null on empty', () => {
  const runs = [
    { id: 'old', created_at: '2026-01-01T00:00:00Z' },
    { id: 'new', created_at: '2026-06-01T00:00:00Z' },
  ];
  assert.equal(latestRun(runs).id, 'new');
  assert.equal(latestRun([]), null);
});
