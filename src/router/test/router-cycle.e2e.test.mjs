// Loop-level integration tests: drive the REAL auriga-router.mjs cycle()
// against MOCK backlog+spawn adapters (the two-adapter analog of the old
// single mock-mca.mjs layer) — no live `multica`/`gh` CLI calls. Uses the
// real lib/config.mjs + lib/core.mjs so these tests exercise the actual
// routing tables and decision logic, not a re-description of them.
//
// p2-router-cutover: cycle() now takes opts.backlog/opts.spawn (typed
// adapter instances) instead of opts.mca — see auriga-router.mjs. The mock
// below is the two-adapter split of test/support/mock-mca.mjs's single
// object: backlog and spawn share ONE in-memory board + runs map (via
// closures), because spawn.assignIssue/rerunIssue synthesizing an active run
// must be observable through backlog.getIssueRuns — exactly the same
// "assign implies a run appears" behavior the old single-mca mock provided.
// The ASSERTED SCENARIOS below (which routing decisions happen) are
// UNCHANGED from before the cutover — only how the mock is constructed and
// how calls are recorded (`calls.assign` instead of `mca.calls.assign`)
// changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../auriga-router.mjs';
import * as cfg from '../lib/config.mjs';
import { createLogSink } from './support/mock-mca.mjs';

const NOOP_SLEEP = async () => {};

function projectId(name) {
  const id = Object.entries(cfg.PROJECT_NAMES).find(([, n]) => n === name)?.[0];
  if (!id) throw new Error(`no project id for ${name}`);
  return id;
}

let seq = 1000;
function makeIssue(overrides = {}) {
  const n = seq++;
  return {
    id: `id-${n}`,
    identifier: `PAN-${n}`,
    number: n,
    title: `story ${n}`,
    description: '',
    labels: [],
    status: 'todo',
    assignee_id: null,
    parent_issue_id: null,
    metadata: {},
    ...overrides,
  };
}

// Mock BacklogAdapter + SpawnAdapter sharing one in-memory board + runs map.
// spawn.assignIssue()/rerunIssue() also synthesize an active run for the
// assigned identifier — this stands in for "the platform started a run",
// which is what cycle()'s post-assign verify step (backlog.getIssueRuns) is
// checking for. Without it every assignment would fall through to
// verify_no_run -> rerun, which is real router behavior but not what these
// dispatch-shape tests are exercising (mirrors mock-mca.mjs's own doc
// comment on this exact synthesis).
function createMockAdapters(boardIssues, agents) {
  const calls = { assign: [], rerun: [], status: [], unassign: [], comment: [] };
  const runsByIdentifier = {};
  const findIssue = (identifier) => boardIssues.find((i) => i.identifier === identifier);

  const backlog = {
    listAllProjectIds: () => [],
    listAllIssues: (projectIds) => boardIssues.filter((i) => projectIds.includes(i.project_id)),
    getIssueRuns: (identifier) => runsByIdentifier[identifier] || [],
    getIssuePullRequests: () => [],
    setIssueStatus: (identifier, status) => {
      calls.status.push({ identifier, status });
      const issue = findIssue(identifier);
      if (issue) issue.status = status;
    },
    commentOnIssue: (identifier, body) => {
      calls.comment.push({ identifier, body });
    },
  };

  const spawn = {
    assignIssue: (identifier, agentName) => {
      calls.assign.push({ identifier, agentName });
      const issue = findIssue(identifier);
      if (issue) issue.assignee_id = agents[agentName] && agents[agentName].id;
      runsByIdentifier[identifier] = [
        ...(runsByIdentifier[identifier] || []),
        { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
      ];
    },
    rerunIssue: (identifier) => {
      calls.rerun.push({ identifier });
      runsByIdentifier[identifier] = [
        ...(runsByIdentifier[identifier] || []),
        { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
      ];
    },
    unassignIssue: (identifier) => {
      calls.unassign.push({ identifier });
      const issue = findIssue(identifier);
      if (issue) issue.assignee_id = null;
    },
    describeLanes: () => ({}),
  };

  return { backlog, spawn, calls, boardIssues, runsByIdentifier };
}

test('AC1: a hive-tagged todo dispatches to a HIVE_LANE agent (never codex/opencode) and verifies in-progress', async () => {
  const AURIGA = projectId('Auriga'); // default (non-hive) lane here is codex-only auriga-dev
  const hiveStory = makeIssue({ project_id: AURIGA, labels: ['build'] }); // 'build' is a HIVE_LABEL
  const { backlog, spawn, calls } = createMockAdapters([hiveStory], cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1);
  assert.equal(calls.assign.length, 1);
  const [assignment] = calls.assign;
  assert.equal(assignment.identifier, hiveStory.identifier);
  assert.ok(cfg.HIVE_LANE.includes(assignment.agentName), `expected a HIVE_LANE agent, got ${assignment.agentName}`);
  const codexOrOpencode = new Set(['auriga-dev', 'heimdall-dev-codex', 'heimdall-dev']);
  assert.ok(!codexOrOpencode.has(assignment.agentName), `hive story must NEVER route to codex/opencode, got ${assignment.agentName}`);
  assert.equal(cfg.AGENTS[assignment.agentName].runtime, 'claude');

  const verifyOk = log.byEvent('verify_ok');
  assert.equal(verifyOk.length, 1);
  assert.equal(verifyOk[0].identifier, hiveStory.identifier);
  assert.equal(verifyOk[0].runStatus, 'in_progress');
  assert.equal(log.byEvent('verify_no_run').length, 0);
});

test('AC2: a Pantheon Core [idea] seed routes to minerva-dev; its decomposed non-seed child routes to auriga-build', async () => {
  const PANTHEON_CORE = projectId('Pantheon Core');
  const seedIssue = makeIssue({ project_id: PANTHEON_CORE, labels: ['idea'], parent_issue_id: null });
  const childStory = makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: seedIssue.id });
  const { backlog, spawn, calls } = createMockAdapters([seedIssue, childStory], cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 2);
  const byIdentifier = Object.fromEntries(calls.assign.map((a) => [a.identifier, a.agentName]));
  assert.equal(byIdentifier[seedIssue.identifier], 'minerva-dev');
  assert.equal(byIdentifier[childStory.identifier], 'auriga-build');
});

test('AC3: per-agent(2) and per-runtime (claude 2 / codex 4) caps hold within one cycle, never exceeding perCycleTotal(5)', async () => {
  const AURIGA = projectId('Auriga'); // single-agent lane: auriga-dev (codex)
  const HEIMDALL = projectId('Heimdall'); // two-agent lane: heimdall-dev (opencode) + heimdall-dev-codex (codex)
  const CONSUS = projectId('Consus'); // single-agent lane: consus-dev (claude)
  const PANTHEON_CORE = projectId('Pantheon Core'); // single-agent lane: auriga-build (claude)

  // Each carries a fake parent_issue_id so isSeed() short-circuits false (not
  // top-level) — these are meant to be plain build-lane candidates, not seeds.
  const issues = [
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: AURIGA, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: HEIMDALL, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: CONSUS, parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: 'fake-parent' })),
  ];
  assert.equal(issues.length, 12); // more candidates than perCycleTotal, so the cap is actually exercised

  const { backlog, spawn, calls } = createMockAdapters(issues, cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.ok(result.assigned <= cfg.CAPS.perCycleTotal, `assigned ${result.assigned} > perCycleTotal ${cfg.CAPS.perCycleTotal}`);
  assert.ok(calls.assign.length <= cfg.CAPS.perCycleTotal);
  // The cap must have actually engaged — otherwise this test is not exercising it.
  assert.ok(calls.assign.length > 0);

  const perAgent = {};
  const perRuntime = {};
  for (const { agentName } of calls.assign) {
    perAgent[agentName] = (perAgent[agentName] || 0) + 1;
    const runtime = cfg.AGENTS[agentName].runtime;
    perRuntime[runtime] = (perRuntime[runtime] || 0) + 1;
  }
  for (const [agentName, count] of Object.entries(perAgent)) {
    assert.ok(count <= cfg.CAPS.perCyclePerAgent, `${agentName} got ${count} assignments > perCyclePerAgent ${cfg.CAPS.perCyclePerAgent}`);
  }
  for (const [runtime, count] of Object.entries(perRuntime)) {
    const cap = cfg.RUNTIME_CAP[runtime] ?? Infinity;
    assert.ok(count <= cap, `runtime ${runtime} got ${count} assignments > RUNTIME_CAP ${cap}`);
  }
});
