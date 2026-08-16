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
// which is what spawn.dispatch()'s own internal post-assign verify step is
// checking for (cycle()'s "route new todos" pass calls spawn.dispatch(),
// which assigns + verifies + force-reruns in one call — see
// lib/adapters/multica/spawn.mjs's dispatch()). Without this synthesis every
// assignment would fall through to verify_no_run -> rerun, which is real
// router behavior but not what these dispatch-shape tests are exercising
// (mirrors mock-mca.mjs's own doc comment on this exact synthesis).
// opts.failAssignFor / opts.noRunFor: identifier sets letting a test drive
// dispatch()'s OTHER two branches (assign failure; assign-succeeds-but-no-run
// -> force-rerun) through the real cycle()/dispatch() call path, the same way
// spawn-adapter.test.mjs drives them directly against the real adapter.
function createMockAdapters(boardIssues, agents, opts = {}) {
  const failAssignFor = opts.failAssignFor || new Set();
  const noRunFor = opts.noRunFor || new Set();
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

  // Shared by the public assignIssue/rerunIssue methods AND dispatch() below
  // — mirrors the real multica spawn adapter's dispatch() (lib/adapters/
  // multica/spawn.mjs), which calls its own private assignIssue/rerunIssue
  // internally rather than going back through the public object.
  function doAssign(identifier, agentName) {
    calls.assign.push({ identifier, agentName });
    if (failAssignFor.has(identifier)) throw new Error('multica: rate limited (429)');
    const issue = findIssue(identifier);
    if (issue) issue.assignee_id = agents[agentName] && agents[agentName].id;
    if (!noRunFor.has(identifier)) {
      runsByIdentifier[identifier] = [
        ...(runsByIdentifier[identifier] || []),
        { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
      ];
    }
  }

  function doRerun(identifier) {
    calls.rerun.push({ identifier });
    runsByIdentifier[identifier] = [
      ...(runsByIdentifier[identifier] || []),
      { status: 'in_progress', created_at: new Date().toISOString(), dispatched_at: new Date().toISOString() },
    ];
  }

  const spawn = {
    // dispatch(): the same assign -> verify a run started -> force-rerun
    // sequence the real multica spawn adapter's dispatch() implements,
    // reusing this mock's own "assign synthesizes an in_progress run" fixture
    // behavior (see this function's header comment) so AC1's verify_ok
    // assertion still holds without falling through to verify_no_run.
    dispatch: (issue, lane) => {
      const identifier = issue && issue.identifier;
      try {
        doAssign(identifier, lane);
      } catch (e) {
        return { identifier, lane, assigned: false, assignError: e.message, started: false, forcedRerun: false };
      }
      const runs = runsByIdentifier[identifier] || [];
      const started = runs.length > 0; // doAssign synthesizes an in_progress row unless noRunFor
      if (!started) {
        doRerun(identifier);
        return { identifier, lane, assigned: true, started: false, forcedRerun: true };
      }
      const lr = runs[runs.length - 1];
      return {
        identifier, lane, assigned: true, started: true, forcedRerun: false,
        runStatus: lr.status, runtimeId: lr.runtime_id,
      };
    },
    assignIssue: doAssign,
    rerunIssue: doRerun,
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

// ---- regression coverage for an independent adversarial review's two findings
// against this epic's diff: (1) a PR matching a story ONLY via its short slug
// key (never the raw ticket identifier) was silently dropped before
// core.mjs's prMatchesStory ever got a chance to find it, because
// backlog.getIssuePullRequests pre-filtered with its own narrower
// prMatchesIdentifier heuristic; (2) the repo-wide gh PR scan re-ran per
// issue per call site instead of once per cycle(). Both fixed by
// auriga-router.mjs's cycle() calling backlog.listCandidatePullRequests()
// ONCE and filtering that cached, unfiltered list via coreImpl.prMatchesStory
// itself.

test('a PR matching ONLY via the story\'s short slug key (never the raw ticket identifier) is found via the cached board-wide scan + prMatchesStory', async () => {
  const AURIGA = projectId('Auriga');
  const story = makeIssue({
    project_id: AURIGA,
    title: '[m-01-core] Wire the recall interface',
    status: 'in_review',
  });
  // Deliberately carries the story's short slug key ("m-01") in its branch,
  // but NEVER the raw ticket identifier (e.g. "PAN-1042") anywhere in title/
  // branch/body — the exact shape prMatchesIdentifier (the adapter's old,
  // narrower per-identifier heuristic) cannot match, but prMatchesStory's
  // short-key regex can.
  const slugOnlyPr = {
    number: 5,
    title: 'feat: service wiring',
    headRefName: 'feat/m-01-service',
    body: '',
    state: 'merged',
    merged_at: new Date().toISOString(),
    url: 'https://github.com/acme/widgets/pull/5',
  };
  const idNeedle = story.identifier.toLowerCase();
  assert.ok(![slugOnlyPr.title, slugOnlyPr.headRefName, slugOnlyPr.body].some((s) => s.toLowerCase().includes(idNeedle)),
    'fixture sanity: the PR must not literally contain the raw ticket identifier anywhere');

  const { backlog, spawn } = createMockAdapters([story], cfg.AGENTS);
  let scanCalls = 0;
  backlog.listCandidatePullRequests = () => { scanCalls++; return [slugOnlyPr]; };
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  const advanced = log.byEvent('advance').find((e) => e.identifier === story.identifier && e.to === 'done');
  assert.ok(advanced, 'the slug-only-matching merged PR should have advanced the in_review story to done (detectVerifiedDone via prMatchesStory)');
  assert.equal(scanCalls, 1, 'listCandidatePullRequests should have been called exactly once for this cycle');
});

test('the board-wide PR candidate scan runs a BOUNDED number of times per cycle(), not once per in_review/done issue', async () => {
  const AURIGA = projectId('Auriga');
  // 5 in_review + 5 done issues: every one of them independently needs a
  // "does this issue have a matching PR" answer across several passes
  // (verified-done, cascade guard, review-dispatch openPrIds, false-done).
  // Pre-fix, backlog.getIssuePullRequests re-ran its own full repo scan on
  // EVERY one of those lookups (O(issues) scans); post-fix, the scan must
  // happen once, at the top of cycle(), and be reused for all of them.
  const issues = [
    ...Array.from({ length: 5 }, () => makeIssue({ project_id: AURIGA, status: 'in_review', parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 5 }, () => makeIssue({ project_id: AURIGA, status: 'done', parent_issue_id: 'fake-parent' })),
  ];
  const { backlog, spawn } = createMockAdapters(issues, cfg.AGENTS);
  let scanCalls = 0;
  backlog.listCandidatePullRequests = () => { scanCalls++; return []; };
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(scanCalls, 1, `expected the board-wide PR scan to run exactly once per cycle() regardless of issue count (10 issues), got ${scanCalls} calls`);
});

// ---- regression coverage for the p2-adapter-interface follow-up cleanup:
// "route new todos" now calls spawn.dispatch() instead of hand-rolling
// assign -> verify -> force-rerun inline. These two tests drive dispatch()'s
// OTHER two return-shape branches (assign failure; assign-ok-but-no-run)
// through the real cycle() call path, proving the centralization preserves
// the exact same assign_error / verify_no_run / rerun_error log events and
// payloads the old inline code produced.

test('route new todos: a dispatch() assign failure logs assign_error with the same identifier/agent/error shape as before centralization', async () => {
  const AURIGA = projectId('Auriga');
  const story = makeIssue({ project_id: AURIGA, parent_issue_id: 'fake-parent' });
  const { backlog, spawn } = createMockAdapters([story], cfg.AGENTS, {
    failAssignFor: new Set([story.identifier]),
  });
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 0, 'a failed assign must not count towards assigned');
  const errs = log.byEvent('assign_error');
  assert.equal(errs.length, 1);
  assert.equal(errs[0].identifier, story.identifier);
  assert.match(errs[0].error, /rate limited/);
  assert.equal(log.byEvent('verify_no_run').length, 0, 'verify must never run after a failed assign');
  assert.equal(log.byEvent('verify_ok').length, 0);
});

test('route new todos: dispatch() reporting started:false logs verify_no_run and the mock\'s force-rerun is observed via spawn.calls.rerun', async () => {
  const AURIGA = projectId('Auriga');
  const story = makeIssue({ project_id: AURIGA, parent_issue_id: 'fake-parent' });
  const { backlog, spawn, calls } = createMockAdapters([story], cfg.AGENTS, {
    noRunFor: new Set([story.identifier]),
  });
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1, 'a successful assign (even with no run yet) still counts towards assigned');
  const noRun = log.byEvent('verify_no_run');
  assert.equal(noRun.length, 1);
  assert.equal(noRun[0].identifier, story.identifier);
  assert.equal(noRun[0].action, 'rerun');
  assert.equal(log.byEvent('verify_ok').length, 0);
  assert.ok(calls.rerun.some((c) => c.identifier === story.identifier), 'dispatch() must have force-reran the story');
});
