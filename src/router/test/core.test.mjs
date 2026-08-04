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
    'firefly-root': { id: 'FR', runtime: 'codex', maxInflight: 3 },
    'firefly-api': { id: 'FA', runtime: 'codex', maxInflight: 3 },
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
  TREE_AGENT_ATTACHMENTS: {
    'firefly-events': ['firefly-root'],
    'firefly-events/events/api': ['FA'],
  },
  CAPS: { perCyclePerAgent: 2, perCycleTotal: 5, cycleMs: 1000, zombieStaleMs: 20 * 60 * 1000, verifyDelayMs: 10 },
  HUMAN_NAMES: ['mathew', 'dostal'],
};

const todo = (id, project, num, assignee = null, title = 'work') =>
  ({ id, identifier: id, project_id: project, number: num, status: 'todo', assignee_id: assignee, title });

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

test('detectAssignedIdle wakes stale assigned todos for known agents only', () => {
  const now = Date.now();
  const old = new Date(now - 30 * 60 * 1000).toISOString();
  const fresh = new Date(now - 5 * 60 * 1000).toISOString();
  const known = core.agentIdSet(CFG.AGENTS);
  const issues = [
    { ...todo('stale1', 'AURIGA', 1, 'A'), updated_at: old },
    { ...todo('fresh1', 'AURIGA', 2, 'A'), updated_at: fresh },
    { ...todo('unknown1', 'AURIGA', 3, 'UNKNOWN'), updated_at: old },
    { ...todo('smoke1', 'AURIGA', 4, 'A', 'SMOKE: dispatch test'), updated_at: old },
    { ...todo('human1', 'AURIGA', 5, 'A'), updated_at: old, labels: ['human-todo'] },
  ];
  const recoveries = core.detectAssignedIdle(issues, {}, CFG, known, now);
  assert.deepEqual(recoveries.map((r) => r.identifier), ['stale1']);
  assert.equal(recoveries[0].action, 'start');
  assert.equal(recoveries[0].reason, 'assigned-todo-no-runs');
});

test('detectAssignedIdle skips assigned todos with a fresh active run', () => {
  const now = Date.now();
  const old = new Date(now - 30 * 60 * 1000).toISOString();
  const recent = new Date(now - 2 * 60 * 1000).toISOString();
  const issues = [{ ...todo('active1', 'AURIGA', 1, 'A'), updated_at: old }];
  const runs = { active1: [{ status: 'running', completed_at: null, created_at: recent }] };
  const recoveries = core.detectAssignedIdle(issues, runs, CFG, core.agentIdSet(CFG.AGENTS), now);
  assert.deepEqual(recoveries, []);
});

test('limitAssignedIdleRecoveries spreads recovery across agents', () => {
  const actions = [
    { identifier: 'a1', assigneeId: 'A', idleAgeMs: 50 },
    { identifier: 'a2', assigneeId: 'A', idleAgeMs: 40 },
    { identifier: 'h1', assigneeId: 'H', idleAgeMs: 30 },
  ];
  const selected = core.limitAssignedIdleRecoveries(actions, CFG, { maxTotal: 3, maxPerAgent: 1 });
  assert.deepEqual(selected.map((a) => a.identifier), ['a1', 'h1']);
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

test('tree-aware routing: exact tree node attachment overrides project lane', () => {
  const issues = [{ ...todo('ff1', 'AURIGA', 1), tree_path: 'firefly-events/events/api' }];
  const picks = core.selectAssignments(issues, CFG, {}, {});
  assert.equal(picks[0].agent, 'firefly-api');
});

test('tree-aware routing: ancestor attachment is eligible for descendant task path', () => {
  const cfg = {
    ...CFG,
    TREE_AGENT_ATTACHMENTS: { 'firefly-events': ['firefly-root'] },
  };
  const issues = [{ ...todo('ff2', 'AURIGA', 1), tree_path: 'firefly-events/events/api' }];
  const picks = core.selectAssignments(issues, cfg, {}, {});
  assert.equal(picks[0].agent, 'firefly-root');
});

test('tree-aware routing: task without tree_path uses existing project lane', () => {
  const issues = [todo('a1', 'AURIGA', 1)];
  const picks = core.selectAssignments(issues, CFG, {}, {});
  assert.equal(picks[0].agent, 'auriga-dev');
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
