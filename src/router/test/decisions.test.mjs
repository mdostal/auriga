// Decision records (PANT-816): every cycle() pass emits one `decision` event
// per routing choice in the documented schema (lib/decisions.mjs, README
// "Decision records"), a dry-run cycle emits the same decisions, and guarded
// skips are rate-limited per issue. Drives the REAL cycle() through stub
// adapters over a synthetic cfg, like dispatch-guard-matrix.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as realCfg from '../lib/config.mjs';
import { PLANNING_AGENT, chooseAgentForProject, chooseReviewAgent } from '../lib/core.mjs';
import {
  DECISION_ACTIONS, DECISION_PASSES, DECISION_SCHEMA_VERSION, buildDecision, createSkipLimiter, isDecisionReason, reasonCode,
} from '../lib/decisions.mjs';
import { createLogSink } from './support/mock-mca.mjs';

const NOOP_SLEEP = async () => {};
const P = 'dec-project';
const P_CHILD = 'dec-child-routed';

const AGENTS = {
  'build-a': { id: 'agent-build-a', runtime: 'rt-a', maxInflight: 50 },
  'build-b': { id: 'agent-build-b', runtime: 'rt-b', maxInflight: 50 },
  [PLANNING_AGENT]: { id: 'agent-planner', runtime: 'rt-plan', maxInflight: 50 },
  reviewer: { id: 'agent-reviewer', runtime: 'rt-review', maxInflight: 50 },
};
const NAME_BY_ID = Object.fromEntries(Object.entries(AGENTS).map(([n, a]) => [a.id, n]));

function makeCfg({ agents = AGENTS, lane = ['build-a', 'build-b'], caps = {} } = {}) {
  return {
    ...realCfg,
    AGENTS: agents,
    PROJECT_IDS: [P, P_CHILD],
    PROJECT_NAMES: { [P]: 'Decisions', [P_CHILD]: 'Child Routed' },
    PROJECT_LANE: { [P]: lane },
    PROJECT_ROUTE: { [P_CHILD]: { kind: 'child', childId: 'kid' } },
    DEFAULT_LANE: lane,
    HIVE_LANE: lane,
    REVIEW_LANE: ['reviewer'],
    FORMER_REVIEW_AGENT_IDS: [],
    TREE_AGENT_ATTACHMENTS: {},
    RUNTIME_CAP: {},
    CAPS: {
      ...realCfg.CAPS,
      perCyclePerAgent: 10, perCycleTotal: 10, perCycleReview: 10, perCycleCascade: 10, assignedIdlePerCycle: 10,
      ...caps,
    },
  };
}

const TOPOLOGY = {
  parent: { id: 'mom', baseUrl: 'http://parent.test', projectId: 'parent-project' },
  children: [{ id: 'kid', baseUrl: 'http://child.test', projectId: 'child-project' }],
};

let seq = 1;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `dec-id-${n}`, identifier: `DEC-${n}`, number: n, title: `decision story ${n}`, description: '',
    labels: [], status: 'todo', assignee_id: null, parent_issue_id: 'fake-parent', project_id: P,
    created_at: new Date().toISOString(), metadata: {},
    ...overrides,
  };
}
const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const staleFailedRun = () => [{ status: 'failed', created_at: hourAgo() }];

// One scenario per pass shape. `pass`/`action`/`reason` are what its subject's
// decision record must say.
const SCENARIOS = {
  build: {
    expect: { pass: 'build', action: 'assign', reason: 'project_lane' },
    make: () => { const s = makeIssue(); return { issues: [s], runs: {}, subject: s.identifier }; },
  },
  'build-seed': {
    expect: { pass: 'build', action: 'assign', reason: 'seed_planning', agent: PLANNING_AGENT },
    make: () => { const s = makeIssue({ labels: ['idea'] }); return { issues: [s], runs: {}, subject: s.identifier }; },
  },
  cascade: {
    expect: { pass: 'cascade', action: 'assign', reason: 'project_lane' },
    make: () => {
      const dep = makeIssue({ status: 'done' });
      const s = makeIssue({ status: 'blocked', metadata: { depends_on: dep.id } });
      return { issues: [s, dep], runs: {}, subject: s.identifier };
    },
  },
  'review-dispatch': {
    expect: { pass: 'review', action: 'assign', agent: 'reviewer' },
    make: () => { const s = makeIssue({ status: 'in_review' }); return { issues: [s], runs: {}, subject: s.identifier }; },
  },
  'review-rerun': {
    expect: { pass: 'review', action: 'rerun', agent: 'reviewer' },
    make: () => {
      const s = makeIssue({ status: 'in_review', assignee_id: AGENTS.reviewer.id });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'zombie-rerun': {
    expect: { pass: 'zombie', action: 'rerun', reason: 'existing_assignee', agent: 'build-a' },
    make: () => {
      const s = makeIssue({ status: 'in_progress', assignee_id: AGENTS['build-a'].id });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'zombie-assign': {
    expect: { pass: 'zombie', action: 'assign', reason: 'project_lane' },
    make: () => {
      const s = makeIssue({ status: 'in_progress' });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'assigned-idle': {
    expect: { pass: 'assigned_idle', action: 'rerun', reason: 'existing_assignee', agent: 'build-a' },
    make: () => {
      const s = makeIssue({ status: 'todo', assignee_id: AGENTS['build-a'].id, created_at: hourAgo() });
      return { issues: [s], runs: {}, subject: s.identifier };
    },
  },
  'hand-up': {
    // No local route: the lane's only agent is offline.
    cfg: () => makeCfg({ agents: { ...AGENTS, 'build-a': { ...AGENTS['build-a'], available: false } }, lane: ['build-a'] }),
    expect: { pass: 'hand_up', action: 'create_remote', reason: 'no_local_route', agent: null },
    make: () => { const s = makeIssue({ labels: ['hand-up'] }); return { issues: [s], runs: {}, subject: s.identifier }; },
  },
  'hand-down': {
    expect: { pass: 'hand_down', action: 'create_remote', reason: 'project_route_child', agent: null },
    make: () => { const s = makeIssue({ project_id: P_CHILD }); return { issues: [s], runs: {}, subject: s.identifier }; },
  },
};

function createAdapters(issues, runs) {
  const board = issues.map((i) => ({ ...i, metadata: { ...i.metadata } }));
  const runsBy = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, [...v]]));
  const find = (identifier) => board.find((i) => i.identifier === identifier);
  const addRun = (identifier) => {
    runsBy[identifier] = [...(runsBy[identifier] || []), { status: 'in_progress', created_at: new Date().toISOString() }];
  };
  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: (projectIds) => board.filter((i) => projectIds.includes(i.project_id)),
    getIssueRuns: (identifier) => runsBy[identifier] || [],
    getIssuePullRequests: () => [],
    setIssueStatus: (identifier, status) => { const i = find(identifier); if (i) i.status = status; },
    commentOnIssue: () => {},
    setIssueMetadata: (identifier, md) => { const i = find(identifier); if (i) i.metadata = { ...i.metadata, ...md }; },
  };
  const spawn = {
    assignIssue: (identifier, agent) => { const i = find(identifier); if (i) i.assignee_id = AGENTS[agent]?.id ?? null; addRun(identifier); },
    rerunIssue: (identifier) => { if (!NAME_BY_ID[find(identifier)?.assignee_id]) return; addRun(identifier); },
    unassignIssue: (identifier) => { const i = find(identifier); if (i) i.assignee_id = null; },
    describeLanes: () => ({}),
  };
  return { backlog, spawn };
}

async function runCycle(scenario, { cfg = makeCfg(), dryRun = false, skipLimiter, initialBlockedRuntimes } = {}) {
  const { backlog, spawn } = createAdapters(scenario.issues, scenario.runs);
  const log = createLogSink();
  await cycle({
    backlog, spawn, cfg, log, sleep: NOOP_SLEEP, dryRun, noZombie: false, skipLimiter, initialBlockedRuntimes, tenantId: 'test-tenant',
    loadTopology: () => TOPOLOGY, loadExternalConfig: () => ({}),
    createRemoteBacklog: () => ({ createIssue: () => ({ identifier: 'REMOTE-1' }) }),
  });
  return log;
}

const decisionsFor = (log, identifier) => log.byEvent('decision').filter((d) => d.identifier === identifier);

const REQUIRED_FIELDS = [
  'schema', 'ts', 'tenant_id', 'instance_id', 'identifier', 'pass', 'action', 'agent', 'runtime', 'lane',
  'reason', 'candidates', 'caps', 'dry_run', 'error',
];

function assertWellFormed(d) {
  for (const f of REQUIRED_FIELDS) assert.ok(Object.hasOwn(d, f), `decision is missing ${f}: ${JSON.stringify(d)}`);
  assert.equal(d.schema, DECISION_SCHEMA_VERSION);
  assert.ok(!Number.isNaN(Date.parse(d.ts)), `ts is not ISO: ${d.ts}`);
  assert.equal(d.tenant_id, 'test-tenant');
  assert.ok(DECISION_PASSES.includes(d.pass), `unknown pass ${d.pass}`);
  assert.ok(DECISION_ACTIONS.includes(d.action), `unknown action ${d.action}`);
  assert.ok(isDecisionReason(d.reason), `reason ${d.reason} is not in the documented enum`);
  assert.ok(Array.isArray(d.candidates));
  assert.equal(typeof d.caps, 'object');
  assert.equal(typeof d.dry_run, 'boolean');
}

// ---- every pass -------------------------------------------------------------

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`decision: ${name} emits one well-formed decision for its subject`, async () => {
    const s = sc.make();
    const log = await runCycle(s, { cfg: sc.cfg ? sc.cfg() : makeCfg() });
    const ds = decisionsFor(log, s.subject).filter((d) => d.action !== 'skip');
    assert.equal(ds.length, 1, `${name}: expected one decision, got ${JSON.stringify(log.byEvent('decision'))}`);
    const [d] = ds;
    assertWellFormed(d);
    assert.equal(d.dry_run, false);
    assert.equal(d.error, null);
    for (const [k, v] of Object.entries(sc.expect)) assert.equal(d[k], v, `${name}: ${k}`);
    if (d.agent) {
      assert.equal(d.runtime, AGENTS[d.agent].runtime);
      assert.ok(d.candidates.some((c) => c.agent === d.agent && c.selected), `${name}: chosen agent not among candidates`);
    }
  });
}

test('decision: review reason names the squad tier', async () => {
  const s = SCENARIOS['review-dispatch'].make();
  const log = await runCycle(s);
  const [d] = decisionsFor(log, s.subject);
  assert.match(d.reason, /^review_tier_(full|light|backend|standard)$/);
});

test('decision: candidates list the rejected lane agents with their skip reason', async () => {
  const s = SCENARIOS.build.make();
  const cfg = makeCfg({ agents: { ...AGENTS, 'build-a': { ...AGENTS['build-a'], available: false } } });
  const log = await runCycle(s, { cfg });
  const [d] = decisionsFor(log, s.subject);
  assert.equal(d.agent, 'build-b');
  assert.deepEqual(d.candidates, [
    { agent: 'build-a', runtime: 'rt-a', selected: false, skip: 'agent_offline' },
    { agent: 'build-b', runtime: 'rt-b', selected: true },
  ]);
});

test('decision: caps carry headroom as it was before the dispatch', async () => {
  const s = SCENARIOS.build.make();
  const cfg = makeCfg({ lane: ['build-a'] });
  cfg.RUNTIME_CAP = { 'rt-a': 3 };
  const log = await runCycle(s, { cfg });
  const [d] = decisionsFor(log, s.subject);
  assert.deepEqual(d.caps, {
    agent_inflight: 0, agent_max_inflight: 50, agent_cycle_assigns: 0, per_cycle_per_agent: 10,
    runtime_inflight: 0, runtime_cap: 3, assigned: 0, max_assign: null,
  });
});

test('decision: a failed dispatch records its error', async () => {
  const s = SCENARIOS.build.make();
  const { backlog, spawn } = createAdapters(s.issues, s.runs);
  spawn.assignIssue = () => { throw new Error('multica: rate limited (429)'); };
  const log = createLogSink();
  await cycle({ backlog, spawn, cfg: makeCfg(), log, sleep: NOOP_SLEEP, loadTopology: () => TOPOLOGY, loadExternalConfig: () => ({}) });
  const [d] = decisionsFor(log, s.subject);
  assert.equal(d.action, 'assign');
  assert.match(d.error, /429/);
});

// ---- dry run ----------------------------------------------------------------

// Everything but the timestamp and the dry_run flag must match.
const comparable = ({ ts: _ts, dry_run: _dry, ...rest }) => rest;

for (const [name, sc] of Object.entries(SCENARIOS)) {
  test(`decision: dry-run ${name} emits the same decisions with dry_run: true`, async () => {
    const s = sc.make();
    const cfg = sc.cfg ? sc.cfg() : makeCfg();
    const live = await runCycle(s, { cfg });
    const dry = await runCycle(s, { cfg: sc.cfg ? sc.cfg() : makeCfg(), dryRun: true });
    const liveDs = live.byEvent('decision');
    const dryDs = dry.byEvent('decision');
    assert.ok(dryDs.length > 0, `${name}: dry run emitted no decisions`);
    assert.ok(dryDs.every((d) => d.dry_run === true), `${name}: a dry-run decision has dry_run false`);
    assert.ok(liveDs.every((d) => d.dry_run === false));
    assert.deepEqual(dryDs.map(comparable), liveDs.map(comparable), `${name}: dry-run decisions differ from live`);
  });
}

// ---- guarded skips ----------------------------------------------------------

test('decision: a guarded skip is recorded once per issue within the rate-limit window', async () => {
  // Zombie rerun onto a blocked runtime: dispatchEligible rejects it every cycle.
  const s = SCENARIOS['zombie-rerun'].make();
  const cfg = makeCfg({ caps: { decisionSkipWindowCycles: 3 } });
  const skipLimiter = createSkipLimiter();
  const perCycle = [];
  for (let i = 0; i < 5; i++) {
    const log = await runCycle(s, { cfg, skipLimiter, initialBlockedRuntimes: new Set(['rt-a']) });
    perCycle.push(decisionsFor(log, s.subject));
  }
  assert.deepEqual(perCycle.map((ds) => ds.length), [1, 0, 0, 1, 0],
    'one skip at cycle 1, then again once the 3-cycle window has passed');
  const [d] = perCycle[0];
  assertWellFormed(d);
  assert.equal(d.action, 'skip');
  assert.equal(d.pass, 'zombie');
  assert.equal(d.reason, 'assignee_runtime_blocked');
  assert.equal(d.agent, 'build-a');
});

test('decision: the skip window is per issue, not per pass or cycle', async () => {
  const a = SCENARIOS['zombie-rerun'].make();
  const b = SCENARIOS['zombie-rerun'].make();
  const log = await runCycle(
    { issues: [...a.issues, ...b.issues], runs: { ...a.runs, ...b.runs } },
    { initialBlockedRuntimes: new Set(['rt-a']) },
  );
  assert.equal(decisionsFor(log, a.subject).length, 1);
  assert.equal(decisionsFor(log, b.subject).length, 1);
});

test('decision: without a caller-kept limiter, skips are not suppressed across cycles', async () => {
  const s = SCENARIOS['zombie-rerun'].make();
  for (let i = 0; i < 2; i++) {
    const log = await runCycle(s, { initialBlockedRuntimes: new Set(['rt-a']) });
    assert.equal(decisionsFor(log, s.subject).length, 1);
  }
});

// ---- pure pieces ------------------------------------------------------------

test('buildDecision: every schema field present, reason normalised to the enum spelling', () => {
  const d = buildDecision({ identifier: 'X-1', pass: 'zombie-rerun', action: 'skip', reason: 'per-cycle-per-agent-cap' });
  for (const f of REQUIRED_FIELDS) assert.ok(Object.hasOwn(d, f), f);
  assert.equal(d.pass, 'zombie');
  assert.equal(d.reason, 'per_cycle_per_agent_cap');
  assert.equal(d.dry_run, false);
  assert.equal(d.error, null);
});

test('reasonCode: every dispatchEligible reason maps into the enum', () => {
  for (const r of ['max-assign', 'pass-cap', 'agent-parked', 'seed', 'runtime-blocked', 'assignee-runtime-blocked', 'per-cycle-per-agent-cap', 'no-capacity', 'no-lane-capacity', 'unknown-child', 'child-unreachable']) {
    assert.ok(isDecisionReason(reasonCode(r)), r);
  }
});

test('createSkipLimiter: allows once per window, per issue', () => {
  const l = createSkipLimiter({ windowCycles: 2 });
  l.tick();
  assert.equal(l.allow('A'), true);
  assert.equal(l.allow('A'), false);
  assert.equal(l.allow('B'), true);
  l.tick();
  assert.equal(l.allow('A'), false);
  l.tick();
  assert.equal(l.allow('A'), true);
});

test('chooseAgentForProject trace: lane reason and candidates, without changing the pick', () => {
  const cfg = makeCfg();
  const projected = { perAgent: {}, perRuntime: {}, perAgentCycle: { 'build-a': 10 } };
  const trace = {};
  const pick = chooseAgentForProject(P, cfg, {}, {}, projected, false, new Set(['rt-z']), 10, trace);
  assert.equal(pick, chooseAgentForProject(P, cfg, {}, {}, projected, false, new Set(['rt-z']), 10));
  assert.equal(pick, 'build-b');
  assert.equal(trace.reason, 'project_lane');
  assert.deepEqual(trace.candidates, [
    { agent: 'build-a', runtime: 'rt-a', selected: false, skip: 'per_cycle_per_agent_cap' },
    { agent: 'build-b', runtime: 'rt-b', selected: true },
  ]);
  const t2 = {};
  chooseAgentForProject('unlisted-project', cfg, {}, {}, { perAgent: {}, perRuntime: {} }, false, new Set(), Infinity, t2);
  assert.equal(t2.reason, 'default_lane');
});

test('chooseReviewAgent trace: blocked runtime is the rejected reviewer\'s skip reason', () => {
  const cfg = makeCfg();
  const trace = {};
  assert.equal(chooseReviewAgent(cfg, {}, {}, new Set(['rt-review']), {}, trace), null);
  assert.deepEqual(trace.candidates, [{ agent: 'reviewer', runtime: 'rt-review', selected: false, skip: 'runtime_blocked' }]);
});
