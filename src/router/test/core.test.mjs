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
  },
  RUNTIME_CAP: { claude: 2, opencode: 3, codex: 4 },
  PROJECT_LANE: {
    CONSUS: ['consus-dev'],
    HEIMDALL: ['heimdall-dev', 'heimdall-dev-codex'],
    AURIGA: ['auriga-dev'],
    MINERVA: ['auriga-dev'],
  },
  DEFAULT_LANE: ['auriga-dev', 'heimdall-dev-codex'],
  HIVE_LANE: ['auriga-build', 'mnemosyne-dev', 'votum-dev'],
  PROJECT_IDS: ['CONSUS', 'HEIMDALL', 'AURIGA', 'MINERVA', 'JANUS'],
  PROJECT_NAMES: { CONSUS: 'Consus', HEIMDALL: 'Heimdall', AURIGA: 'Auriga', MINERVA: 'Minerva', JANUS: 'Janus' },
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5, cycleMs: 1000, zombieStaleMs: 20 * 60 * 1000, verifyDelayMs: 10 },
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
  const issues = [todo('c1', 'CONSUS', 1), todo('a1', 'AURIGA', 2), todo('m1', 'MINERVA', 3)];
  const picks = core.selectAssignments(issues, CFG, core.computeInflight(issues, CFG.AGENTS), {});
  const byId = Object.fromEntries(picks.map((p) => [p.identifier, p.agent]));
  assert.equal(byId['c1'], 'consus-dev');
  assert.equal(byId['a1'], 'auriga-dev');
  assert.equal(byId['m1'], 'auriga-dev'); // minerva -> nearest codex lane
});

test('routing: default lane spreads across the two codex agents', () => {
  const issues = [todo('j1', 'JANUS', 1), todo('j2', 'JANUS', 2)];
  const picks = core.selectAssignments(issues, CFG, {}, {});
  const agents = picks.map((p) => p.agent).sort();
  assert.deepEqual(agents, ['auriga-dev', 'heimdall-dev-codex']); // load-balanced
});

test('small-batch: never exceeds per-cycle total or per-agent cap', () => {
  // 10 Auriga todos, only auriga-dev is the lane. perAgent cycle cap = 2.
  const issues = Array.from({ length: 10 }, (_, i) => todo('a' + i, 'AURIGA', i));
  const picks = core.selectAssignments(issues, CFG, {}, {});
  assert.ok(picks.length <= CFG.CAPS.perCycleTotal);
  const aurigaCount = picks.filter((p) => p.agent === 'auriga-dev').length;
  assert.ok(aurigaCount <= CFG.CAPS.perCyclePerAgent, `auriga got ${aurigaCount}`);
});

test('runtime cap gates the whole codex lane in one cycle', () => {
  // Many default-lane (codex) todos; codex runtime cap 4, both agents empty.
  const issues = Array.from({ length: 10 }, (_, i) => todo('j' + i, 'JANUS', i));
  const picks = core.selectAssignments(issues, CFG, {}, { maxTotal: 20, maxPerAgent: 20 });
  // Both codex agents share cap 4 -> at most 4 codex assignments.
  assert.ok(picks.length <= 4, `got ${picks.length}`);
});

test('blockedRuntimes skips a rate-limited lane', () => {
  const issues = [todo('a1', 'AURIGA', 1)];
  const picks = core.selectAssignments(issues, CFG, {}, { blockedRuntimes: new Set(['codex']) });
  assert.equal(picks.length, 0);
});

test('selection ignores smoke/scratch and assigned/backlog issues', () => {
  const issues = [
    todo('s1', 'AURIGA', 1, null, 'SMOKE: dispatch test'),
    todo('a1', 'AURIGA', 2, 'A'), // already assigned
    { id: 'b1', identifier: 'b1', project_id: 'AURIGA', number: 3, status: 'backlog', assignee_id: null, title: 'work' },
    todo('a2', 'AURIGA', 4),
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
  const issues = [todo('j1', 'JANUS', 1)];
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
