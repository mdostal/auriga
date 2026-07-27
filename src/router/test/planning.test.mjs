import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as planning from '../lib/planning.mjs';

// Config fixture mirroring lib/config.mjs shape (planning-relevant slice).
const CFG = {
  AGENTS: {
    'consus-dev': { id: 'C', runtime: 'claude', maxInflight: 1 },
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'minerva-dev': { id: 'M', runtime: 'claude', maxInflight: 1 },
  },
  RUNTIME_CAP: { claude: 2, codex: 4 },
  PROJECT_IDS: ['CONSUS', 'AURIGA'],
  PLANNING: {
    agent: 'minerva-dev',
    seedLabels: ['idea', 'needs-plan', 'consus-idea'],
    plannedLabels: ['planned', 'epic', 'story'],
    seedFallback: false,
    maxPerCycle: 1,
  },
};

// id->name label map, mirroring what mca.listLabels() returns.
const LABELMAP = {
  'lbl-idea': 'idea',
  'lbl-needs-plan': 'needs-plan',
  'lbl-planned': 'planned',
};

const issue = (o) => ({
  id: o.id,
  identifier: o.id,
  project_id: o.project || 'CONSUS',
  number: o.number || 1,
  status: o.status || 'todo',
  assignee_id: o.assignee || null,
  parent_issue_id: o.parent || null,
  labels: o.labels || [],
  title: o.title || 'work',
});

const ctx = (issues, over = {}) =>
  planning.buildPlanningContext(issues, { ...CFG, PLANNING: { ...CFG.PLANNING, ...over } }, LABELMAP);

// ---- labelNamesOf: handles object / name-string / uuid-string labels --------
test('labelNamesOf normalizes object, name-string, and uuid-string labels', () => {
  assert.deepEqual(planning.labelNamesOf({ labels: [{ id: 'x', name: 'Idea' }] }, {}), ['idea']);
  assert.deepEqual(planning.labelNamesOf({ labels: ['Needs-Plan'] }, {}), ['needs-plan']);
  assert.deepEqual(planning.labelNamesOf({ labels: ['lbl-idea'] }, LABELMAP), ['idea']);
  assert.deepEqual(planning.labelNamesOf({ labels: [] }, {}), []);
  assert.deepEqual(planning.labelNamesOf({}, {}), []);
});

// ---- classifyPlanningRole ---------------------------------------------------
test('a top-level ticket labeled idea/needs-plan is a SEED', () => {
  const i1 = issue({ id: 's1', labels: [{ name: 'idea' }] });
  const i2 = issue({ id: 's2', labels: ['lbl-needs-plan'] });
  const c = ctx([i1, i2]);
  assert.equal(planning.classifyPlanningRole(i1, c), 'seed');
  assert.equal(planning.classifyPlanningRole(i2, c), 'seed');
});

test('a sub-issue (parent_issue_id set) is always a planned STORY', () => {
  const story = issue({ id: 'st1', parent: 'epic1', labels: [] });
  const c = ctx([story]);
  assert.equal(planning.classifyPlanningRole(story, c), 'story');
  assert.equal(planning.isBuildEligible(story, c), true);
});

test('a SEED that already has sub-issues is an EPIC container (skip), not re-planned', () => {
  const epic = issue({ id: 'e1', labels: [{ name: 'idea' }] });
  const child = issue({ id: 'c1', parent: 'e1' });
  const c = ctx([epic, child]);
  assert.equal(planning.classifyPlanningRole(epic, c), 'epic');
  assert.equal(planning.isBuildEligible(epic, c), false); // container never builds
});

test('an unmarked top-level ticket is OTHER (build lane) by default — no board hijack', () => {
  const t = issue({ id: 't1', labels: [] });
  const c = ctx([t]);
  assert.equal(planning.classifyPlanningRole(t, c), 'other');
  assert.equal(planning.isBuildEligible(t, c), true);
});

test('seedFallback ON treats an unmarked childless top-level ticket as a SEED', () => {
  const t = issue({ id: 't1', labels: [] });
  const c = ctx([t], { seedFallback: true });
  assert.equal(planning.classifyPlanningRole(t, c), 'seed');
  assert.equal(planning.isBuildEligible(t, c), false);
});

test('a planned-labeled ticket with children is an EPIC; without children is a STORY', () => {
  const epic = issue({ id: 'p1', labels: [{ name: 'planned' }] });
  const child = issue({ id: 'pc1', parent: 'p1' });
  const standalone = issue({ id: 'p2', labels: ['lbl-planned'] });
  const c = ctx([epic, child, standalone]);
  assert.equal(planning.classifyPlanningRole(epic, c), 'epic');
  assert.equal(planning.classifyPlanningRole(standalone, c), 'story');
});

// ---- selectPlanningAssignments ----------------------------------------------
test('selectPlanningAssignments routes a seed to minerva-dev', () => {
  const seed = issue({ id: 's1', number: 5, labels: [{ name: 'idea' }] });
  const noise = issue({ id: 'n1', number: 6, labels: [] }); // other -> build, not planning
  const issues = [seed, noise];
  const picks = planning.selectPlanningAssignments(issues, CFG, {}, ctx(issues));
  assert.equal(picks.length, 1);
  assert.equal(picks[0].identifier, 's1');
  assert.equal(picks[0].agent, 'minerva-dev');
  assert.equal(picks[0].role, 'seed');
  assert.equal(picks[0].lane, 'planning');
});

test('selectPlanningAssignments honors maxPerCycle (sparing Claude drain)', () => {
  const issues = [
    issue({ id: 's1', number: 1, labels: [{ name: 'idea' }] }),
    issue({ id: 's2', number: 2, labels: [{ name: 'idea' }] }),
  ];
  const picks = planning.selectPlanningAssignments(issues, CFG, {}, ctx(issues));
  assert.equal(picks.length, 1); // maxPerCycle = 1
  assert.equal(picks[0].identifier, 's1'); // lower number first
});

test('selectPlanningAssignments respects the planning agent inflight cap', () => {
  const issues = [issue({ id: 's1', labels: [{ name: 'idea' }] })];
  // minerva-dev already at maxInflight (1) -> no capacity -> no pick.
  const picks = planning.selectPlanningAssignments(issues, CFG, { 'minerva-dev': 1 }, ctx(issues));
  assert.equal(picks.length, 0);
});

test('selectPlanningAssignments ignores assigned, non-seed, out-of-scan, and smoke tickets', () => {
  const issues = [
    issue({ id: 'a1', labels: [{ name: 'idea' }], assignee: 'M' }),          // already assigned
    issue({ id: 'o1', labels: [] }),                                          // other, not a seed
    issue({ id: 'x1', labels: [{ name: 'idea' }], project: 'OFFSCAN' }),      // out of scan set
    issue({ id: 'sm', labels: [{ name: 'idea' }], title: 'SMOKE seed test' }),// smoke/scratch
    issue({ id: 'blk', labels: [{ name: 'idea' }], status: 'blocked' }),      // parked (exit-2), not todo
  ];
  const picks = planning.selectPlanningAssignments(issues, CFG, {}, ctx(issues));
  assert.equal(picks.length, 0);
});
