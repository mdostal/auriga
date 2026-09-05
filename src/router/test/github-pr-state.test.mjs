// Tests for lib/github-pr-state.mjs — the extracted GitHub PR-state enum +
// merge/close-timestamp normalization (GH #81's fix: detectVerifiedDone
// never fired on a real gh-CLI-shaped PR object because of a state/field
// casing mismatch this module now closes in one place, shared by
// detectVerifiedDone and detectFalseDone's merged-PR guard).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GITHUB_PR_STATE,
  PR_TIMESTAMP_FIELDS,
  prTimestamp,
  isPrOpen,
  isPrMerged,
} from '../lib/github-pr-state.mjs';

test('GITHUB_PR_STATE mirrors GitHub\'s real (uppercase) PullRequestState enum values', () => {
  assert.equal(GITHUB_PR_STATE.OPEN, 'OPEN');
  assert.equal(GITHUB_PR_STATE.CLOSED, 'CLOSED');
  assert.equal(GITHUB_PR_STATE.MERGED, 'MERGED');
  assert.ok(Object.isFrozen(GITHUB_PR_STATE), 'enum object must be frozen against accidental mutation');
});

test('PR_TIMESTAMP_FIELDS lists both real spellings for merged/closed timestamps', () => {
  assert.deepEqual(PR_TIMESTAMP_FIELDS.MERGED_AT, ['mergedAt', 'merged_at']);
  assert.deepEqual(PR_TIMESTAMP_FIELDS.CLOSED_AT, ['closedAt', 'closed_at']);
});

test('prTimestamp returns the first present field, or null when none are set', () => {
  assert.equal(prTimestamp({ mergedAt: 'x' }, PR_TIMESTAMP_FIELDS.MERGED_AT), 'x');
  assert.equal(prTimestamp({ merged_at: 'y' }, PR_TIMESTAMP_FIELDS.MERGED_AT), 'y');
  assert.equal(prTimestamp({ mergedAt: 'x', merged_at: 'y' }, PR_TIMESTAMP_FIELDS.MERGED_AT), 'x');
  assert.equal(prTimestamp({}, PR_TIMESTAMP_FIELDS.MERGED_AT), null);
});

test('isPrOpen: real gh-shaped uppercase states resolve correctly', () => {
  assert.equal(isPrOpen({ state: 'OPEN' }), true);
  assert.equal(isPrOpen({ state: 'MERGED' }), false);
  assert.equal(isPrOpen({ state: 'CLOSED' }), false);
});

test('isPrOpen: tolerant of lowercase/mixed-case state (back-compat with older fixtures)', () => {
  assert.equal(isPrOpen({ state: 'open' }), true);
  assert.equal(isPrOpen({ state: 'Merged' }), false);
});

test('isPrOpen: no state at all falls back to timestamp absence, either spelling', () => {
  assert.equal(isPrOpen({}), true);
  assert.equal(isPrOpen({ mergedAt: '2026-01-01' }), false);
  assert.equal(isPrOpen({ merged_at: '2026-01-01' }), false);
  assert.equal(isPrOpen({ closedAt: '2026-01-01' }), false);
  assert.equal(isPrOpen({ closed_at: '2026-01-01' }), false);
});

test('isPrMerged: real gh-CLI shape (uppercase state, camelCase mergedAt) — the literal GH #81 repro', () => {
  assert.equal(isPrMerged({ state: 'MERGED', mergedAt: '2026-09-01T00:06:57Z' }), true);
  assert.equal(isPrMerged({ state: 'OPEN', mergedAt: null }), false);
});

test('isPrMerged: either signal alone is sufficient (state OR a timestamp, either spelling)', () => {
  assert.equal(isPrMerged({ state: 'MERGED' }), true);
  assert.equal(isPrMerged({ mergedAt: '2026-01-01' }), true);
  assert.equal(isPrMerged({ merged_at: '2026-01-01' }), true);
  assert.equal(isPrMerged({}), false);
});

test('isPrMerged: tolerant of lowercase state (back-compat with older fixtures)', () => {
  assert.equal(isPrMerged({ state: 'merged' }), true);
});
