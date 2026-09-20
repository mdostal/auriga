// Tests for lib/issue-status.mjs -- the extracted issue-status constants
// (t009 dedupe), closing the same "no hardcoded strings" pattern already
// applied to GitHub's PR-state enum (see github-pr-state.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ISSUE_STATUS, ISSUE_STATUS_ALT_SPELLINGS, isTerminalIssueStatus } from '../lib/issue-status.mjs';

test('ISSUE_STATUS is frozen against accidental mutation', () => {
  assert.ok(Object.isFrozen(ISSUE_STATUS));
  assert.ok(Object.isFrozen(ISSUE_STATUS_ALT_SPELLINGS));
});

test('ISSUE_STATUS carries every value this router has relied on', () => {
  assert.equal(ISSUE_STATUS.TODO, 'todo');
  assert.equal(ISSUE_STATUS.BLOCKED, 'blocked');
  assert.equal(ISSUE_STATUS.IN_PROGRESS, 'in_progress');
  assert.equal(ISSUE_STATUS.IN_REVIEW, 'in_review');
  assert.equal(ISSUE_STATUS.DONE, 'done');
  assert.equal(ISSUE_STATUS.CANCELLED, 'cancelled');
  assert.equal(ISSUE_STATUS.CANCELED, 'canceled');
  assert.equal(ISSUE_STATUS.SHIPPED, 'shipped');
  assert.equal(ISSUE_STATUS.COMPLETE, 'complete');
  assert.equal(ISSUE_STATUS.PENDING, 'pending');
  assert.equal(ISSUE_STATUS.RUNNING, 'running');
  assert.equal(ISSUE_STATUS_ALT_SPELLINGS.IN_PROGRESS_SPACED, 'in progress');
});

test('isTerminalIssueStatus: true for done, cancelled, and canceled', () => {
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.DONE), true);
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.CANCELLED), true);
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.CANCELED), true);
});

test('isTerminalIssueStatus: false for every non-terminal status, including empty/undefined', () => {
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.TODO), false);
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.IN_PROGRESS), false);
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.IN_REVIEW), false);
  assert.equal(isTerminalIssueStatus(ISSUE_STATUS.BLOCKED), false);
  assert.equal(isTerminalIssueStatus(''), false);
  assert.equal(isTerminalIssueStatus(undefined), false);
});
