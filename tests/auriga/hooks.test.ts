import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCheckNextSliceTicket,
  runCompletionHook,
  shouldCreateCheckNextSliceTicket,
} from '../../src/auriga/hooks.ts';

const epic = {
  id: 'epic-1',
  identifier: 'PAN-100',
  title: '[slice-2] Auriga delivery epic',
  project_id: 'project-auriga',
  metadata: {},
};

const doneChild = (id: string) => ({
  id,
  identifier: `PAN-${id}`,
  title: `[story-${id}] Build thing`,
  status: 'done',
  parent_issue_id: epic.id,
  project_id: epic.project_id,
});

test('shouldCreateCheckNextSliceTicket fires when every delivery child is closed', () => {
  const decision = shouldCreateCheckNextSliceTicket(epic, [
    doneChild('1'),
    doneChild('2'),
  ]);

  assert.deepEqual(decision, {
    create: true,
    reason: 'delivery-epic-complete',
  });
});

test('shouldCreateCheckNextSliceTicket waits while a delivery child is still open', () => {
  const decision = shouldCreateCheckNextSliceTicket(epic, [
    doneChild('1'),
    { ...doneChild('2'), status: 'in_review' },
  ]);

  assert.deepEqual(decision, {
    create: false,
    reason: 'delivery-children-still-open',
  });
});

test('shouldCreateCheckNextSliceTicket is idempotent for an already filed check ticket', () => {
  const decision = shouldCreateCheckNextSliceTicket(
    epic,
    [doneChild('1')],
    [{
      id: 'follow-up-1',
      title: '[check-next-slice] Auriga after PAN-100',
      description: 'source_epic_id: epic-1',
      status: 'todo',
      project_id: epic.project_id,
      metadata: {},
    }],
  );

  assert.deepEqual(decision, {
    create: false,
    reason: 'check-next-slice-already-filed',
  });
});

test('shouldCreateCheckNextSliceTicket skips planning/no-op epics to prevent loops', () => {
  const planningEpic = {
    ...epic,
    title: '[check-next-slice] Auriga after PAN-100',
    metadata: { auriga_completion_state: 'no_op' },
  };

  const decision = shouldCreateCheckNextSliceTicket(planningEpic, [doneChild('1')]);

  assert.deepEqual(decision, {
    create: false,
    reason: 'planning-or-terminal-epic',
  });
});

test('buildCheckNextSliceTicket targets the completed project and re-invokes sweep logic', () => {
  const ticket = buildCheckNextSliceTicket(epic, 'Auriga');

  assert.equal(ticket.title, '[check-next-slice] Auriga after PAN-100');
  assert.equal(ticket.projectId, 'project-auriga');
  assert.equal(ticket.status, 'todo');
  assert.match(ticket.description, /target_project_id: project-auriga/);
  assert.match(ticket.description, /Auriga sweep logic for Auriga/);
  assert.match(ticket.description, /queue the next-slice generation job/);
  assert.match(ticket.description, /auriga_completion_state=no_op/);
});

test('runCompletionHook creates one check-next-slice ticket and pins source metadata', () => {
  const created: unknown[] = [];
  const metadata: unknown[] = [];
  const result = runCompletionHook(
    {
      id: 'story-2',
      identifier: 'PAN-102',
      status: 'done',
      parent_issue_id: epic.id,
      project_id: epic.project_id,
    },
    {
      getIssue: () => epic,
      listChildren: () => [doneChild('1'), doneChild('2')],
      listProjectIssues: () => [],
      createIssue: (input) => {
        created.push(input);
        return { id: 'ticket-1', identifier: 'PAN-200', title: input.title, project_id: input.projectId };
      },
      setIssueMetadata: (issueId, key, value) => metadata.push({ issueId, key, value }),
    },
    { 'project-auriga': 'Auriga' },
  );

  assert.deepEqual(result, {
    action: 'created',
    reason: 'delivery-epic-complete',
    sourceEpicId: 'epic-1',
    ticketIdentifier: 'PAN-200',
    ticketId: 'ticket-1',
  });
  assert.equal(created.length, 1);
  assert.deepEqual(metadata, [
    { issueId: 'ticket-1', key: 'source_epic_id', value: 'epic-1' },
    { issueId: 'ticket-1', key: 'source_epic_identifier', value: 'PAN-100' },
    { issueId: 'ticket-1', key: 'target_project_id', value: 'project-auriga' },
  ]);
});
