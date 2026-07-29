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
    // Planning lane fixture mirroring lib/config.mjs's minerva-dev entry:
    // deliberately absent from RUNTIME_CAP below (own uncapped runtime bucket).
    'minerva-dev': { id: 'M', runtime: 'claude-planning', maxInflight: 3 },
  },
  RUNTIME_CAP: { claude: 2, opencode: 3, codex: 4 },
  PROJECT_LANE: {
    CONSUS: ['consus-dev'],
    HEIMDALL: ['heimdall-dev', 'heimdall-dev-codex'],
    AURIGA: ['auriga-dev'],
    MINERVA: ['auriga-dev'],
  },
  DEFAULT_LANE: ['auriga-dev', 'heimdall-dev-codex'],
  PROJECT_IDS: ['CONSUS', 'HEIMDALL', 'AURIGA', 'MINERVA', 'JANUS'],
  PROJECT_NAMES: { CONSUS: 'Consus', HEIMDALL: 'Heimdall', AURIGA: 'Auriga', MINERVA: 'Minerva', JANUS: 'Janus' },
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5, cycleMs: 1000, zombieStaleMs: 20 * 60 * 1000, verifyDelayMs: 10 },
};

const todo = (id, project, num, assignee = null, title = 'work') =>
  ({ id, identifier: id, project_id: project, number: num, status: 'todo', assignee_id: assignee, title });

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

// --- isSeed (PAN-6646 planning-lane routing) -------------------------------

test('isSeed: label idea or needs-plan is an explicit seed regardless of parent/children', () => {
  assert.equal(core.isSeed({ id: 'x1', labels: ['idea'], parent_issue_id: 'p1' }, []), true);
  assert.equal(core.isSeed({ id: 'x2', labels: ['needs-plan'] }, []), true);
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

test('routing: seed skipped when minerva-dev has no capacity, never falls back to a build agent', () => {
  const issue = { ...todo('seed4', 'AURIGA', 1), labels: ['idea'] };
  // minerva-dev's maxInflight is 3 in the CFG fixture; exhaust it directly via inflight.
  const inflight = { 'minerva-dev': 3 };
  const picks = core.selectAssignments([issue], CFG, inflight, {});
  assert.equal(picks.length, 0); // skipped this cycle, not routed anywhere
  assert.ok(!picks.some((p) => p.agent !== 'minerva-dev')); // never falls back to a build agent
});
