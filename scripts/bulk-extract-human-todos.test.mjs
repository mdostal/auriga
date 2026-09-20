import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExtractionReport,
  isHumanTodoBroad,
  humanTodoReasonBroad,
  buildNotificationMessage,
  notifyOperator,
} from './bulk-extract-human-todos.mjs';

const CFG = {
  PROJECT_NAMES: { AURIGA: 'Auriga' },
  HUMAN_NAMES: ['mathew', 'dostal'],
  HUMAN_OPERATOR_MEMBER_ID: 'operator-uuid-123',
};

const issue = (id, overrides = {}) => ({
  id,
  identifier: id,
  project_id: 'AURIGA',
  status: 'todo',
  assignee_id: null,
  title: 'work',
  labels: [],
  metadata: {},
  ...overrides,
});

test('isHumanTodoBroad: detects a title-only match with no label and no waiting_on (PAN-6644 shape)', () => {
  const pan6644 = issue('PAN-6644', {
    title: 'HUMAN TODO (Mathew): re-export and feed the Gemini chat history...',
    labels: [],
    metadata: {},
  });
  assert.equal(isHumanTodoBroad(pan6644, CFG), true);
  assert.equal(humanTodoReasonBroad(pan6644, CFG), 'title');
});

test('isHumanTodoBroad: detects label-only match and delegates reason to core', () => {
  const i = issue('h1', { labels: ['human-todo'] });
  assert.equal(isHumanTodoBroad(i, CFG), true);
  assert.equal(humanTodoReasonBroad(i, CFG), 'label');
});

test('isHumanTodoBroad: detects waiting_on-only match and delegates reason to core', () => {
  const i = issue('h2', { metadata: { waiting_on: 'Mathew' } });
  assert.equal(isHumanTodoBroad(i, CFG), true);
  assert.equal(humanTodoReasonBroad(i, CFG), 'waiting_on');
});

test('isHumanTodoBroad: a normal non-human issue is excluded', () => {
  const i = issue('a1', { title: 'Implement rate-floor filter' });
  assert.equal(isHumanTodoBroad(i, CFG), false);
});

test('buildExtractionReport: smoke/scratch titles are excluded even if they would otherwise match', () => {
  const i = issue('s1', { title: 'HUMAN TODO smoke test scratch harness', labels: ['human-todo'] });
  const report = buildExtractionReport([i], CFG);
  assert.deepEqual(report.entries, []);
});

test('buildExtractionReport: bucketing — already_excluded_count (blocked/cancelled) vs needs_attention_count (todo/in_progress)', () => {
  const issues = [
    issue('b1', { status: 'blocked', labels: ['human-todo'] }),
    issue('b2', { status: 'cancelled', metadata: { waiting_on: 'Dostal' } }),
    issue('t1', { status: 'todo', labels: ['human-todo'] }),
    issue('t2', { status: 'in_progress', title: 'HUMAN TODO (Mathew): something' }),
    issue('d1', { status: 'done', labels: ['human-todo'] }), // neither bucket
  ];
  const report = buildExtractionReport(issues, CFG);
  assert.equal(report.entries.length, 5);
  assert.equal(report.already_excluded_count, 2);
  assert.equal(report.needs_attention_count, 2);
});

test('buildExtractionReport: applyEligible is only true for status=todo, not-yet-labeled matches', () => {
  const issues = [
    issue('t1', { status: 'todo', labels: ['human-todo'] }), // already labeled -> not eligible
    issue('t2', { status: 'todo', title: 'HUMAN TODO (Mathew): something' }), // todo, unlabeled -> eligible
    issue('ip1', { status: 'in_progress', metadata: { waiting_on: 'Mathew' } }), // not todo -> not eligible
    issue('bl1', { status: 'blocked', labels: ['human-todo'] }), // not todo -> not eligible
  ];
  const report = buildExtractionReport(issues, CFG);
  const byId = Object.fromEntries(report.entries.map((e) => [e.identifier, e]));
  assert.equal(byId.t1.applyEligible, false);
  assert.equal(byId.t2.applyEligible, true);
  assert.equal(byId.ip1.applyEligible, false);
  assert.equal(byId.bl1.applyEligible, false);
});

test('buildExtractionReport: resolves project name via cfg.PROJECT_NAMES, falls back to raw project_id for unknown ids', () => {
  const issues = [
    issue('k1', { project_id: 'AURIGA', labels: ['human-todo'] }),
    issue('k2', { project_id: 'some-unmapped-project-uuid', labels: ['human-todo'] }),
  ];
  const report = buildExtractionReport(issues, CFG);
  const byId = Object.fromEntries(report.entries.map((e) => [e.identifier, e]));
  assert.equal(byId.k1.project, 'Auriga');
  assert.equal(byId.k2.project, 'some-unmapped-project-uuid');
});

test('buildExtractionReport: empty when no human-todos are present on the board', () => {
  const issues = [issue('a1'), issue('a2', { title: 'Fix the login redirect' })];
  const report = buildExtractionReport(issues, CFG);
  assert.deepEqual(report.entries, []);
  assert.equal(report.already_excluded_count, 0);
  assert.equal(report.needs_attention_count, 0);
});

test('buildExtractionReport: notifyEligible is true for todo/in_progress not-yet-labeled matches, false once labeled or terminal', () => {
  const issues = [
    issue('t1', { status: 'todo', title: 'HUMAN TODO (Mathew): something' }), // unlabeled, todo -> eligible
    issue('t2', { status: 'todo', labels: ['human-todo'] }), // already labeled -> not eligible (already surfaced)
    issue('ip1', { status: 'in_progress', metadata: { waiting_on: 'Mathew' } }), // unlabeled, in_progress -> eligible
    issue('bl1', { status: 'blocked', title: 'HUMAN TODO (Mathew): something' }), // blocked -> not eligible (not exposed)
  ];
  const report = buildExtractionReport(issues, CFG);
  const byId = Object.fromEntries(report.entries.map((e) => [e.identifier, e]));
  assert.equal(byId.t1.notifyEligible, true);
  assert.equal(byId.t2.notifyEligible, false);
  assert.equal(byId.ip1.notifyEligible, true);
  assert.equal(byId.bl1.notifyEligible, false);
});

test('buildNotificationMessage: includes a real member mention, the detection reason, and the report path', () => {
  const entry = { identifier: 'PAN-6644', status: 'todo', reason: 'title' };
  const msg = buildNotificationMessage(entry, 'operator-uuid-123');
  assert.match(msg, /mention:\/\/member\/operator-uuid-123/);
  assert.match(msg, /reason: `title`/);
  assert.match(msg, /todo/);
  assert.match(msg, /human-todo-extraction-report\.yaml/);
});

test('notifyOperator: posts one comment per notifyEligible entry via mca.postComment, skips ineligible ones, returns notified identifiers', () => {
  const issues = [
    issue('t1', { status: 'todo', title: 'HUMAN TODO (Mathew): something' }), // eligible
    issue('t2', { status: 'todo', labels: ['human-todo'] }), // already labeled -> not eligible
    issue('d1', { status: 'done', labels: ['human-todo'] }), // terminal -> not a report entry at all
  ];
  const report = buildExtractionReport(issues, CFG);
  const calls = [];
  const fakeMca = { postComment: (identifier, body) => calls.push({ identifier, body }) };

  const notified = notifyOperator(report, CFG, fakeMca);

  assert.deepEqual(notified, ['t1']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].identifier, 't1');
  assert.match(calls[0].body, /mention:\/\/member\/operator-uuid-123/);
});
