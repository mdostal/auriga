import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from '../lib/core.mjs';

// Minimal config fixture mirroring lib/config.mjs shape.
const CFG = {
  AGENTS: {
    'consus-dev': { id: 'C', runtime: 'claude', maxInflight: 2 },
    'heimdall-dev': { id: 'H', runtime: 'opencode', maxInflight: 3 },
    'auriga-dev': { id: 'A', runtime: 'codex', maxInflight: 3 },
    'heimdall-dev-codex': { id: 'HC', runtime: 'codex', maxInflight: 3 },
    'auriga-build': { id: 'AB', runtime: 'claude', maxInflight: 2 },
    'mnemosyne-dev': { id: 'MN', runtime: 'claude', maxInflight: 2 },
    'votum-dev': { id: 'VT', runtime: 'claude', maxInflight: 2 },
    // Planning lane fixture mirroring lib/config.mjs's minerva-dev entry:
    // deliberately absent from RUNTIME_CAP below (own uncapped runtime bucket).
    'minerva-dev': { id: 'M', runtime: 'claude-planning', maxInflight: 3 },
    // BACK-HALF review/ship lane fixture (mirrors config.mjs auriga-review):
    // own capacity bucket, maxInflight 1 (one review at a time).
    'auriga-review': { id: 'RV', runtime: 'claude-review', maxInflight: 1 },
  },
  RUNTIME_CAP: { claude: 2, opencode: 3, codex: 4, 'claude-review': 1 },
  REVIEW_LANE: ['auriga-review'],
  PROJECT_LANE: {
    CONSUS: ['consus-dev'],
    HEIMDALL: ['heimdall-dev', 'heimdall-dev-codex'],
    AURIGA: ['auriga-dev'],
    MINERVA: ['auriga-dev'],
    PCORE: ['auriga-build'], // Pantheon Core: decomposed non-seed stories -> claude+hive build lane
  },
  DEFAULT_LANE: ['auriga-dev', 'heimdall-dev-codex'],
  HIVE_LANE: ['auriga-build', 'mnemosyne-dev', 'votum-dev'],
  PROJECT_IDS: ['CONSUS', 'HEIMDALL', 'AURIGA', 'MINERVA', 'JANUS', 'PCORE'],
  PROJECT_NAMES: { CONSUS: 'Consus', HEIMDALL: 'Heimdall', AURIGA: 'Auriga', MINERVA: 'Minerva', JANUS: 'Janus', PCORE: 'Pantheon Core' },
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5, cycleMs: 1000, zombieStaleMs: 20 * 60 * 1000, verifyDelayMs: 10, perCycleReview: 1 },
  HUMAN_NAMES: ['mathew', 'dostal'],
};

const todo = (id, project, num, assignee = null, title = 'work', extra = {}) =>
  ({ id, identifier: id, project_id: project, number: num, status: 'todo', assignee_id: assignee, title, ...extra });

// A description shaped like a real Minerva-planned plugin-hive story.
const HIVE_DESCRIPTION = `id: some-story
methodology: classic
steps:
  - id: research
    agent: researcher
  - id: implement
    agent: developer
`;

// Like todo(), but sets parent_issue_id so the fixture represents a planned
// story under an epic rather than a top-level seed (see isSeed). Used for the
// pre-existing build-lane routing tests, which predate the seed/minerva-dev
// routing split and mean to exercise chooseAgentForProject, not isSeed.
const story = (id, project, num, parentId, assignee = null, title = 'work') =>
  ({ id, identifier: id, project_id: project, number: num, status: 'todo', assignee_id: assignee, title, parent_issue_id: parentId });

test('isSmokeScratch matches smoke/scratch/verification tickets only', () => {
  assert.ok(core.isSmokeScratch('SMOKE: dispatch nurse test'));
  assert.ok(core.isSmokeScratch('SCRATCH curl-probe sub-issue'));
  assert.ok(core.isSmokeScratch('verification-swarm sub-issue 2'));
  assert.ok(!core.isSmokeScratch('[P1] Rate-floor filter'));
  assert.ok(!core.isSmokeScratch('Implement smokestack monitor')); // word-boundary: "smokestack" != "smoke"
});

test('classifyRun distinguishes active/done/failed', () => {
  const now = Date.now();
  assert.equal(core.classifyRun({ status: 'completed', completed_at: new Date(now).toISOString(), error: null }, now).done, true);
  assert.equal(core.classifyRun({ status: 'running', completed_at: null }, now).active, true);
  assert.equal(core.classifyRun({ status: 'failed', error: 'boom' }, now).failed, true);
  assert.equal(core.classifyRun({ status: 'completed', error: 'boom' }, now).failed, true);
});

test('computeInflight counts ONLY assigned+running (not assigned-todo) — P0 deadlock fix', () => {
  const issues = [
    todo('i1', 'AURIGA', 1, 'A'),                                   // assigned todo -> NOT inflight (queued, not running)
    { id: 'i2', status: 'in_progress', assignee_id: 'A', title: 'x' }, // running -> inflight A
    { id: 'i3', status: 'in_progress', assignee_id: 'H', title: 'x' }, // running -> inflight H
    todo('i4', 'AURIGA', 2, null),                                  // unassigned -> not counted
    { id: 'i5', status: 'done', assignee_id: 'A', title: 'x' },     // done -> not counted
  ];
  const inflight = core.computeInflight(issues, CFG.AGENTS);
  assert.equal(inflight['auriga-dev'], 1);  // only i2 (running); i1 assigned-todo no longer inflates this
  assert.equal(inflight['heimdall-dev'], 1);
  assert.equal(inflight['consus-dev'], 0);
});

test('computeAssignedQueued reports the assigned-todo backlog (observability only)', () => {
  const issues = [
    todo('i1', 'AURIGA', 1, 'A'),                                   // assigned todo -> queued A
    todo('i2', 'AURIGA', 2, 'A'),                                   // assigned todo -> queued A
    { id: 'i3', status: 'in_progress', assignee_id: 'A', title: 'x' }, // running -> NOT queued
    todo('i4', 'AURIGA', 3, null),                                  // unassigned -> not counted
  ];
  const queued = core.computeAssignedQueued(issues, CFG.AGENTS);
  assert.equal(queued['auriga-dev'], 2);
  assert.equal(queued['heimdall-dev'], 0);
});

test('computeRuntimeInflight aggregates the shared codex runtime', () => {
  const inflight = { 'auriga-dev': 2, 'heimdall-dev-codex': 1, 'heimdall-dev': 1, 'consus-dev': 0 };
  const rt = core.computeRuntimeInflight(inflight, CFG.AGENTS);
  assert.equal(rt.codex, 3);   // 2 + 1 across the shared runtime
  assert.equal(rt.opencode, 1);
});

test('agentHasCapacity respects per-agent AND per-runtime caps', () => {
  const empty = { perAgent: {}, perRuntime: {} };
  // codex runtime already at cap 4 -> auriga-dev blocked even though its own count is low
  const inflight = { 'auriga-dev': 2, 'heimdall-dev-codex': 2 };
  const rt = core.computeRuntimeInflight(inflight, CFG.AGENTS);
  assert.equal(core.agentHasCapacity('auriga-dev', CFG.AGENTS, CFG.RUNTIME_CAP, inflight, rt, empty), false);
  // opencode has room
  assert.equal(core.agentHasCapacity('heimdall-dev', CFG.AGENTS, CFG.RUNTIME_CAP, {}, {}, empty), true);
});

test('routing: aligned lanes go to their agent; Consus to claude', () => {
  const issues = [story('c1', 'CONSUS', 1, 'EPIC1'), story('a1', 'AURIGA', 2, 'EPIC1'), story('m1', 'MINERVA', 3, 'EPIC1')];
  const picks = core.selectAssignments(issues, CFG, core.computeInflight(issues, CFG.AGENTS), {});
  const byId = Object.fromEntries(picks.map((p) => [p.identifier, p.agent]));
  assert.equal(byId['c1'], 'consus-dev');
  assert.equal(byId['a1'], 'auriga-dev');
  assert.equal(byId['m1'], 'auriga-dev'); // minerva -> nearest codex lane
});

test('routing: default lane spreads across the two codex agents', () => {
  const issues = [story('j1', 'JANUS', 1, 'EPIC1'), story('j2', 'JANUS', 2, 'EPIC1')];
  const picks = core.selectAssignments(issues, CFG, {}, {});
  const agents = picks.map((p) => p.agent).sort();
  assert.deepEqual(agents, ['auriga-dev', 'heimdall-dev-codex']); // load-balanced
});

test('small-batch: never exceeds per-cycle total or per-agent cap', () => {
  // 10 Auriga todos, only auriga-dev is the lane. perAgent cycle cap = 2.
  const issues = Array.from({ length: 10 }, (_, i) => story('a' + i, 'AURIGA', i, 'EPIC1'));
  const picks = core.selectAssignments(issues, CFG, {}, {});
  assert.ok(picks.length <= CFG.CAPS.perCycleTotal);
  const aurigaCount = picks.filter((p) => p.agent === 'auriga-dev').length;
  assert.ok(aurigaCount <= CFG.CAPS.perCyclePerAgent, `auriga got ${aurigaCount}`);
});

test('runtime cap gates the whole codex lane in one cycle', () => {
  // Many default-lane (codex) todos; codex runtime cap 4, both agents empty.
  const issues = Array.from({ length: 10 }, (_, i) => story('j' + i, 'JANUS', i, 'EPIC1'));
  const picks = core.selectAssignments(issues, CFG, {}, { maxTotal: 20, maxPerAgent: 20 });
  // Both codex agents share cap 4 -> at most 4 codex assignments.
  assert.ok(picks.length <= 4, `got ${picks.length}`);
});

test('blockedRuntimes skips a rate-limited lane', () => {
  const issues = [story('a1', 'AURIGA', 1, 'EPIC1')];
  const picks = core.selectAssignments(issues, CFG, {}, { blockedRuntimes: new Set(['codex']) });
  assert.equal(picks.length, 0);
});

test('selection ignores smoke/scratch and assigned/backlog issues', () => {
  const issues = [
    todo('s1', 'AURIGA', 1, null, 'SMOKE: dispatch test'),
    todo('a1', 'AURIGA', 2, 'A'), // already assigned
    { id: 'b1', identifier: 'b1', project_id: 'AURIGA', number: 3, status: 'backlog', assignee_id: null, title: 'work' },
    story('a2', 'AURIGA', 4, 'EPIC1'),
  ];
  const picks = core.selectAssignments(issues, CFG, core.computeInflight(issues, CFG.AGENTS), {});
  assert.deepEqual(picks.map((p) => p.identifier), ['a2']);
});

test('isHumanTodo: matches the human-todo label regardless of case', () => {
  assert.ok(core.isHumanTodo({ labels: ['human-todo'], metadata: {} }, CFG));
  assert.ok(core.isHumanTodo({ labels: ['Human-Todo'], metadata: {} }, CFG));
  assert.ok(core.isHumanTodo({ labels: [{ name: 'human-todo' }], metadata: {} }, CFG));
  assert.ok(!core.isHumanTodo({ labels: ['bug'], metadata: {} }, CFG));
});

test('isHumanTodo: matches waiting_on a known human name (PAN-6644 case)', () => {
  assert.ok(core.isHumanTodo({ labels: [], metadata: { waiting_on: 'Mathew' } }, CFG));
  assert.ok(core.isHumanTodo({ labels: [], metadata: { waiting_on: 'waiting on Dostal for review' } }, CFG));
  assert.ok(!core.isHumanTodo({ labels: [], metadata: { waiting_on: 'PAN-1234' } }, CFG)); // dependency, not a human
  assert.ok(!core.isHumanTodo({ labels: [], metadata: {} }, CFG));
  assert.ok(!core.isHumanTodo({ labels: [], metadata: { waiting_on: '' } }, CFG));
});

test('humanTodoReason: label wins over waiting_on when both are set', () => {
  assert.equal(core.humanTodoReason({ labels: ['human-todo'], metadata: { waiting_on: 'Mathew' } }), 'label');
  assert.equal(core.humanTodoReason({ labels: [], metadata: { waiting_on: 'Mathew' } }), 'waiting_on');
});

test('selectAssignments: priority-1 rule excludes human-todos from the dispatch candidate pool', () => {
  const issues = [
    { ...todo('h1', 'AURIGA', 1), labels: ['human-todo'] },
    { ...todo('h2', 'AURIGA', 2), metadata: { waiting_on: 'Mathew' } },
    todo('a1', 'AURIGA', 3), // ordinary todo, still dispatched
  ];
  const picks = core.selectAssignments(issues, CFG, core.computeInflight(issues, CFG.AGENTS), {});
  assert.deepEqual(picks.map((p) => p.identifier), ['a1']);
});

test('detectZombies: in_progress with no runs -> assign (no assignee) / rerun (assignee)', () => {
  const now = Date.now();
  const inProgress = [
    { id: 'z1', identifier: 'z1', project_id: 'MINERVA', status: 'in_progress', assignee_id: null, title: 'stalled' },
    { id: 'z2', identifier: 'z2', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'stalled' },
    { id: 'z3', identifier: 'z3', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'healthy' },
  ];
  const runs = {
    z1: [],
    z2: [{ status: 'failed', error: 'x', created_at: new Date(now).toISOString() }],
    z3: [{ status: 'running', completed_at: null, created_at: new Date(now).toISOString() }],
  };
  const z = core.detectZombies(inProgress, runs, CFG, now);
  const byId = Object.fromEntries(z.map((a) => [a.identifier, a.action]));
  assert.equal(byId['z1'], 'assign');
  assert.equal(byId['z2'], 'rerun');
  assert.equal(byId['z3'], undefined); // healthy, active run
});

test('detectRunCompletions: done+non-failed run -> advance-in-review; active/failed/none do not', () => {
  const now = Date.now();
  const inProgress = [
    { id: 'r1', identifier: 'r1', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'done ok' },
    { id: 'r2', identifier: 'r2', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'still running' },
    { id: 'r3', identifier: 'r3', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'failed run' },
    { id: 'r4', identifier: 'r4', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'no runs' },
    { id: 'r5', identifier: 'r5', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'SMOKE: ignore me' },
  ];
  const runs = {
    r1: [{ status: 'completed', completed_at: new Date(now).toISOString(), error: null }],
    r2: [{ status: 'running', completed_at: null, created_at: new Date(now).toISOString() }],
    r3: [{ status: 'failed', error: 'boom', completed_at: new Date(now).toISOString() }],
    r4: [],
    r5: [{ status: 'completed', completed_at: new Date(now).toISOString(), error: null }],
  };
  const actions = core.detectRunCompletions(inProgress, runs, now);
  assert.deepEqual(actions.map((a) => a.identifier), ['r1']);
  assert.equal(actions[0].action, 'advance-in-review');
});

test('detectVerifiedDone: only a real merged PR (state or merged_at) advances to done', () => {
  const inReview = [
    { id: 'v1', identifier: 'v1', project_id: 'AURIGA', status: 'in_review', title: 'merged via state' },
    { id: 'v2', identifier: 'v2', project_id: 'AURIGA', status: 'in_review', title: 'merged via merged_at' },
    { id: 'v3', identifier: 'v3', project_id: 'AURIGA', status: 'in_review', title: 'still open' },
    { id: 'v4', identifier: 'v4', project_id: 'AURIGA', status: 'in_review', title: 'no PRs' },
    { id: 'v5', identifier: 'v5', project_id: 'AURIGA', status: 'in_review', title: 'SMOKE: ignore me' },
  ];
  const prs = {
    v1: [{ state: 'merged', merged_at: null }],
    v2: [{ state: 'open', merged_at: '2026-07-28T00:00:00Z' }],
    v3: [{ state: 'open', merged_at: null }],
    v4: [],
    v5: [{ state: 'merged', merged_at: '2026-07-28T00:00:00Z' }],
  };
  const actions = core.detectVerifiedDone(inReview, prs);
  assert.deepEqual(actions.map((a) => a.identifier).sort(), ['v1', 'v2']);
  assert.ok(actions.every((a) => a.action === 'advance-done'));
});

test('detectZombies: stale-but-old run triggers recovery, fresh done does not', () => {
  const now = Date.now();
  const old = new Date(now - 30 * 60 * 1000).toISOString();
  const inProgress = [
    { id: 'z4', identifier: 'z4', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'stale' },
    { id: 'z5', identifier: 'z5', project_id: 'AURIGA', status: 'in_progress', assignee_id: 'A', title: 'recent' },
  ];
  const runs = {
    z4: [{ status: 'running', completed_at: null, created_at: old, started_at: old }],
    z5: [{ status: 'running', completed_at: null, created_at: new Date(now).toISOString() }],
  };
  const z = core.detectZombies(inProgress, runs, CFG, now);
  const byId = Object.fromEntries(z.map((a) => [a.identifier, a.action]));
  // z4: a "running" run stuck >20min is a silent hang -> recovered via rerun.
  assert.equal(byId['z4'], 'rerun');
  // z5: fresh running run -> healthy, not flagged.
  assert.equal(byId['z5'], undefined);
});

test('isHiveStory detects Minerva-shaped descriptions (methodology + steps + hive agents)', () => {
  assert.ok(core.isHiveStory({ description: HIVE_DESCRIPTION }));
  assert.ok(!core.isHiveStory({ description: 'Just fix the login bug, no special format here.' }));
  assert.ok(!core.isHiveStory({}));
});

test('isHiveStory detects capability labels (forward-compat, no description needed)', () => {
  assert.ok(core.isHiveStory({ labels: ['build'] }));
  assert.ok(core.isHiveStory({ labels: ['implementation'] }));
  assert.ok(core.isHiveStory({ labels: ['classic-methodology'] }));
  assert.ok(!core.isHiveStory({ labels: ['bug'] }));
});

test('routing: a hive-tagged story in Auriga (PROJECT_LANE -> codex) still lands on HIVE_LANE, never codex', () => {
  const issues = [todo('h1', 'AURIGA', 1, null, 'hive story', { description: HIVE_DESCRIPTION })];
  const picks = core.selectAssignments(issues, CFG, core.computeInflight(issues, CFG.AGENTS), {});
  assert.equal(picks.length, 1);
  assert.ok(CFG.HIVE_LANE.includes(picks[0].agent), `expected a HIVE_LANE agent, got ${picks[0].agent}`);
  assert.ok(!['auriga-dev', 'heimdall-dev-codex', 'heimdall-dev'].includes(picks[0].agent));
});

test('routing: a non-hive story with no PROJECT_LANE entry still falls back to DEFAULT_LANE (regression)', () => {
  // A planned story (has a parent) so it is NOT a seed — the seed/minerva-dev
  // split (PAN-6646) routes unmarked top-level childless todos to the planning
  // lane, so this DEFAULT_LANE fallback regression must use a non-seed story.
  const issues = [story('j1', 'JANUS', 1, 'EPIC1')];
  const picks = core.selectAssignments(issues, CFG, {}, {});
  assert.equal(picks.length, 1);
  assert.ok(CFG.DEFAULT_LANE.includes(picks[0].agent));
});

test('chooseAgentForProject: isHive=true bypasses PROJECT_LANE entirely, even for aligned codex projects', () => {
  const empty = { perAgent: {}, perRuntime: {} };
  const agent = core.chooseAgentForProject('AURIGA', CFG, {}, {}, empty, true);
  assert.ok(CFG.HIVE_LANE.includes(agent));
});

test('detectZombies flags isHive on the zombie action so re-routing respects HIVE_LANE', () => {
  const now = Date.now();
  const inProgress = [
    { id: 'z6', identifier: 'z6', project_id: 'AURIGA', status: 'in_progress', assignee_id: null, title: 'stalled hive story', description: HIVE_DESCRIPTION },
  ];
  const z = core.detectZombies(inProgress, { z6: [] }, CFG, now);
  const byId = Object.fromEntries(z.map((a) => [a.identifier, a]));
  assert.equal(byId['z6'].isHive, true);
});

// --- isSeed (PAN-6646 planning-lane routing) -------------------------------

test('isSeed: label idea or needs-plan is an explicit seed regardless of parent/children', () => {
  assert.equal(core.isSeed({ id: 'x1', labels: ['idea'], parent_issue_id: 'p1' }, []), true);
  assert.equal(core.isSeed({ id: 'x2', labels: ['needs-plan'] }, []), true);
});

test("isSeed: 'consus-idea' label (Consus ideabox) is an explicit seed even with a parent", () => {
  assert.equal(core.isSeed({ id: 'ci1', labels: ['consus-idea'], parent_issue_id: 'epic1' }, []), true);
  assert.equal(core.isSeed({ id: 'ci2', labels: [{ id: 'l', name: 'consus-idea' }] }, []), true);
});

test('isSeed: real API label shape (array of {name,...} objects, not strings) is still detected', () => {
  // multica issue list/get return labels as objects, e.g.
  // [{ id, name: 'idea', color, ... }] — not ['idea']. A child issue (has a
  // parent) explicitly labeled 'idea' must still be seed-classified: the
  // label leg has to override the parent/children heuristic even against the
  // real object shape, not just the string-array test fixture shape.
  const issue = {
    id: 'x7',
    parent_issue_id: 'epic1',
    labels: [{ id: 'l1', name: 'idea', color: '#22c55e' }],
  };
  assert.equal(core.isSeed(issue, []), true);
});

test('isSeed: unmarked, top-level, and childless is a seed', () => {
  const issue = { id: 'x3' }; // no parent_issue_id, no labels, no children in the empty set
  assert.equal(core.isSeed(issue, []), true);
});

test('isSeed: has a parent_issue_id is not a seed', () => {
  const issue = { id: 'x4', parent_issue_id: 'epic1' };
  assert.equal(core.isSeed(issue, []), false);
});

test('isSeed: top-level but has a child in allIssues is not a seed', () => {
  const issue = { id: 'x5' };
  const allIssues = [{ id: 'x6', parent_issue_id: 'x5' }];
  assert.equal(core.isSeed(issue, allIssues), false);
});

// --- selectAssignments seed routing (PAN-6646) ------------------------------

test('routing: issue labeled idea routes to minerva-dev, never a build agent', () => {
  const issue = { ...todo('seed1', 'AURIGA', 1), labels: ['idea'] };
  const picks = core.selectAssignments([issue], CFG, {}, {});
  assert.equal(picks.length, 1);
  assert.equal(picks[0].agent, 'minerva-dev');
});

test('routing: issue labeled needs-plan routes to minerva-dev', () => {
  const issue = { ...todo('seed2', 'AURIGA', 1), labels: ['needs-plan'] };
  const picks = core.selectAssignments([issue], CFG, {}, {});
  assert.equal(picks.length, 1);
  assert.equal(picks[0].agent, 'minerva-dev');
});

test('routing: unmarked, top-level, childless issue routes to minerva-dev', () => {
  const issue = todo('seed3', 'AURIGA', 1); // no parent_issue_id, no children -> seed
  const picks = core.selectAssignments([issue], CFG, {}, {});
  assert.equal(picks.length, 1);
  assert.equal(picks[0].agent, 'minerva-dev');
});

test('routing: issue with a parent_issue_id is not seed-classified, uses the normal build lane', () => {
  const issue = story('story1', 'AURIGA', 1, 'epic1');
  const picks = core.selectAssignments([issue], CFG, {}, {});
  assert.equal(picks.length, 1);
  assert.equal(picks[0].agent, 'auriga-dev');
});

test('routing: top-level issue with a child in the scanned set is not seed-classified', () => {
  const parent = todo('parent1', 'AURIGA', 1); // no parent_issue_id itself
  const child = story('child1', 'AURIGA', 2, 'parent1');
  const picks = core.selectAssignments([parent, child], CFG, {}, {});
  const byId = Object.fromEntries(picks.map((p) => [p.identifier, p.agent]));
  assert.equal(byId['parent1'], 'auriga-dev'); // has a child -> not a seed -> normal build lane
  assert.equal(byId['child1'], 'auriga-dev');  // has a parent -> not a seed -> normal build lane
});

test('routing: a decomposed non-seed story in Pantheon Core routes to the build lane, not codex', () => {
  // The full-loop close: a seed dropped in Pantheon Core is planned by Minerva, which files the
  // child stories back INTO Pantheon Core. Those non-seed stories must reach auriga-build.
  const epicParent = todo('pc-epic', 'PCORE', 1); // has a child below -> not a seed
  const childStory = story('pc-story', 'PCORE', 2, 'pc-epic'); // non-hive-shaped decomposed story
  const picks = core.selectAssignments([epicParent, childStory], CFG, {}, {});
  const byId = Object.fromEntries(picks.map((p) => [p.identifier, p.agent]));
  assert.equal(byId['pc-story'], 'auriga-build'); // build lane, never DEFAULT_LANE codex
});

test('depsSatisfied: gates a story on its depends_on metadata (only done/cancelled unblock)', () => {
  const statusById = new Map([['dep-done', 'done'], ['dep-open', 'in_progress'], ['dep-cxl', 'cancelled']]);
  assert.equal(core.depsSatisfied({ metadata: {} }, statusById), true); // no deps
  assert.equal(core.depsSatisfied({ metadata: { depends_on: '' } }, statusById), true);
  assert.equal(core.depsSatisfied({ metadata: { depends_on: 'dep-done' } }, statusById), true);
  assert.equal(core.depsSatisfied({ metadata: { depends_on: 'dep-cxl' } }, statusById), true);
  assert.equal(core.depsSatisfied({ metadata: { depends_on: 'dep-open' } }, statusById), false);
  assert.equal(core.depsSatisfied({ metadata: { depends_on: 'dep-done,dep-open' } }, statusById), false);
  // A dependency we can't see (not in the scanned set) must NOT block (no deadlock).
  assert.equal(core.depsSatisfied({ metadata: { depends_on: 'ghost' } }, statusById), true);
});

test('routing: selectAssignments withholds a story whose dep isn\'t done, dispatches once it is', () => {
  // s2 depends_on s1 (carried as the resolved issue id in metadata). While s1 is todo, only s1
  // dispatches; when s1 is done, s2 becomes eligible.
  const s1 = story('s1id', 'AURIGA', 1, 'epicX');
  const s2 = { ...story('s2id', 'AURIGA', 2, 'epicX'), metadata: { depends_on: 's1id' } };
  let picks = core.selectAssignments([s1, s2], CFG, {}, {});
  assert.deepEqual(picks.map((p) => p.identifier), ['s1id']); // s2 blocked by unfinished s1

  const s1done = { ...s1, status: 'done' };
  picks = core.selectAssignments([s1done, s2], CFG, {}, {});
  assert.deepEqual(picks.map((p) => p.identifier), ['s2id']); // s1 done -> s2 unblocked
});

test('routing: seed skipped when minerva-dev has no capacity, never falls back to a build agent', () => {
  const issue = { ...todo('seed4', 'AURIGA', 1), labels: ['idea'] };
  // minerva-dev's maxInflight is 3 in the CFG fixture; exhaust it directly via inflight.
  const inflight = { 'minerva-dev': 3 };
  const picks = core.selectAssignments([issue], CFG, inflight, {});
  assert.equal(picks.length, 0); // skipped this cycle, not routed anywhere
  assert.ok(!picks.some((p) => p.agent !== 'minerva-dev')); // never falls back to a build agent
});

// ---- BACK-HALF: review / ship dispatch ----------------------------------

const NOW = 1_700_000_000_000;
// An in_review issue with a target_repo line (build-lane output shape).
const inReview = (id, num, assignee = null, extra = {}) => ({
  id, identifier: id, project_id: 'PCORE', number: num, status: 'in_review',
  assignee_id: assignee, title: 'work', description: 'target_repo: mdostal/cron-maker\n', ...extra,
});
const freshRun = { status: 'running', started_at: new Date(NOW - 1000).toISOString() };
const doneFresh = { status: 'completed', completed_at: new Date(NOW - 1000).toISOString() };
const doneStale = { status: 'completed', completed_at: new Date(NOW - 30 * 60 * 1000).toISOString() };

test('hasTargetRepo / reviewEligible: build-shaped stories are review-eligible, plain docs are not', () => {
  assert.ok(core.hasTargetRepo({ description: 'foo\ntarget_repo: mdostal/cron-maker\nbar' }));
  assert.ok(!core.hasTargetRepo({ description: 'just a design note' }));
  assert.ok(core.reviewEligible({ description: 'target_repo: mdostal/x' }));      // target_repo signal
  assert.ok(core.reviewEligible({ description: HIVE_DESCRIPTION }));               // hive-shaped
  assert.ok(!core.reviewEligible({ description: 'a Consus decision doc' }));       // neither -> not eligible
});

test('selectReviewDispatch: an in_review story with a build signal dispatches to the review lane', () => {
  const i = inReview('PAN-1', 1); // unassigned, eligible
  const picks = core.selectReviewDispatch([i], { 'PAN-1': [] }, CFG, {}, { now: NOW });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].agent, 'auriga-review');
  assert.equal(picks[0].action, 'dispatch-review');
});

test('selectReviewDispatch: ineligible in_review stories (no build signal) are never dispatched', () => {
  const doc = { id: 'D1', identifier: 'D1', project_id: 'PCORE', number: 1, status: 'in_review', assignee_id: null, title: 'decision', description: 'a plain doc' };
  const picks = core.selectReviewDispatch([doc], { D1: [] }, CFG, {}, { now: NOW });
  assert.equal(picks.length, 0);
});

test('selectReviewDispatch: a story already under active review is NOT re-dispatched (idempotent)', () => {
  const i = inReview('PAN-2', 2, 'RV'); // assigned to review agent
  const picks = core.selectReviewDispatch([i], { 'PAN-2': [freshRun] }, CFG, { 'auriga-review': 1 }, { now: NOW });
  assert.equal(picks.length, 0);
});

test('selectReviewDispatch: reviewer finished recently but story still in_review -> give it time, no re-fire', () => {
  const i = inReview('PAN-3', 3, 'RV');
  const picks = core.selectReviewDispatch([i], { 'PAN-3': [doneFresh] }, CFG, { 'auriga-review': 1 }, { now: NOW });
  assert.equal(picks.length, 0);
});

test('selectReviewDispatch: a wedged review (assigned, run stale) self-heals via rerun-review', () => {
  const i = inReview('PAN-4', 4, 'RV');
  const picks = core.selectReviewDispatch([i], { 'PAN-4': [doneStale] }, CFG, { 'auriga-review': 1 }, { now: NOW });
  assert.equal(picks.length, 1);
  assert.equal(picks[0].action, 'rerun-review');
  assert.equal(picks[0].agent, 'auriga-review');
});

test('selectReviewDispatch: respects perCycleReview cap and lane maxInflight', () => {
  const a = inReview('PAN-5', 5); const b = inReview('PAN-6', 6);
  // Two eligible unassigned stories, perCycleReview=1 -> only one dispatched this cycle.
  const picks = core.selectReviewDispatch([a, b], { 'PAN-5': [], 'PAN-6': [] }, CFG, {}, { now: NOW });
  assert.equal(picks.length, 1);
  // Lane already full (one review in flight) -> nothing new dispatched.
  const full = core.selectReviewDispatch([a], { 'PAN-5': [] }, CFG, { 'auriga-review': 1 }, { now: NOW });
  assert.equal(full.length, 0);
});

test('computeReviewInflight: counts in_review issues held by review agents', () => {
  const held = inReview('PAN-7', 7, 'RV');
  const other = inReview('PAN-8', 8, 'AB'); // held by a non-review agent
  const counts = core.computeReviewInflight([held, other], CFG);
  assert.equal(counts['auriga-review'], 1);
});

test('chooseReviewAgent: returns null when the lane is at capacity', () => {
  assert.equal(core.chooseReviewAgent(CFG, {}, {}), 'auriga-review');
  assert.equal(core.chooseReviewAgent(CFG, { 'auriga-review': 1 }, {}), null);
});
