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

// PRUNED 2026-08-29: projects.json's 4 aligned-repo entries (Auriga/Heimdall/
// Consus/the original stale-workspace Pantheon Core) were removed — they were
// scoped to a Multica workspace this host no longer talks to (confirmed live:
// GET /api/projects against the real, current workspace returns only one
// project). 'Pantheon Core' is now the only real, dispatch-eligible project,
// so most tests below that just needed SOME valid real project id switched to
// it directly. The two tests that specifically need MULTIPLE, DIFFERENTLY-
// laned projects (AC1's hive-vs-default-lane contrast, AC3's per-lane-cap
// coverage) can no longer get that from real, live data — they now build a
// small synthetic cfg overlay (fixture ids never registered in projects.json)
// carrying the exact same lane shapes the old real Auriga/Heimdall/Consus
// entries had, so the routing behavior under test is unchanged.
function withFixtureLanes(projectLaneOverrides) {
  return {
    ...cfg,
    PROJECT_IDS: [...cfg.PROJECT_IDS, ...Object.keys(projectLaneOverrides)],
    PROJECT_LANE: { ...cfg.PROJECT_LANE, ...projectLaneOverrides },
  };
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
// which is what cycle()'s own inline "route new todos" verify step
// (backlog.getIssueRuns, right after spawn.assignIssue()) is checking for.
// Without it every assignment would fall through to verify_no_run -> rerun,
// which is real router behavior but not what these dispatch-shape tests are
// exercising (mirrors mock-mca.mjs's own doc comment on this exact
// synthesis).
// opts.failAssignFor / opts.noRunFor: identifier sets letting a test drive
// the inline sequence's OTHER two branches (assign failure;
// assign-succeeds-but-no-run -> force-rerun) through the real cycle() call
// path, the same way spawn-adapter.test.mjs drives dispatch()'s equivalent
// branches directly against the real (unused-by-cycle()) adapter method.
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

  const spawn = {
    assignIssue: (identifier, agentName) => {
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
  const fixtureCfg = withFixtureLanes({ 'fixture-auriga-project': ['auriga-dev'] }); // default (non-hive) lane here is codex-only auriga-dev
  const hiveStory = makeIssue({ project_id: 'fixture-auriga-project', labels: ['build'] }); // 'build' is a HIVE_LABEL
  const { backlog, spawn, calls } = createMockAdapters([hiveStory], fixtureCfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

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
  const fixtureCfg = withFixtureLanes({
    'fixture-auriga-project': ['auriga-dev'], // single-agent lane: auriga-dev (codex)
    'fixture-heimdall-project': ['heimdall-dev', 'heimdall-dev-codex'], // two-agent lane: opencode + codex
    'fixture-consus-project': ['consus-dev'], // single-agent lane: consus-dev (claude)
  });
  const PANTHEON_CORE = projectId('Pantheon Core'); // single-agent lane: auriga-build (claude), real

  // Each carries a fake parent_issue_id so isSeed() short-circuits false (not
  // top-level) — these are meant to be plain build-lane candidates, not seeds.
  const issues = [
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: 'fixture-auriga-project', parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 4 }, () => makeIssue({ project_id: 'fixture-heimdall-project', parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: 'fixture-consus-project', parent_issue_id: 'fake-parent' })),
    ...Array.from({ length: 2 }, () => makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: 'fake-parent' })),
  ];
  assert.equal(issues.length, 12); // more candidates than perCycleTotal, so the cap is actually exercised

  const { backlog, spawn, calls } = createMockAdapters(issues, fixtureCfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

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
  const AURIGA = projectId('Pantheon Core'); // 'Auriga' pruned 2026-08-29 (stale workspace); this test doesn't care which real, dispatch-eligible project it uses
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
  const AURIGA = projectId('Pantheon Core'); // 'Auriga' pruned 2026-08-29 (stale workspace); this test doesn't care which real, dispatch-eligible project it uses
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

// ---- review-dispatch tenant scoping (2026-09-13) --------------------------
// Regression for a real cross-tenant leak found live while removing the
// GitHub PR-gate from reviewEligible/selectReviewDispatch: `inReview` (used
// for review-DISPATCH, not just observation) was never filtered to cfg's own
// PROJECT_IDS, unlike selectAssignments' build-dispatch path. This was
// previously masked by the GitHub PR-gate (a foreign tenant's ticket almost
// never had a PR this tenant's own repo scan would find) — removing that
// gate exposed the real gap: any tenant's Auriga instance could try to
// dispatch review for ANOTHER tenant's in_review ticket to its own
// review-lane agent. Confirmed live 2026-09-13 (firefly-events instance
// attempted to dispatch review for a real PANT-* dostal-tech ticket).
test('selectReviewDispatch is never handed another tenant\'s in_review issue — dispatch stays scoped to cfg.PROJECT_IDS', async () => {
  const OWN_PROJECT = projectId('Pantheon Core');
  const ownIssue = makeIssue({ project_id: OWN_PROJECT, status: 'in_review' });
  const foreignIssue = makeIssue({ project_id: 'foreign-tenant-project', status: 'in_review' });
  const { backlog, spawn, calls } = createMockAdapters([ownIssue, foreignIssue], cfg.AGENTS);
  // Simulate the REAL production adapter's board-wide discovery: listAllProjectIds
  // returns every project it knows about, including ones outside this tenant's
  // own cfg.PROJECT_IDS — createMockAdapters' default listAllProjectIds (`[]`)
  // would incidentally scope `issues` to cfg.PROJECT_IDS alone, hiding this bug.
  backlog.listAllProjectIds = () => [OWN_PROJECT, 'foreign-tenant-project'];
  backlog.listAllIssues = (projectIds) => [ownIssue, foreignIssue].filter((i) => projectIds.includes(i.project_id));
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  const reviewAssigns = calls.assign.filter((a) => cfg.REVIEW_LANE.includes(a.agentName));
  assert.equal(reviewAssigns.length, 1, `expected exactly one review dispatch (this tenant's own ticket), got ${reviewAssigns.length}`);
  assert.equal(reviewAssigns[0].identifier, ownIssue.identifier);
  assert.ok(
    !reviewAssigns.some((a) => a.identifier === foreignIssue.identifier),
    'must never dispatch review for a ticket outside cfg.PROJECT_IDS',
  );
});

// PANT-40 regression, continued: the review-dispatch leak above was one of SIX
// status-mutating passes that shared the same unscoped-board-read bug (unblock,
// parent-rollup, run-completion, review-dispatch, changeback, false-done). This
// test covers the other four that can be triggered without a live PR-matching
// setup (false-done requires an authoritative matched open PR — see
// detectFalseDone/ownPrUrl — and is exercised by its own dedicated PR-matching
// tests elsewhere; PROJECT_IDS-scoping for it is the same one-line guard as the
// rest and was fixed identically in auriga-router.mjs). Every pass below seeds
// one own-tenant issue and one foreign-tenant issue in the exact shape that
// pass's detect* function requires to fire, then asserts only the own-tenant
// issue's board state actually changed.
test('unblock / parent-rollup / run-completion / changeback all stay scoped to cfg.PROJECT_IDS — PANT-40 regression', async () => {
  const OWN_PROJECT = projectId('Pantheon Core');
  const FOREIGN_PROJECT = 'foreign-tenant-project';

  // ---- unblock: blocked issue whose declared dep is already done ----
  const ownDep = makeIssue({ project_id: OWN_PROJECT, status: 'done' });
  const ownBlocked = makeIssue({ project_id: OWN_PROJECT, status: 'blocked', metadata: { depends_on: ownDep.id } });
  const foreignDep = makeIssue({ project_id: FOREIGN_PROJECT, status: 'done' });
  const foreignBlocked = makeIssue({ project_id: FOREIGN_PROJECT, status: 'blocked', metadata: { depends_on: foreignDep.id } });

  // ---- parent-rollup: parent whose only child is already terminal ----
  const ownParent = makeIssue({ project_id: OWN_PROJECT, status: 'todo' });
  const ownChild = makeIssue({ project_id: OWN_PROJECT, status: 'done', parent_issue_id: ownParent.id });
  const foreignParent = makeIssue({ project_id: FOREIGN_PROJECT, status: 'todo' });
  const foreignChild = makeIssue({ project_id: FOREIGN_PROJECT, status: 'done', parent_issue_id: foreignParent.id });

  // ---- run-completion: in_progress issue whose latest run already completed ----
  const ownInProgress = makeIssue({ project_id: OWN_PROJECT, status: 'in_progress' });
  const foreignInProgress = makeIssue({ project_id: FOREIGN_PROJECT, status: 'in_progress' });

  // ---- changeback: changes_requested issue, no other precondition ----
  const ownChangeback = makeIssue({ project_id: OWN_PROJECT, status: 'changes_requested', assignee_id: 'someone' });
  const foreignChangeback = makeIssue({ project_id: FOREIGN_PROJECT, status: 'changes_requested', assignee_id: 'someone' });

  const boardIssues = [
    ownDep, ownBlocked, foreignDep, foreignBlocked,
    ownParent, ownChild, foreignParent, foreignChild,
    ownInProgress, foreignInProgress,
    ownChangeback, foreignChangeback,
  ];
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters(boardIssues, cfg.AGENTS);
  // Same real-adapter simulation as the review-dispatch test above: board-wide
  // discovery must span both tenants' projects for this bug class to be
  // observable at all.
  backlog.listAllProjectIds = () => [OWN_PROJECT, FOREIGN_PROJECT];
  backlog.listAllIssues = (projectIds) => boardIssues.filter((i) => projectIds.includes(i.project_id));
  runsByIdentifier[ownInProgress.identifier] = [{ status: 'completed', created_at: new Date().toISOString() }];
  runsByIdentifier[foreignInProgress.identifier] = [{ status: 'completed', created_at: new Date().toISOString() }];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  const statusFor = (identifier) => calls.status.filter((s) => s.identifier === identifier);

  // unblock
  assert.deepEqual(statusFor(ownBlocked.identifier).map((s) => s.status), ['todo'], 'own-tenant blocked issue must unblock to todo');
  assert.deepEqual(statusFor(foreignBlocked.identifier), [], 'foreign-tenant blocked issue must never be touched');

  // parent-rollup
  assert.deepEqual(statusFor(ownParent.identifier).map((s) => s.status), ['done'], 'own-tenant parent must roll up to done');
  assert.deepEqual(statusFor(foreignParent.identifier), [], 'foreign-tenant parent must never be touched');

  // run-completion
  assert.deepEqual(statusFor(ownInProgress.identifier).map((s) => s.status), ['in_review'], 'own-tenant in_progress issue must advance to in_review');
  assert.deepEqual(statusFor(foreignInProgress.identifier), [], 'foreign-tenant in_progress issue must never be touched');

  // changeback
  assert.deepEqual(statusFor(ownChangeback.identifier).map((s) => s.status), ['todo'], 'own-tenant changes_requested issue must go back to todo');
  assert.deepEqual(statusFor(foreignChangeback.identifier), [], 'foreign-tenant changes_requested issue must never be touched');
  assert.ok(calls.unassign.some((u) => u.identifier === ownChangeback.identifier), 'own-tenant changeback must unassign');
  assert.ok(!calls.unassign.some((u) => u.identifier === foreignChangeback.identifier), 'foreign-tenant changeback must never unassign');
});

// ---- regression coverage for "route new todos"'s inline assign -> verify ->
// force-rerun sequence (see auriga-router.mjs's cycle() — this pass is
// deliberately NOT routed through spawn.dispatch(), even though dispatch()
// ports the identical sequence, because dispatch()'s verify-wait is a real
// synchronous block unsuited to this long-lived daemon process; see that
// pass's own comment and spawn-adapter.mjs's typedef). These two tests drive
// the inline sequence's OTHER two branches (assign failure;
// assign-ok-but-no-run -> force-rerun) through the real cycle() call path,
// proving it produces the expected assign_error / verify_no_run / rerun_error
// log events and payloads.

test('route new todos: an assign failure logs assign_error with the expected identifier/agent/error shape', async () => {
  const AURIGA = projectId('Pantheon Core'); // 'Auriga' pruned 2026-08-29 (stale workspace); this test doesn't care which real, dispatch-eligible project it uses
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

test('route new todos: no run row appearing within the verify wait logs verify_no_run and force-reruns (observed via spawn.calls.rerun)', async () => {
  const AURIGA = projectId('Pantheon Core'); // 'Auriga' pruned 2026-08-29 (stale workspace); this test doesn't care which real, dispatch-eligible project it uses
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
  assert.ok(calls.rerun.some((c) => c.identifier === story.identifier), 'the inline verify step must have force-reran the story');
});

// ---- GH #75 / t001-zombie-give-up: bounded zombie-recovery attempts -------
// Once an in_progress issue's run count reaches cfg.CAPS.zombieMaxAttempts,
// detectZombies emits 'give-up' instead of 'assign'/'rerun'. The router must
// never actuate (assignIssue/rerunIssue) for that action, must log
// zombie_give_up, set the issue status to blocked, and best-effort comment.

test('zombie give-up: an issue at the attempt cap never gets assignIssue/rerunIssue, logs zombie_give_up, sets blocked, and gets a best-effort comment', async () => {
  const AURIGA = projectId('Pantheon Core');
  const stale = Date.now() - (60 * 60 * 1000); // 1h old, well past zombieStaleMs
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A' });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([stuckIssue], cfg.AGENTS);
  // Pre-seed run history AT the cap (cfg.CAPS.zombieMaxAttempts) so detectZombies
  // gives up on it instead of recovering it.
  runsByIdentifier[stuckIssue.identifier] = Array.from({ length: cfg.CAPS.zombieMaxAttempts }, () => ({
    status: 'failed', error: 'boom', created_at: new Date(stale).toISOString(),
  }));
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.ok(!calls.assign.some((c) => c.identifier === stuckIssue.identifier), 'give-up must never call spawn.assignIssue for this issue');
  assert.ok(!calls.rerun.some((c) => c.identifier === stuckIssue.identifier), 'give-up must never call spawn.rerunIssue for this issue');

  const giveUps = log.byEvent('zombie_give_up');
  assert.equal(giveUps.length, 1);
  assert.equal(giveUps[0].identifier, stuckIssue.identifier);
  assert.equal(giveUps[0].action, 'give-up');

  const blockedStatus = calls.status.find((s) => s.identifier === stuckIssue.identifier && s.status === 'blocked');
  assert.ok(blockedStatus, 'give-up must set issue status to blocked');

  assert.equal(calls.comment.length, 1, 'give-up should best-effort comment on the issue');
  assert.equal(calls.comment[0].identifier, stuckIssue.identifier);
  assert.ok(calls.comment[0].body.includes('blocked'), 'give-up comment must mention blocked status');
});

test('zombie give-up: a comment failure is swallowed and never crashes the cycle', async () => {
  const AURIGA = projectId('Pantheon Core');
  const stale = Date.now() - (60 * 60 * 1000);
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A' });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([stuckIssue], cfg.AGENTS);
  runsByIdentifier[stuckIssue.identifier] = Array.from({ length: cfg.CAPS.zombieMaxAttempts }, () => ({
    status: 'failed', error: 'boom', created_at: new Date(stale).toISOString(),
  }));
  backlog.commentOnIssue = () => { throw new Error('comment API down'); };
  const log = createLogSink();

  await assert.doesNotReject(cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP }));

  assert.ok(!calls.assign.some((c) => c.identifier === stuckIssue.identifier));
  assert.ok(!calls.rerun.some((c) => c.identifier === stuckIssue.identifier));
  assert.equal(log.byEvent('zombie_give_up').length, 1);
  assert.equal(log.byEvent('zombie_give_up_error').length, 1);
  // setIssueStatus(blocked) still succeeded even though comment failed
  assert.ok(calls.status.some((s) => s.identifier === stuckIssue.identifier && s.status === 'blocked'));
});

test('zombie give-up: a setIssueStatus failure is swallowed and never crashes the cycle', async () => {
  const AURIGA = projectId('Pantheon Core');
  const stale = Date.now() - (60 * 60 * 1000);
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A' });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([stuckIssue], cfg.AGENTS);
  runsByIdentifier[stuckIssue.identifier] = Array.from({ length: cfg.CAPS.zombieMaxAttempts }, () => ({
    status: 'failed', error: 'boom', created_at: new Date(stale).toISOString(),
  }));
  backlog.setIssueStatus = () => { throw new Error('status API down'); };
  const log = createLogSink();

  await assert.doesNotReject(cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP }));

  assert.equal(log.byEvent('zombie_give_up').length, 1);
  assert.equal(log.byEvent('zombie_give_up_error').length, 1);
  // comment is still attempted even if setIssueStatus failed
  assert.equal(calls.comment.length, 1);
  assert.equal(calls.comment[0].identifier, stuckIssue.identifier);
});

// ---- PANT-409: zombie assign path must call rerunIssue after assignIssue ----

test('zombie assign: an unassigned in_progress zombie gets assignIssue then rerunIssue (PANT-409)', async () => {
  const AURIGA = projectId('Pantheon Core');
  const stale = Date.now() - (60 * 60 * 1000);
  // No assignee_id → detectZombies emits action:'assign'
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: null });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([stuckIssue], cfg.AGENTS);
  runsByIdentifier[stuckIssue.identifier] = [
    { status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() },
  ];
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1, 'zombie assign must count towards assigned');
  assert.ok(calls.assign.some((c) => c.identifier === stuckIssue.identifier), 'zombie assign must call assignIssue');
  assert.ok(calls.rerun.some((c) => c.identifier === stuckIssue.identifier), 'zombie assign must call rerunIssue after assignIssue (PANT-409)');
  const zombieLogs = log.byEvent('zombie');
  assert.ok(zombieLogs.some((z) => z.identifier === stuckIssue.identifier), 'zombie event must be logged');
});

// ---- t015: orchestrator hand-up (real cycle()-level, not just selectAssignments) ----

function saturateAgent(fixtureCfg, agentName, projectId, n) {
  return Array.from({ length: n }, () =>
    makeIssue({ project_id: projectId, status: 'in_progress', assignee_id: fixtureCfg.AGENTS[agentName].id }));
}

test('t015: a hand-up-labeled issue with no local capacity and a configured parent creates a ticket on the parent board and cleans up locally', async () => {
  const fixtureCfg = withFixtureLanes({ 'fixture-handup-project': ['auriga-dev'] });
  const saturating = saturateAgent(fixtureCfg, 'auriga-dev', 'fixture-handup-project', fixtureCfg.AGENTS['auriga-dev'].maxInflight);
  const handUpIssue = makeIssue({
    project_id: 'fixture-handup-project', labels: ['hand-up'], parent_issue_id: 'fixture-epic',
    title: 'Needs a cross-project architecture decision', description: 'out of scope for this instance',
  });
  const { backlog, spawn, calls } = createMockAdapters([...saturating, handUpIssue], fixtureCfg.AGENTS);
  const log = createLogSink();

  const remoteCreateCalls = [];
  const createRemoteBacklog = (remoteCfg) => ({
    createIssue: (ticket) => {
      remoteCreateCalls.push({ remoteCfg, ticket });
      return { identifier: 'PARENT-1', title: ticket.title };
    },
  });

  await cycle({
    backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP,
    loadTopology: () => ({ parent: { id: 'firefly-events' }, children: [] }),
    loadExternalConfig: () => ({ parentBoard: { baseUrl: 'http://firefly-core-api:3012', projectId: 'firefly-proj-1' } }),
    createRemoteBacklog,
  });

  assert.ok(!calls.assign.some((c) => c.identifier === handUpIssue.identifier), 'must NOT be dispatched to a local agent');

  assert.equal(remoteCreateCalls.length, 1);
  assert.equal(remoteCreateCalls[0].remoteCfg.baseUrl, 'http://firefly-core-api:3012');
  assert.equal(remoteCreateCalls[0].remoteCfg.project, 'firefly-proj-1');
  assert.equal(remoteCreateCalls[0].ticket.title, handUpIssue.title);
  assert.deepEqual(remoteCreateCalls[0].ticket.metadata, { handed_up_from: handUpIssue.identifier });

  assert.ok(calls.unassign.some((c) => c.identifier === handUpIssue.identifier), 'must unassign the original locally');
  assert.ok(calls.comment.some((c) => c.identifier === handUpIssue.identifier), 'must comment on the original locally');
  assert.ok(calls.status.some((c) => c.identifier === handUpIssue.identifier && c.status === 'cancelled'), 'must close the original locally');

  assert.equal(log.byEvent('hand_up').length, 1);
  assert.equal(log.byEvent('hand_up_ok').length, 1);
  assert.equal(log.byEvent('hand_up_ok')[0].newIdentifier, 'PARENT-1');
});

test('t015: no configured parent -- zero remote calls, ticket falls through to the normal human-todo/unassigned pool unchanged', async () => {
  const fixtureCfg = withFixtureLanes({ 'fixture-handup-project': ['auriga-dev'] });
  const saturating = saturateAgent(fixtureCfg, 'auriga-dev', 'fixture-handup-project', fixtureCfg.AGENTS['auriga-dev'].maxInflight);
  const handUpIssue = makeIssue({ project_id: 'fixture-handup-project', labels: ['hand-up'], parent_issue_id: 'fixture-epic' });
  const { backlog, spawn, calls } = createMockAdapters([...saturating, handUpIssue], fixtureCfg.AGENTS);
  const log = createLogSink();

  const createRemoteBacklog = () => { throw new Error('must never be constructed with no configured parent'); };

  await cycle({
    backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP,
    loadTopology: () => ({ parent: null, children: [] }),
    loadExternalConfig: () => ({}),
    createRemoteBacklog,
  });

  assert.ok(!calls.assign.some((c) => c.identifier === handUpIssue.identifier));
  assert.ok(!calls.unassign.some((c) => c.identifier === handUpIssue.identifier));
  assert.ok(!calls.status.some((c) => c.identifier === handUpIssue.identifier));
  assert.equal(log.byEvent('hand_up').length, 0);
});

test('t015: a remote create failure logs hand_up_error, undoes the pre-cancel, and applies no comment/unassign side effects', async () => {
  const fixtureCfg = withFixtureLanes({ 'fixture-handup-project': ['auriga-dev'] });
  const saturating = saturateAgent(fixtureCfg, 'auriga-dev', 'fixture-handup-project', fixtureCfg.AGENTS['auriga-dev'].maxInflight);
  const handUpIssue = makeIssue({ project_id: 'fixture-handup-project', labels: ['hand-up'], parent_issue_id: 'fixture-epic' });
  const { backlog, spawn, calls } = createMockAdapters([...saturating, handUpIssue], fixtureCfg.AGENTS);
  const log = createLogSink();

  const createRemoteBacklog = () => ({
    createIssue: () => { throw new Error('parent board unreachable'); },
  });

  await assert.doesNotReject(cycle({
    backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP,
    loadTopology: () => ({ parent: { id: 'firefly-events' }, children: [] }),
    loadExternalConfig: () => ({ parentBoard: { baseUrl: 'http://firefly-core-api:3012', projectId: 'firefly-proj-1' } }),
    createRemoteBacklog,
  }));

  assert.ok(!calls.unassign.some((c) => c.identifier === handUpIssue.identifier), 'no local unassign on remote failure');
  assert.ok(!calls.comment.some((c) => c.identifier === handUpIssue.identifier), 'no local comment on remote failure');
  // Pre-cancel (→ cancelled) fires before createIssue, then undo (→ todo) fires on failure.
  const statusCalls = calls.status.filter((c) => c.identifier === handUpIssue.identifier);
  assert.ok(statusCalls.some((c) => c.status === 'cancelled'), 'pre-cancel must be attempted before remote create');
  assert.ok(statusCalls.some((c) => c.status === 'todo'), 'undo-cancel must be attempted after remote create failure');
  assert.equal(handUpIssue.status, 'todo', 'net status must be restored to todo so the issue re-enters the candidate pool');
  assert.equal(log.byEvent('hand_up_error').length, 1);
  assert.equal(log.byEvent('hand_up_ok').length, 0);
});

test('t015: if the pre-cancel fails the remote create is skipped entirely — no duplicate and issue retains todo status', async () => {
  const fixtureCfg = withFixtureLanes({ 'fixture-handup-project': ['auriga-dev'] });
  const saturating = saturateAgent(fixtureCfg, 'auriga-dev', 'fixture-handup-project', fixtureCfg.AGENTS['auriga-dev'].maxInflight);
  const handUpIssue = makeIssue({ project_id: 'fixture-handup-project', labels: ['hand-up'], parent_issue_id: 'fixture-epic' });
  const { backlog, spawn, calls } = createMockAdapters([...saturating, handUpIssue], fixtureCfg.AGENTS);
  const log = createLogSink();

  // Patch backlog to throw on setIssueStatus for this identifier only.
  const origSetStatus = backlog.setIssueStatus;
  backlog.setIssueStatus = (id, status) => {
    if (id === handUpIssue.identifier) throw new Error('transient API error');
    origSetStatus(id, status);
  };

  const remoteCreateCalls = [];
  const createRemoteBacklog = () => ({
    createIssue: (ticket) => { remoteCreateCalls.push(ticket); return { identifier: 'PARENT-1' }; },
  });

  await assert.doesNotReject(cycle({
    backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP,
    loadTopology: () => ({ parent: { id: 'firefly-events' }, children: [] }),
    loadExternalConfig: () => ({ parentBoard: { baseUrl: 'http://firefly-core-api:3012', projectId: 'firefly-proj-1' } }),
    createRemoteBacklog,
  }));

  assert.equal(remoteCreateCalls.length, 0, 'remote create must not be called when pre-cancel fails');
  assert.equal(handUpIssue.status, 'todo', 'issue must remain todo for retry next cycle');
  assert.ok(!calls.unassign.some((c) => c.identifier === handUpIssue.identifier), 'no unassign when pre-cancel fails');
  assert.ok(!calls.comment.some((c) => c.identifier === handUpIssue.identifier), 'no comment when pre-cancel fails');
  assert.equal(log.byEvent('hand_up_pre_cancel_error').length, 1);
  assert.equal(log.byEvent('hand_up_ok').length, 0);
});

// ---- review changes_requested -> todo (changeback) --------------------------

test('changeback: a changes_requested issue is set back to todo and unassigned within one cycle', async () => {
  const AURIGA = projectId('Pantheon Core');
  const reviewAgentId = cfg.AGENTS['auriga-review'] && cfg.AGENTS['auriga-review'].id;
  const issue = makeIssue({
    project_id: AURIGA,
    status: 'changes_requested',
    assignee_id: reviewAgentId,
    parent_issue_id: 'fake-parent',
  });
  const { backlog, spawn, calls } = createMockAdapters([issue], cfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP });

  // Router must have set the issue back to todo.
  assert.ok(calls.status.some((c) => c.identifier === issue.identifier && c.status === 'todo'),
    'changes_requested story must be set back to todo');
  // Router must have unassigned it so the build lane can pick it up.
  assert.ok(calls.unassign.some((c) => c.identifier === issue.identifier),
    'changes_requested story must be unassigned');
  // The advance log event must carry the correct from/to shape.
  const advance = log.byEvent('advance').find((e) =>
    e.identifier === issue.identifier && e.from === 'changes_requested' && e.to === 'todo');
  assert.ok(advance, 'advance log event must record the changes_requested -> todo transition');
});

test('changeback: an unassign failure is swallowed and never crashes the cycle', async () => {
  const AURIGA = projectId('Pantheon Core');
  const reviewAgentId = cfg.AGENTS['auriga-review'] && cfg.AGENTS['auriga-review'].id;
  const issue = makeIssue({
    project_id: AURIGA,
    status: 'changes_requested',
    assignee_id: reviewAgentId,
    parent_issue_id: 'fake-parent',
  });
  const { backlog, spawn, calls } = createMockAdapters([issue], cfg.AGENTS);
  spawn.unassignIssue = (identifier) => {
    calls.unassign.push({ identifier });
    throw new Error('unassign API down');
  };
  const log = createLogSink();

  await assert.doesNotReject(cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP }));

  assert.ok(calls.status.some((c) => c.identifier === issue.identifier && c.status === 'todo'),
    'setIssueStatus to todo must still succeed even when unassign throws');
  assert.equal(log.byEvent('changeback_unassign_error').length, 1);
  assert.equal(log.byEvent('changeback_unassign_error')[0].identifier, issue.identifier);
});

test('changeback: dry-run does NOT call setIssueStatus or unassignIssue, but logs the advance', async () => {
  const AURIGA = projectId('Pantheon Core');
  const issue = makeIssue({
    project_id: AURIGA,
    status: 'changes_requested',
    assignee_id: 'some-review-agent',
    parent_issue_id: 'fake-parent',
  });
  const { backlog, spawn, calls } = createMockAdapters([issue], cfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, dryRun: true });

  assert.ok(!calls.status.some((c) => c.identifier === issue.identifier),
    'dry-run must not call setIssueStatus');
  assert.ok(!calls.unassign.some((c) => c.identifier === issue.identifier),
    'dry-run must not call unassignIssue');
  const advance = log.byEvent('advance').find((e) =>
    e.identifier === issue.identifier && e.from === 'changes_requested' && e.to === 'todo');
  assert.ok(advance, 'dry-run must still log the advance event');
  assert.equal(advance.applied, false);
});

// ---- s14: multi-tenant consolidation loop shape (2026-09-21) --------------
// Not another single-cycle scoping test (PANT-40 above already covers that
// exhaustively) -- this proves the specific NEW shape mainMultiTenant()
// introduces: TWO SEQUENTIAL cycle() calls, each with a different tenant's
// own cfg/adapters, sharing one real underlying board (as they would in
// production, since both go through the same Pantheon core-api). Confirms
// the second tenant's cycle() call cannot see or touch the first tenant's
// dispatch, and vice versa -- the real risk this loop shape introduces that
// a single cycle() call's own internal scoping can't by itself guarantee.
test('s14: two sequential per-tenant cycle() calls against one shared board never cross-dispatch', async () => {
  const tenantACfg = withFixtureLanes({ 'tenant-a-project': ['auriga-dev'] });
  const tenantBCfg = withFixtureLanes({ 'tenant-b-project': ['auriga-dev'] });
  const issueA = makeIssue({ project_id: 'tenant-a-project' });
  const issueB = makeIssue({ project_id: 'tenant-b-project' });
  const sharedBoard = [issueA, issueB];

  const adaptersA = createMockAdapters(sharedBoard, tenantACfg.AGENTS);
  const adaptersB = createMockAdapters(sharedBoard, tenantBCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog: adaptersA.backlog, spawn: adaptersA.spawn, cfg: tenantACfg, log, sleep: NOOP_SLEEP });
  await cycle({ backlog: adaptersB.backlog, spawn: adaptersB.spawn, cfg: tenantBCfg, log, sleep: NOOP_SLEEP });

  assert.deepEqual(adaptersA.calls.assign.map((a) => a.identifier), [issueA.identifier],
    "tenant A's cycle() must only ever dispatch tenant A's own issue");
  assert.deepEqual(adaptersB.calls.assign.map((a) => a.identifier), [issueB.identifier],
    "tenant B's cycle() must only ever dispatch tenant B's own issue");
  assert.ok(issueA.assignee_id, "tenant A's issue must have been assigned");
  assert.ok(issueB.assignee_id, "tenant B's issue must have been assigned");
});

// ---- maxAssign in simulated multi-tenant loop (2026-09-21) ----------------
// mainMultiTenant() was not threading MAX_ASSIGN into cycle() calls at all,
// so --max-assign was silently ignored in multi-tenant mode. The fix tracks
// totalAssigned and passes maxAssign: remaining to each tenant's cycle().
// This test simulates the mainMultiTenant loop shape: two sequential cycle()
// calls sharing a totalAssigned budget of 1. After the first dispatch,
// remaining=0 and the second tenant's cycle must dispatch nothing.
test('s14: maxAssign budget is shared across sequential per-tenant cycle() calls (simulates mainMultiTenant MAX_ASSIGN threading)', async () => {
  const tenantACfg = withFixtureLanes({ 'tenant-a-project': ['auriga-dev'] });
  const tenantBCfg = withFixtureLanes({ 'tenant-b-project': ['auriga-dev'] });
  const issueA = makeIssue({ project_id: 'tenant-a-project' });
  const issueB = makeIssue({ project_id: 'tenant-b-project' });
  const sharedBoard = [issueA, issueB];

  const adaptersA = createMockAdapters(sharedBoard, tenantACfg.AGENTS);
  const adaptersB = createMockAdapters(sharedBoard, tenantBCfg.AGENTS);
  const log = createLogSink();

  const MAX_ASSIGN = 1;
  let totalAssigned = 0;

  // Tenant A's cycle: remaining budget = 1
  const resultA = await cycle({ backlog: adaptersA.backlog, spawn: adaptersA.spawn, cfg: tenantACfg, log, sleep: NOOP_SLEEP, maxAssign: Math.max(0, MAX_ASSIGN - totalAssigned) });
  totalAssigned += resultA.assigned;

  // Tenant B's cycle: remaining budget = 0 (A used it all)
  const remaining = Math.max(0, MAX_ASSIGN - totalAssigned);
  const resultB = await cycle({ backlog: adaptersB.backlog, spawn: adaptersB.spawn, cfg: tenantBCfg, log, sleep: NOOP_SLEEP, maxAssign: remaining });
  totalAssigned += resultB.assigned;

  assert.equal(totalAssigned, 1, 'total dispatches must not exceed maxAssign=1');
  assert.equal(adaptersA.calls.assign.length, 1, "tenant A's cycle must dispatch exactly 1 (within budget)");
  assert.equal(adaptersB.calls.assign.length, 0, "tenant B's cycle must dispatch 0 (budget exhausted by A)");
});

// ---- review-sweep findings (2026-09-21, second pass) ----------------------
test('cascade: skips (does not call rerunIssue) when all agents are at capacity', async () => {
  // Set up a single-agent lane (maxInflight:1) that is already saturated by
  // an in_progress issue. A cascade candidate exists (done parent + blocked
  // child with metadata dep). Before the fix, cycle() would call rerunIssue
  // on the blocked child even with no available agent — burning a cascade slot
  // and dispatching on an already-full agent. After the fix, it should log
  // cascade_skip(reason: no-capacity) and leave calls.rerun empty.
  const fixtureCfg = withFixtureLanes({ 'cascade-proj': ['auriga-dev'] });
  // auriga-dev has maxInflight:3 by default. Override to 1 for this test.
  const tightCfg = {
    ...fixtureCfg,
    AGENTS: { ...fixtureCfg.AGENTS, 'auriga-dev': { ...fixtureCfg.AGENTS['auriga-dev'], maxInflight: 1 } },
  };
  const saturatingIssue = makeIssue({ project_id: 'cascade-proj', status: 'in_progress', assignee_id: tightCfg.AGENTS['auriga-dev'].id });
  const doneParent = makeIssue({ project_id: 'cascade-proj', status: 'done' });
  const blockedChild = makeIssue({ project_id: 'cascade-proj', status: 'blocked', metadata: { depends_on: doneParent.id } });
  const { backlog, spawn, calls } = createMockAdapters([saturatingIssue, doneParent, blockedChild], tightCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(!calls.rerun.some((r) => r.identifier === blockedChild.identifier),
    'cascade must NOT rerun a blocked child when no agent has capacity');
  const skipLog = log.byEvent('cascade_skip').find((e) => e.identifier === blockedChild.identifier && e.reason === 'no-capacity');
  assert.ok(skipLog, 'cascade_skip(no-capacity) must be logged when skipping due to full inflight');
});

test('cascade: calls rerunIssue (without reassigning) for BLOCKED issue with existing assignee when no agent has capacity', async () => {
  // PANT-341: the blanket !agent guard was over-broad. A previously-assigned
  // blocked story whose deps cleared should get re-enqueued immediately, not
  // wait for the assigned-idle recovery pass (~10 min). When !agent but
  // assignee_id is set, rerunIssue must fire and assignIssue must NOT fire.
  //
  // Key setup: the dep is in_review (not done) at cycle start. The unblock
  // pass sees it as non-terminal and skips blockedChild. detectVerifiedDone
  // then advances the dep to done (via merged PR), so the CASCADE pass is the
  // FIRST pass that sees blockedChild with satisfied deps — and blockedChild
  // still has its original assignee_id intact at that point.
  const fixtureCfg = withFixtureLanes({ 'cascade-proj-341': ['auriga-dev'] });
  const tightCfg = {
    ...fixtureCfg,
    AGENTS: { ...fixtureCfg.AGENTS, 'auriga-dev': { ...fixtureCfg.AGENTS['auriga-dev'], maxInflight: 1 } },
  };
  const existingAgent = tightCfg.AGENTS['auriga-dev'].id;
  const saturatingIssue = makeIssue({ project_id: 'cascade-proj-341', status: 'in_progress', assignee_id: existingAgent });
  // The dep starts as in_review so the unblock pass doesn't convert blockedChild.
  // detectVerifiedDone will advance it to done (via the merged PR below).
  const inReviewParent = makeIssue({ project_id: 'cascade-proj-341', status: 'in_review' });
  // blocked child already assigned to the agent — this is the PANT-341 case
  const blockedChild = makeIssue({ project_id: 'cascade-proj-341', status: 'blocked', assignee_id: existingAgent, metadata: { depends_on: inReviewParent.id } });
  const { backlog, spawn, calls } = createMockAdapters([saturatingIssue, inReviewParent, blockedChild], tightCfg.AGENTS);
  // Merged PR for the dep: detectVerifiedDone advances inReviewParent to done,
  // satisfying blockedChild's dep for the cascade pass.
  backlog.getIssuePullRequests = (identifier) =>
    identifier === inReviewParent.identifier ? [{ state: 'MERGED', title: inReviewParent.identifier }] : [];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.rerun.some((r) => r.identifier === blockedChild.identifier),
    'cascade MUST call rerunIssue for a blocked child that already has an assignee, even when no new agent has capacity');
  assert.ok(!calls.assign.some((a) => a.identifier === blockedChild.identifier),
    'cascade must NOT call assignIssue when re-enqueueing a previously-assigned blocked child');
  assert.ok(!log.byEvent('cascade_skip').some((e) => e.identifier === blockedChild.identifier),
    'cascade_skip must NOT be logged for a blocked child with an existing assignee');
});

test('maxAssign respected by selectAssignments maxTotal (remaining=0 yields maxTotal=0 not perCycleTotal)', async () => {
  // maxAssign:0 means no assignments should happen. Before the fix,
  // remaining=0 would fall back to perCycleTotal via the || operator, passing
  // a non-zero maxTotal to selectAssignments. The main picks loop's guard
  // still caught regular assigns, but the contract violation exists.
  // This test verifies the direct postcondition: cycle() with maxAssign:0
  // dispatches nothing and returns assigned:0.
  const PANTHEON_CORE = projectId('Pantheon Core');
  const issues = Array.from({ length: 3 }, () => makeIssue({ project_id: PANTHEON_CORE, parent_issue_id: 'fake-parent' }));
  const { backlog, spawn, calls } = createMockAdapters(issues, cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, maxAssign: 0 });

  assert.equal(result.assigned, 0, 'maxAssign:0 must result in zero dispatches');
  assert.equal(calls.assign.length, 0, 'assignIssue must not be called when maxAssign:0');
});

test('cascade: skips (logs redispatch-cooldown) when last run completed within redispatchCooldownMs', async () => {
  // A cascade candidate exists (done parent + blocked child with metadata dep),
  // but the child's most recent run completed only 30 s ago — well within the
  // 15-min cooldown window. The router must NOT assign/rerun the child and must
  // log cascade_skip(reason: 'redispatch-cooldown').
  const fixtureCfg = withFixtureLanes({ 'cooldown-proj': ['auriga-dev'] });
  const FIXED_NOW = Date.now();
  const doneParent = makeIssue({ project_id: 'cooldown-proj', status: 'done' });
  const blockedChild = makeIssue({ project_id: 'cooldown-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneParent.id } });
  const { backlog, spawn, calls, runsByIdentifier, log } = (() => {
    const adapters = createMockAdapters([doneParent, blockedChild], fixtureCfg.AGENTS);
    // Seed a completed run that finished 30 s ago — within cooldown
    const recentCompletedAt = new Date(FIXED_NOW - 30_000).toISOString();
    adapters.runsByIdentifier[blockedChild.identifier] = [
      { status: 'completed', completed_at: recentCompletedAt, created_at: recentCompletedAt },
    ];
    return { ...adapters, log: createLogSink() };
  })();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, now: FIXED_NOW });

  assert.ok(!calls.assign.some((r) => r.identifier === blockedChild.identifier),
    'cascade must NOT assign a child whose last run completed within the cooldown window');
  const skipLog = log.byEvent('cascade_skip').find(
    (e) => e.identifier === blockedChild.identifier && e.reason === 'redispatch-cooldown'
  );
  assert.ok(skipLog, 'cascade_skip(redispatch-cooldown) must be logged for a recently-completed run');
});

test('cascade: dispatches normally when last run completed beyond redispatchCooldownMs', async () => {
  // Same setup, but the run completed 20 min ago — outside the 15-min cooldown.
  // The router must assign and rerun the child as normal.
  const fixtureCfg = withFixtureLanes({ 'cooldown-proj-2': ['auriga-dev'] });
  const FIXED_NOW = Date.now();
  const cooldownMs = cfg.CAPS.redispatchCooldownMs;
  const doneParent = makeIssue({ project_id: 'cooldown-proj-2', status: 'done' });
  const blockedChild = makeIssue({ project_id: 'cooldown-proj-2', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneParent.id } });
  const adapters = createMockAdapters([doneParent, blockedChild], fixtureCfg.AGENTS);
  // Seed a completed run that finished 20 min ago — beyond cooldown
  const oldCompletedAt = new Date(FIXED_NOW - cooldownMs - 5 * 60_000).toISOString();
  adapters.runsByIdentifier[blockedChild.identifier] = [
    { status: 'completed', completed_at: oldCompletedAt, created_at: oldCompletedAt },
  ];
  const log = createLogSink();

  await cycle({ backlog: adapters.backlog, spawn: adapters.spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, now: FIXED_NOW });

  assert.ok(adapters.calls.assign.some((r) => r.identifier === blockedChild.identifier),
    'cascade must dispatch a child whose last run is older than redispatchCooldownMs');
});

// PANT-431: detectVerifiedDone + selectReviewDispatch same-cycle stale-snapshot
// regression. When a merged PR advances an in_review issue to done in the same
// cycle that its review run has gone stale, selectReviewDispatch must NOT emit
// a rerun-review dispatch for it — the issue is already done.
test('an in_review issue advanced to done by a merged PR in the same cycle is never re-dispatched for review (PANT-431)', async () => {
  const AURIGA = projectId('Pantheon Core');
  const FIXED_NOW = Date.now();
  const reviewAgentId = cfg.AGENTS['auriga-review'].id;
  const story = makeIssue({
    project_id: AURIGA,
    status: 'in_review',
    assignee_id: reviewAgentId,
  });
  // Stale run: completed well beyond zombieStaleMs ago so selectReviewDispatch
  // would hit the rerun-review branch if the issue were still present.
  const staleAge = (cfg.CAPS.zombieStaleMs ?? 20 * 60 * 1000) + 60 * 60 * 1000;
  const staleAt = new Date(FIXED_NOW - staleAge).toISOString();
  const { backlog, spawn, calls } = createMockAdapters([story], cfg.AGENTS);
  backlog.listCandidatePullRequests = () => [{
    number: 99,
    title: `fix: ${story.identifier} implementation`,
    headRefName: `fix/${story.identifier.toLowerCase()}-impl`,
    body: story.identifier,
    state: 'merged',
    merged_at: new Date(FIXED_NOW - 5000).toISOString(),
    url: `https://github.com/acme/repo/pull/99`,
  }];
  // Seed the stale run so selectReviewDispatch sees it; it must NOT act on it.
  backlog.getIssueRuns = (identifier) => {
    if (identifier === story.identifier) {
      return [{ status: 'completed', completed_at: staleAt, created_at: staleAt }];
    }
    return [];
  };
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, now: FIXED_NOW });

  const advanced = log.byEvent('advance').find(
    (e) => e.identifier === story.identifier && e.to === 'done'
  );
  assert.ok(advanced, 'detectVerifiedDone must advance the in_review story to done via the merged PR');

  const reviewEvents = log.byEvent('review').filter((e) => e.identifier === story.identifier);
  assert.equal(reviewEvents.length, 0,
    'selectReviewDispatch must not emit a review event for an issue already advanced to done this cycle');

  const reviewDispatched = log.byEvent('review_dispatched').filter((e) => e.identifier === story.identifier);
  assert.equal(reviewDispatched.length, 0,
    'must not fire a review_dispatched log event for a just-done ticket');

  const reruns = calls.rerun.filter((r) => r.identifier === story.identifier);
  assert.equal(reruns.length, 0,
    'spawn.rerunIssue must not be called for an issue that was advanced to done in the same cycle');
});

test('cascade: per-runtime cap is enforced across multiple cascade iterations (loopRtProjected accumulates)', async () => {
  // Three separate blocked stories that can all cascade (each depends on a different done
  // parent) in a tight codex lane (RUNTIME_CAP.codex = 1 via fixture override; auriga-dev
  // is runtime:codex). Before the fix, each chooseAgentForProject call saw
  // projected.perRuntime={} — empty — so all three passed the runtime cap check and
  // dispatched. After the fix, the first cascade assignment accumulates in loopRtProjected;
  // subsequent iterations see runtime=1 >= cap=1 and log cascade_skip(no-capacity).
  const fixtureCfg = withFixtureLanes({ 'cascade-rt-proj': ['auriga-dev'] });
  const tightCfg = {
    ...fixtureCfg,
    RUNTIME_CAP: { ...fixtureCfg.RUNTIME_CAP, codex: 1 },
  };
  const doneA = makeIssue({ project_id: 'cascade-rt-proj', status: 'done' });
  const doneB = makeIssue({ project_id: 'cascade-rt-proj', status: 'done' });
  const doneC = makeIssue({ project_id: 'cascade-rt-proj', status: 'done' });
  // 'not-a-seed' prevents isSeed() from routing these through minerva-dev (planning lane);
  // they must go through chooseAgentForProject so the codex runtime cap is exercised.
  const childA = makeIssue({ project_id: 'cascade-rt-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneA.id } });
  const childB = makeIssue({ project_id: 'cascade-rt-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneB.id } });
  const childC = makeIssue({ project_id: 'cascade-rt-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneC.id } });
  const { backlog, spawn, calls } = createMockAdapters([doneA, doneB, doneC, childA, childB, childC], tightCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.assign.length <= 1,
    `per-runtime cap 1 must be respected — at most 1 cascade assignment, got ${calls.assign.length}`);
});

test('cascade: per-cycle-per-agent cap is enforced across multiple cascade iterations (PANT-473)', async () => {
  // Three blocked stories all unblock simultaneously (each depends on a different done
  // parent, all routed to the same agent via a single-agent lane). With perCyclePerAgent=1,
  // only the first cascade assignment should go through; the remaining two must be
  // skipped with cascade_skip(per-cycle-per-agent-cap).
  const fixtureCfg = {
    ...withFixtureLanes({ 'cascade-pca-proj': ['auriga-dev'] }),
    CAPS: { ...cfg.CAPS, perCyclePerAgent: 1 },
  };
  const doneA = makeIssue({ project_id: 'cascade-pca-proj', status: 'done' });
  const doneB = makeIssue({ project_id: 'cascade-pca-proj', status: 'done' });
  const doneC = makeIssue({ project_id: 'cascade-pca-proj', status: 'done' });
  const childA = makeIssue({ project_id: 'cascade-pca-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneA.id } });
  const childB = makeIssue({ project_id: 'cascade-pca-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneB.id } });
  const childC = makeIssue({ project_id: 'cascade-pca-proj', status: 'blocked', labels: ['not-a-seed'], metadata: { depends_on: doneC.id } });
  const { backlog, spawn, calls } = createMockAdapters([doneA, doneB, doneC, childA, childB, childC], fixtureCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.assign.length <= 1,
    `perCyclePerAgent=1 must be respected — at most 1 cascade assignment, got ${calls.assign.length}`);
  const capSkips = log.byEvent('cascade_skip').filter((e) => e.reason === 'per-cycle-per-agent-cap');
  assert.ok(capSkips.length >= 2,
    `expected >=2 cascade_skip(per-cycle-per-agent-cap) entries, got ${capSkips.length}`);
});

test('cascade: existing-assignee rerun updates priorAgentCycleAssigns, blocking assigned-idle double-dispatch (PANT-545)', async () => {
  // Bug: cascade fires existing-assignee rerun but priorAgentCycleAssigns not
  // updated → assigned-idle double-dispatches the same agent within the same cycle.
  //
  // Setup: RUNTIME_CAP.codex=1, saturatingIssue (auriga-dev / codex) fills
  // runtimeInflight['codex']=1=cap. blockedChild has existing assignee auriga-build
  // (claude runtime), in a codex-only lane project — cascade returns agent=null
  // (codex full) but fires existing-assignee rerun. idleTodo is also assigned to
  // auriga-build (claude, not blocked by codex cap).
  //
  // Without fix: priorAgentCycleAssigns['auriga-build']=0 after cascade → assigned-
  // idle sees perAgentCycle=0 < perCyclePerAgent=1 and double-dispatches idleTodo.
  // With fix: priorAgentCycleAssigns['auriga-build']=1 after cascade → assigned-idle
  // sees perAgentCycle=1 >= 1 and skips idleTodo.
  const fixtureCfg = withFixtureLanes({ 'cascade-proj-545': ['auriga-dev', 'heimdall-dev-codex'] });
  const tightCfg = {
    ...fixtureCfg,
    CAPS: { ...fixtureCfg.CAPS, perCyclePerAgent: 1 },
    RUNTIME_CAP: { ...fixtureCfg.RUNTIME_CAP, codex: 1 },
  };
  const aurigaBuildId = tightCfg.AGENTS['auriga-build'].id;
  const aurigaDevId = tightCfg.AGENTS['auriga-dev'].id;
  // Fills runtimeInflight['codex']=1=runtimeCap.codex so cascade returns agent=null.
  const saturatingIssue = makeIssue({ project_id: 'cascade-proj-545', status: 'in_progress', assignee_id: aurigaDevId });
  // Dep starts in_review so detectUnblocks skips blockedChild; detectVerifiedDone
  // advances it to done via merged PR (PANT-341 pattern) before the cascade pass.
  const inReviewParent = makeIssue({ project_id: 'cascade-proj-545', status: 'in_review' });
  // blockedChild: existing assignee auriga-build (claude), codex-only lane is full.
  const blockedChild = makeIssue({
    project_id: 'cascade-proj-545', status: 'blocked',
    assignee_id: aurigaBuildId, metadata: { depends_on: inReviewParent.id },
  });
  // idleTodo: assigned to auriga-build (claude, not blocked by codex cap), no active runs.
  const idleTodo = makeIssue({ project_id: 'cascade-proj-545', status: 'todo', assignee_id: aurigaBuildId });
  const { backlog, spawn, calls } = createMockAdapters(
    [saturatingIssue, inReviewParent, blockedChild, idleTodo], tightCfg.AGENTS,
  );
  backlog.getIssuePullRequests = (identifier) =>
    identifier === inReviewParent.identifier
      ? [{ state: 'MERGED', title: inReviewParent.identifier }] : [];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.rerun.some((r) => r.identifier === blockedChild.identifier),
    'cascade must rerun blockedChild via existing-assignee path (codex lane full, auriga-build already assigned)');
  assert.ok(!calls.assign.some((a) => a.identifier === blockedChild.identifier),
    'cascade must NOT reassign blockedChild in the existing-assignee path');
  assert.ok(!calls.rerun.some((r) => r.identifier === idleTodo.identifier),
    'assigned-idle must NOT dispatch idleTodo — cascade rerun consumed the perCyclePerAgent=1 ' +
    'slot for auriga-build; without PANT-545 fix priorAgentCycleAssigns is stale and double-dispatch fires');
});
