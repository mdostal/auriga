import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHumanQueue } from './export-human-queue.mjs';

const CFG = {
  PROJECT_IDS: ['AURIGA'],
  PROJECT_NAMES: { AURIGA: 'Auriga' },
  HUMAN_NAMES: ['mathew', 'dostal'],
};

const todo = (id, overrides = {}) => ({
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

test('buildHumanQueue: includes only human-todos from the dispatch scan scope', () => {
  const issues = [
    todo('h1', { labels: ['human-todo'] }),
    todo('h2', { metadata: { waiting_on: 'Mathew' } }),
    todo('a1'), // ordinary todo -> not in the human queue
    todo('a2', { labels: ['human-todo'], assignee_id: 'someone' }), // already assigned -> not a dispatch candidate
    { ...todo('a3', { project_id: 'OTHER' }), labels: ['human-todo'] }, // out of scan scope -> excluded
  ];
  const entries = buildHumanQueue(issues, CFG);
  assert.deepEqual(entries.map((e) => e.identifier).sort(), ['h1', 'h2']);
  const byId = Object.fromEntries(entries.map((e) => [e.identifier, e]));
  assert.equal(byId.h1.reason, 'label');
  assert.equal(byId.h2.reason, 'waiting_on');
  assert.equal(byId.h2.waitingOn, 'Mathew');
  assert.equal(byId.h1.project, 'Auriga');
});

test('buildHumanQueue: empty when no human-todos are present', () => {
  const issues = [todo('a1'), todo('a2')];
  assert.deepEqual(buildHumanQueue(issues, CFG), []);
});
