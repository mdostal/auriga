// PANT-684: detect `todo` issues stuck on an archived/removed agent and
// return unassign actions so they can re-enter the normal candidate pool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

const CFG = {
  AGENTS: {
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'minerva-dev': { id: 'M', runtime: 'opencode', maxInflight: 3 },
  },
  RUNTIME_CAP: { codex: 4, opencode: 3 },
  PROJECT_IDS: ['proj-1'],
  PROJECT_NAMES: { 'proj-1': 'test-project' },
  CAPS: { assignedIdleStaleMs: 10 * 60 * 1000 },
  HUMAN_NAMES: [],
};

const ARCHIVED_ID = 'ARCHIVED-AGENT-ID'; // not in CFG.AGENTS

function todoIssue(id, assigneeId, opts = {}) {
  return {
    id, identifier: id, status: 'todo', assignee_id: assigneeId,
    title: opts.title ?? 'some work',
    project_id: opts.project_id ?? 'proj-1',
    parent_issue_id: 'parent-seed',
    metadata: opts.metadata ?? {},
    labels: opts.labels ?? [],
    priority: opts.priority ?? 0,
  };
}

const KNOWN_IDS = core.agentIdSet(CFG.AGENTS);

test('PANT-684 AC1: todo issue assigned to an archived agent is detected', () => {
  const issues = [todoIssue('PANT-185', ARCHIVED_ID)];
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].identifier, 'PANT-185');
  assert.equal(actions[0].action, 'unassign');
  assert.equal(actions[0].reason, 'archived-agent');
  assert.equal(actions[0].assigneeId, ARCHIVED_ID);
});

test('PANT-684 AC2: todo issue assigned to a known/live agent is NOT detected', () => {
  const issues = [todoIssue('PANT-1', 'A')]; // A is in KNOWN_IDS
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions.length, 0, 'live-agent issue must not be flagged for unassign');
});

test('PANT-684 AC3: unassigned todo issues are not touched', () => {
  const issues = [{ ...todoIssue('PANT-1', null), assignee_id: null }];
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions.length, 0);
});

test('PANT-684 AC4: multiple archived-agent issues all get unassign actions', () => {
  const issues = [
    todoIssue('PANT-185', ARCHIVED_ID),
    todoIssue('PANT-189', ARCHIVED_ID),
    todoIssue('PANT-200', 'ANOTHER-ARCHIVED'),
  ];
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions.length, 3);
  assert.ok(actions.every((a) => a.action === 'unassign' && a.reason === 'archived-agent'));
});

test('PANT-684 AC5: non-todo statuses are skipped', () => {
  const inProgress = { ...todoIssue('PANT-1', ARCHIVED_ID), status: 'in_progress' };
  const done = { ...todoIssue('PANT-2', ARCHIVED_ID), status: 'done' };
  const todo = todoIssue('PANT-3', ARCHIVED_ID);
  const actions = core.detectArchivedAssignments([inProgress, done, todo], CFG, KNOWN_IDS);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].identifier, 'PANT-3');
});

test('PANT-684 AC6: smoke/scratch issues are skipped', () => {
  const smoke = todoIssue('PANT-smoke', ARCHIVED_ID, { title: '[smoke] check health' });
  const scratch = todoIssue('PANT-scratch', ARCHIVED_ID, { title: '[scratch] experiment' });
  const normal = todoIssue('PANT-normal', ARCHIVED_ID);
  const actions = core.detectArchivedAssignments([smoke, scratch, normal], CFG, KNOWN_IDS);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].identifier, 'PANT-normal');
});

test('PANT-684 AC7: agent-parked issues are skipped', () => {
  const parked = {
    ...todoIssue('PANT-parked', ARCHIVED_ID),
    metadata: { blocked_reason: 'waiting for human' },
  };
  const actions = core.detectArchivedAssignments([parked], CFG, KNOWN_IDS);
  assert.equal(actions.length, 0, 'agent-parked issue must not be unassigned');
});

test('PANT-684 AC8: lane is resolved from PROJECT_NAMES', () => {
  const issues = [todoIssue('PANT-185', ARCHIVED_ID, { project_id: 'proj-1' })];
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions[0].lane, 'test-project');
});

test('PANT-684 AC9: issue from a project not in cfg falls back to project_id for lane', () => {
  const issues = [todoIssue('PANT-185', ARCHIVED_ID, { project_id: 'unknown-proj' })];
  const actions = core.detectArchivedAssignments(issues, CFG, KNOWN_IDS);
  assert.equal(actions[0].lane, 'unknown-proj');
});
