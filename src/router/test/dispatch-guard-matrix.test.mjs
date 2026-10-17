// Dispatch guard matrix (PANT-814): every dispatch pass x every dispatch guard.
//
// cycle() has five dispatch passes that each re-implement the same guards by
// hand: cascade, review, zombie, assigned-idle and build (in cycle order). Most
// router regressions on the board were one guard present on one pass and
// missing from a sibling (seed: PANT-570..669, parked: PANT-376..496, blocked
// runtimes: PANT-549..668, counters: PANT-596..677). This file drives the REAL
// cycle() through stub adapters (as router-cycle.e2e.test.mjs does) for every
// pass x guard cell, so a guard that goes missing on any pass fails here.
//
// Zombie and review each have two dispatch shapes (rerun on the current
// assignee vs route-and-assign), and the guards are checked on different code
// paths for each, so both shapes are rows of their own.
//
// A cell that doesn't apply is a string: the reason it is N/A. The completeness
// test at the bottom fails if any pass x guard cell is missing.
//
// The cfg is fully synthetic (fixture agents/runtimes/lanes, never the live
// roster) so every cap and lane in a cell is exactly what the cell sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as realCfg from '../lib/config.mjs';
import { PLANNING_AGENT } from '../lib/core.mjs';
import { createLogSink } from './support/mock-mca.mjs';

const NOOP_SLEEP = async () => {};

const P = 'matrix-project'; // subject project
const P2 = 'matrix-probe-project'; // later-pass probe project (own lane)

const AGENTS = {
  'build-a': { id: 'agent-build-a', runtime: 'rt-a', maxInflight: 50 },
  'build-a2': { id: 'agent-build-a2', runtime: 'rt-a', maxInflight: 50 },
  'build-b': { id: 'agent-build-b', runtime: 'rt-b', maxInflight: 50 },
  [PLANNING_AGENT]: { id: 'agent-planner', runtime: 'rt-plan', maxInflight: 50 },
  reviewer: { id: 'agent-reviewer', runtime: 'rt-review', maxInflight: 50 },
  reviewer2: { id: 'agent-reviewer2', runtime: 'rt-review', maxInflight: 50 },
};
const BUILD_AGENTS = new Set(['build-a', 'build-a2', 'build-b']);
const NAME_BY_ID = Object.fromEntries(Object.entries(AGENTS).map(([n, a]) => [a.id, n]));

// Caps default wide open so a cell only ever hits the cap it sets itself.
function makeCfg({
  lane = ['build-a'], probeLane = ['build-b'], reviewLane = ['reviewer'],
  runtimeCap = {}, caps = {}, agents = AGENTS,
} = {}) {
  return {
    ...realCfg,
    AGENTS: agents,
    PROJECT_IDS: [P, P2],
    PROJECT_NAMES: { [P]: 'Matrix', [P2]: 'Matrix Probe' },
    PROJECT_LANE: { [P]: lane, [P2]: probeLane },
    DEFAULT_LANE: lane,
    HIVE_LANE: lane,
    REVIEW_LANE: reviewLane,
    FORMER_REVIEW_AGENT_IDS: [],
    TREE_AGENT_ATTACHMENTS: {},
    RUNTIME_CAP: { ...runtimeCap },
    CAPS: {
      ...realCfg.CAPS,
      perCyclePerAgent: 10,
      perCycleTotal: 10,
      perCycleReview: 10,
      perCycleCascade: 10,
      assignedIdlePerCycle: 10,
      ...caps,
    },
  };
}

let seq = 1;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `mx-id-${n}`,
    identifier: `MX-${n}`,
    number: n,
    title: `matrix story ${n}`,
    description: '',
    labels: [],
    status: 'todo',
    assignee_id: null,
    parent_issue_id: 'fake-parent', // not top-level, so never a heuristic seed
    project_id: P,
    created_at: new Date().toISOString(),
    metadata: {},
    ...overrides,
  };
}

const hourAgo = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const staleFailedRun = () => [{ status: 'failed', created_at: hourAgo() }];

// ---- per-pass subject builders --------------------------------------------
// Each returns { issues, runs, subject }: `subject` is the identifier this pass
// dispatches in the baseline. `agent` only matters for passes that rerun on the
// current assignee; the other passes pick the agent from the lane.
const PASSES = {
  cascade: {
    runtime: 'rt-a',
    make: ({ metadata = {}, ...o } = {}) => {
      const dep = makeIssue({ status: 'done' });
      const s = makeIssue({ status: 'blocked', metadata: { depends_on: dep.id, ...metadata }, ...o });
      return { issues: [s, dep], runs: {}, subject: s.identifier };
    },
  },
  'review-dispatch': {
    runtime: 'rt-review',
    make: (o = {}) => {
      const s = makeIssue({ status: 'in_review', ...o });
      return { issues: [s], runs: {}, subject: s.identifier };
    },
  },
  'review-rerun': {
    runtime: 'rt-review',
    make: ({ agent = 'reviewer', ...o } = {}) => {
      const s = makeIssue({ status: 'in_review', assignee_id: AGENTS[agent].id, ...o });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'zombie-rerun': {
    runtime: 'rt-a',
    make: ({ agent = 'build-a', ...o } = {}) => {
      const s = makeIssue({ status: 'in_progress', assignee_id: AGENTS[agent].id, ...o });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'zombie-assign': {
    runtime: 'rt-a',
    make: (o = {}) => {
      const s = makeIssue({ status: 'in_progress', ...o });
      return { issues: [s], runs: { [s.identifier]: staleFailedRun() }, subject: s.identifier };
    },
  },
  'assigned-idle': {
    runtime: 'rt-a',
    make: ({ agent = 'build-a', ...o } = {}) => {
      const s = makeIssue({ status: 'todo', assignee_id: AGENTS[agent].id, created_at: hourAgo(), ...o });
      return { issues: [s], runs: {}, subject: s.identifier };
    },
  },
  build: {
    runtime: 'rt-a',
    make: (o = {}) => {
      const s = makeIssue({ status: 'todo', ...o });
      return { issues: [s], runs: {}, subject: s.identifier };
    },
  },
};

// Fresh build-pass todo in the probe project: dispatched by the LAST pass, so
// it shows what earlier passes left in the shared counters.
function probe() {
  return PASSES.build.make({ project_id: P2 });
}

function combine(...scenarios) {
  return {
    issues: scenarios.flatMap((s) => s.issues),
    runs: Object.assign({}, ...scenarios.map((s) => s.runs)),
    subjects: scenarios.map((s) => s.subject),
  };
}

// ---- stub adapters ---------------------------------------------------------
// Every assign/rerun is recorded as a dispatch attempt BEFORE a configured
// failure is thrown, so a cell can count attempts, not just successes. A rerun
// records the agent it re-enqueues (the current assignee).
function createAdapters(issues, runs, { failFor = new Set() } = {}) {
  const board = issues.map((i) => ({ ...i, metadata: { ...i.metadata } }));
  const runsBy = Object.fromEntries(Object.entries(runs).map(([k, v]) => [k, [...v]]));
  const dispatches = [];
  const find = (identifier) => board.find((i) => i.identifier === identifier);
  const addRun = (identifier) => {
    runsBy[identifier] = [...(runsBy[identifier] || []), { status: 'in_progress', created_at: new Date().toISOString() }];
  };
  const rateLimited = () => new Error('multica: rate limited (429)');

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
    assignIssue: (identifier, agent) => {
      dispatches.push({ kind: 'assign', identifier, agent });
      if (failFor.has(identifier)) throw rateLimited();
      const i = find(identifier);
      if (i) i.assignee_id = AGENTS[agent]?.id ?? null;
      addRun(identifier);
    },
    rerunIssue: (identifier) => {
      const agent = NAME_BY_ID[find(identifier)?.assignee_id] ?? null;
      dispatches.push({ kind: 'rerun', identifier, agent });
      if (failFor.has(identifier)) throw rateLimited();
      addRun(identifier);
    },
    unassignIssue: (identifier) => { const i = find(identifier); if (i) i.assignee_id = null; },
    describeLanes: () => ({}),
  };
  return { backlog, spawn, dispatches };
}

async function run(scenario, { cfg = makeCfg(), failFor, maxAssign, initialBlockedRuntimes } = {}) {
  const { backlog, spawn, dispatches } = createAdapters(scenario.issues, scenario.runs, { failFor });
  const log = createLogSink();
  const result = await cycle({
    backlog, spawn, cfg, log, sleep: NOOP_SLEEP,
    dryRun: false, noZombie: false, maxAssign, initialBlockedRuntimes,
  });
  const dispatchesFor = (identifier) => dispatches.filter((d) => d.identifier === identifier);
  const dispatchedIds = (ids) => ids.filter((id) => dispatchesFor(id).length > 0);
  return { result, log, dispatches, dispatchesFor, dispatchedIds };
}

const onRuntime = (rt) => (d) => AGENTS[d.agent]?.runtime === rt;

// ---- generic cells ---------------------------------------------------------

// Positive control: without any guard in play, the pass dispatches its subject.
// Every negative cell below is only meaningful because this one passes.
function baselineCell(pass) {
  return async () => {
    const sc = PASSES[pass].make();
    const r = await run(sc);
    const ds = r.dispatchesFor(sc.subject);
    assert.ok(ds.length > 0, `${pass}: baseline subject was never dispatched`);
    assert.ok(ds.every(onRuntime(PASSES[pass].runtime)), `${pass}: dispatched off its expected runtime: ${JSON.stringify(ds)}`);
  };
}

function parkedCell(pass) {
  return async () => {
    const sc = PASSES[pass].make({ metadata: { blocked_reason: 'waiting-on-human' } });
    const r = await run(sc);
    assert.deepEqual(r.dispatchesFor(sc.subject), [], `${pass}: an agent-parked issue was dispatched`);
  };
}

function blockedRuntimeCell(pass) {
  return async () => {
    const rt = PASSES[pass].runtime;
    const sc = PASSES[pass].make();
    const r = await run(sc, { initialBlockedRuntimes: new Set([rt]) });
    assert.deepEqual(r.dispatches.filter(onRuntime(rt)), [], `${pass}: dispatched into blocked runtime ${rt}`);
  };
}

// Two subjects on the same runtime (plus a later-pass probe on that runtime for
// build-lane passes), all failing with a 429. The first failure must block the
// runtime, so exactly one dispatch is ever attempted.
function rateLimitCell(pass) {
  return async () => {
    const buildLane = PASSES[pass].runtime === 'rt-a';
    const parts = [PASSES[pass].make(), PASSES[pass].make()];
    if (buildLane && pass !== 'build') parts.push(probe());
    const sc = combine(...parts);
    const cfg = makeCfg({ probeLane: ['build-a'] });
    const r = await run(sc, { cfg, failFor: new Set(sc.subjects) });
    const attempted = r.dispatchedIds(sc.subjects);
    assert.equal(attempted.length, 1,
      `${pass}: a 429 did not block runtime ${PASSES[pass].runtime} for the rest of the cycle; attempted ${attempted.join(', ')}`);
  };
}

function maxAssignCell(pass) {
  return async () => {
    const sc = combine(PASSES[pass].make(), PASSES[pass].make());
    const r = await run(sc, { maxAssign: 1 });
    assert.equal(r.dispatchedIds(sc.subjects).length, 1, `${pass}: maxAssign=1 not respected`);
    assert.ok(r.result.assigned <= 1, `${pass}: result.assigned=${r.result.assigned} > maxAssign 1`);
  };
}

function perAgentCell(pass, { reviewLane } = {}) {
  return async () => {
    const sc = combine(PASSES[pass].make(), PASSES[pass].make());
    const cfg = makeCfg({ caps: { perCyclePerAgent: 1 }, ...(reviewLane ? { reviewLane } : {}) });
    const r = await run(sc, { cfg });
    assert.equal(r.dispatchedIds(sc.subjects).length, 1, `${pass}: perCyclePerAgent=1 not respected`);
  };
}

// Two agents sharing runtime rt-a (or rt-review), runtime cap 1: only one of
// the two subjects may dispatch. Rerun passes put one subject on each agent.
function runtimeCapCell(pass) {
  return async () => {
    const review = PASSES[pass].runtime === 'rt-review';
    const [a1, a2] = review ? ['reviewer', 'reviewer2'] : ['build-a', 'build-a2'];
    const sc = combine(PASSES[pass].make({ agent: a1 }), PASSES[pass].make({ agent: a2 }));
    const cfg = makeCfg({
      lane: ['build-a', 'build-a2'],
      reviewLane: ['reviewer', 'reviewer2'],
      runtimeCap: { [PASSES[pass].runtime]: 1 },
    });
    const r = await run(sc, { cfg });
    assert.equal(r.dispatchedIds(sc.subjects).length, 1, `${pass}: RUNTIME_CAP ${PASSES[pass].runtime}=1 not respected`);
  };
}

// Counter reservation: the subject pass dispatches once, then a later-pass
// probe must see that dispatch in the shared counter. Each cell also runs the
// same board without the constraint, to prove the probe is otherwise routable.
function counterCell(pass, { constrain, probeLane, laterProbe = probe }) {
  return async () => {
    const build = () => {
      const subject = PASSES[pass].make();
      const later = laterProbe();
      return { sc: combine(subject, later), subject: subject.subject, probeId: later.subject };
    };
    const control = build();
    const c = await run(control.sc, { cfg: makeCfg({ probeLane }) });
    assert.ok(c.dispatchesFor(control.subject).length > 0, `${pass}: control: subject not dispatched`);
    assert.ok(c.dispatchesFor(control.probeId).length > 0, `${pass}: control: probe not dispatched, cell proves nothing`);

    const t = build();
    const r = await run(t.sc, { cfg: makeCfg({ probeLane, ...constrain.cfg }), ...constrain.run });
    assert.ok(r.dispatchesFor(t.subject).length > 0, `${pass}: subject not dispatched`);
    assert.deepEqual(r.dispatchesFor(t.probeId), [], `${pass}: later pass did not see this pass's reserved counter`);
  };
}
const counterAssigned = (pass, extra = {}) => counterCell(pass, { constrain: { run: { maxAssign: 1 } }, probeLane: ['build-b'], ...extra });
const counterPerAgent = (pass, extra = {}) => counterCell(pass, { constrain: { cfg: { caps: { perCyclePerAgent: 1 } } }, probeLane: ['build-a'], ...extra });
const counterRuntime = (pass) => counterCell(pass, { constrain: { cfg: { runtimeCap: { 'rt-a': 1 } } }, probeLane: ['build-a2'] });

// ---- seed cells (pass-specific: what "not sent to build" means differs) ----
const noBuildDispatch = (r, id, pass) => {
  const bad = r.dispatchesFor(id).filter((d) => BUILD_AGENTS.has(d.agent));
  assert.deepEqual(bad, [], `${pass}: seed ${id} was dispatched to a build agent`);
};
const seedLabels = { labels: ['idea'] };

const SEED = {
  build: async () => {
    // Labeled seed and heuristic seed (top-level + childless) both go to the planning lane.
    const labeled = PASSES.build.make(seedLabels);
    const heuristic = PASSES.build.make({ parent_issue_id: null });
    const r = await run(combine(labeled, heuristic));
    for (const s of [labeled, heuristic]) {
      noBuildDispatch(r, s.subject, 'build');
      assert.deepEqual(r.dispatchesFor(s.subject).map((d) => d.agent), [PLANNING_AGENT], `build: seed ${s.subject} not routed to ${PLANNING_AGENT}`);
    }
    // Tenant with no planning agent (PANT-772): a labeled seed is held, never built.
    const { [PLANNING_AGENT]: _planner, ...noPlanner } = AGENTS;
    const held = PASSES.build.make(seedLabels);
    const r2 = await run(held, { cfg: makeCfg({ agents: noPlanner }) });
    assert.deepEqual(r2.dispatchesFor(held.subject), [], 'build: labeled seed dispatched on a tenant with no planning agent');
  },
  cascade: async () => {
    const sc = PASSES.cascade.make(seedLabels);
    const r = await run(sc);
    noBuildDispatch(r, sc.subject, 'cascade');
    assert.equal(r.log.byEvent('cascade_dispatch').length, 0, 'cascade: seed was cascade-dispatched');
  },
  'review-dispatch': async () => {
    // Review agents aren't build agents; the guard here is PANT-625: seeds get no review run at all.
    const sc = PASSES['review-dispatch'].make(seedLabels);
    const r = await run(sc);
    assert.deepEqual(r.dispatchesFor(sc.subject), [], 'review-dispatch: seed got a review dispatch');
  },
  'review-rerun': async () => {
    const sc = PASSES['review-rerun'].make(seedLabels);
    const r = await run(sc);
    assert.deepEqual(r.dispatchesFor(sc.subject), [], 'review-rerun: seed got a review rerun');
  },
  'zombie-rerun': async () => {
    // PANT-519: a seed stuck in_progress on the planner is never zombie-reran.
    const sc = PASSES['zombie-rerun'].make({ agent: PLANNING_AGENT, ...seedLabels });
    const r = await run(sc);
    assert.deepEqual(r.dispatchesFor(sc.subject), [], 'zombie-rerun: seed was zombie-recovered');
  },
  'zombie-assign': async () => {
    const sc = PASSES['zombie-assign'].make(seedLabels);
    const r = await run(sc);
    noBuildDispatch(r, sc.subject, 'zombie-assign');
  },
  'assigned-idle': async () => {
    // PANT-643: an idle seed IS recovered, but only by rerun on its current
    // (planning) assignee, never re-routed to a build lane.
    const sc = PASSES['assigned-idle'].make({ agent: PLANNING_AGENT, ...seedLabels });
    const r = await run(sc);
    noBuildDispatch(r, sc.subject, 'assigned-idle');
    assert.deepEqual(r.dispatchesFor(sc.subject), [{ kind: 'rerun', identifier: sc.subject, agent: PLANNING_AGENT }]);
  },
};

// ---- the matrix ------------------------------------------------------------
const GUARDS = [
  'baseline', 'seed', 'parked', 'blocked-runtime', 'rate-limit-blocks-runtime',
  'max-assign', 'per-cycle-per-agent', 'runtime-cap',
  'counter:assigned', 'counter:per-agent', 'counter:runtime',
];

const LAST_PASS = 'N/A: build is the last dispatch pass, nothing runs after it (its in-pass reservation is covered by the cap cells)';
const RERUN_HOLDS_SLOT = 'N/A: rerun re-enqueues an issue that already holds its slot (counted in inflight at cycle start), so a runtime cap would only ever block recovery';

const MATRIX = {
  cascade: {
    'per-cycle-per-agent': perAgentCell('cascade'),
    'runtime-cap': runtimeCapCell('cascade'),
    'counter:assigned': counterAssigned('cascade'),
    'counter:per-agent': counterPerAgent('cascade'),
    'counter:runtime': counterRuntime('cascade'),
  },
  'review-dispatch': {
    'per-cycle-per-agent': perAgentCell('review-dispatch'),
    'runtime-cap': runtimeCapCell('review-dispatch'),
    'counter:assigned': counterAssigned('review-dispatch'),
    // Later-pass probe: a zombie stuck on the reviewer (zombie rerun checks perCyclePerAgent).
    'counter:per-agent': counterPerAgent('review-dispatch', {
      laterProbe: () => PASSES['zombie-rerun'].make({ agent: 'reviewer' }),
    }),
    'counter:runtime': 'N/A: review agents sit in their own runtime bucket, and no later pass routes into it (zombie/assigned-idle only rerun, which never checks a runtime cap)',
  },
  'review-rerun': {
    'per-cycle-per-agent': perAgentCell('review-rerun'),
    'runtime-cap': RERUN_HOLDS_SLOT,
    'counter:assigned': counterAssigned('review-rerun'),
    'counter:per-agent': counterPerAgent('review-rerun', {
      laterProbe: () => PASSES['zombie-rerun'].make({ agent: 'reviewer' }),
    }),
    'counter:runtime': 'N/A: review agents sit in their own runtime bucket, and no later pass routes into it (zombie/assigned-idle only rerun, which never checks a runtime cap)',
  },
  'zombie-rerun': {
    'per-cycle-per-agent': perAgentCell('zombie-rerun'),
    'runtime-cap': RERUN_HOLDS_SLOT,
    'counter:assigned': counterAssigned('zombie-rerun'),
    'counter:per-agent': counterPerAgent('zombie-rerun'),
    'counter:runtime': counterRuntime('zombie-rerun'),
  },
  'zombie-assign': {
    'per-cycle-per-agent': perAgentCell('zombie-assign'),
    'runtime-cap': runtimeCapCell('zombie-assign'),
    'counter:assigned': counterAssigned('zombie-assign'),
    'counter:per-agent': counterPerAgent('zombie-assign'),
    'counter:runtime': counterRuntime('zombie-assign'),
  },
  'assigned-idle': {
    'per-cycle-per-agent': perAgentCell('assigned-idle'),
    'runtime-cap': runtimeCapCell('assigned-idle'),
    'counter:assigned': counterAssigned('assigned-idle'),
    'counter:per-agent': counterPerAgent('assigned-idle'),
    'counter:runtime': counterRuntime('assigned-idle'),
  },
  build: {
    'per-cycle-per-agent': perAgentCell('build'),
    'runtime-cap': runtimeCapCell('build'),
    'counter:assigned': LAST_PASS,
    'counter:per-agent': LAST_PASS,
    'counter:runtime': LAST_PASS,
  },
};

// Guards whose cell is the same generic check on every pass.
for (const pass of Object.keys(MATRIX)) {
  MATRIX[pass] = {
    baseline: baselineCell(pass),
    seed: SEED[pass],
    parked: parkedCell(pass),
    'blocked-runtime': blockedRuntimeCell(pass),
    'rate-limit-blocks-runtime': rateLimitCell(pass),
    'max-assign': maxAssignCell(pass),
    ...MATRIX[pass],
  };
}

for (const [pass, row] of Object.entries(MATRIX)) {
  for (const guard of GUARDS) {
    const cell = row[guard];
    if (typeof cell === 'string') {
      test(`guard matrix: ${pass} x ${guard}: ${cell}`, { skip: cell }, () => {});
    } else if (typeof cell === 'function') {
      test(`guard matrix: ${pass} x ${guard}`, cell);
    }
  }
}

test('guard matrix is complete: every pass x guard is a test or a reasoned N/A', () => {
  const passes = ['cascade', 'review-dispatch', 'review-rerun', 'zombie-rerun', 'zombie-assign', 'assigned-idle', 'build'];
  assert.deepEqual(Object.keys(MATRIX).sort(), [...passes].sort());
  for (const pass of passes) {
    for (const guard of GUARDS) {
      const cell = MATRIX[pass][guard];
      assert.ok(
        typeof cell === 'function' || (typeof cell === 'string' && /^N\/A: \S/.test(cell)),
        `${pass} x ${guard} is neither a test nor an N/A with a reason`,
      );
    }
    assert.deepEqual(Object.keys(MATRIX[pass]).sort(), [...GUARDS].sort(), `${pass} has cells outside GUARDS`);
  }
});
