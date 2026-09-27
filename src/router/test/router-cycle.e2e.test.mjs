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
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A', labels: ['not-a-seed'] });
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
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A', labels: ['not-a-seed'] });
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
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: 'A', labels: ['not-a-seed'] });
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
  const stuckIssue = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: null, labels: ['not-a-seed'] });
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

// ---- PANT-576: zombie rerun path missing per-cycle-per-agent cap and counter updates ----

test('zombie rerun: per-cycle-per-agent cap is enforced — second rerun gets zombie_skip (PANT-576)', async () => {
  // Bug: zombie rerun path never checked priorAgentCycleAssigns → same agent
  // received unlimited zombie reruns in one cycle.
  //
  // Setup: perCyclePerAgent=1, two stale in_progress issues both assigned to auriga-build.
  // With fix: first rerun fires and increments priorAgentCycleAssigns; second gets
  // zombie_skip(per-cycle-per-agent-cap).
  const AURIGA = projectId('Pantheon Core');
  const stale = Date.now() - (60 * 60 * 1000);
  const tightCfg = { ...cfg, CAPS: { ...cfg.CAPS, perCyclePerAgent: 1 } };
  const aurigaBuildId = cfg.AGENTS['auriga-build'].id;
  const zombie1 = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: aurigaBuildId, labels: ['not-a-seed'] });
  const zombie2 = makeIssue({ project_id: AURIGA, status: 'in_progress', assignee_id: aurigaBuildId, labels: ['not-a-seed'] });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([zombie1, zombie2], cfg.AGENTS);
  const failedRun = { status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() };
  runsByIdentifier[zombie1.identifier] = [failedRun];
  runsByIdentifier[zombie2.identifier] = [failedRun];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  const zombieReruns = calls.rerun.filter(
    (r) => r.identifier === zombie1.identifier || r.identifier === zombie2.identifier,
  );
  assert.equal(zombieReruns.length, 1, 'only one zombie rerun must fire when perCyclePerAgent=1 (PANT-576)');
  const capSkips = log.byEvent('zombie_skip').filter((e) => e.reason === 'per-cycle-per-agent-cap');
  assert.equal(capSkips.length, 1, 'second zombie must be skipped with per-cycle-per-agent-cap (PANT-576)');
});

test('zombie rerun: updates priorAgentCycleAssigns, blocking picks-loop double-dispatch (PANT-576)', async () => {
  // Bug: zombie rerun path never incremented priorAgentCycleAssigns → picks loop
  // saw count=0 and dispatched the same agent again within the same cycle.
  //
  // Setup: perCyclePerAgent=1, zombie rerun for auriga-build, and a todo issue
  // also routable to auriga-build in the picks loop.
  // With fix: zombie rerun increments priorAgentCycleAssigns['auriga-build']=1
  // → picks loop sees perAgentCycle=1 >= 1 and skips todoIssue.
  const fixtureCfg = withFixtureLanes({ 'zombie-picks-proj-576': ['auriga-build'] });
  const tightCfg = { ...fixtureCfg, CAPS: { ...fixtureCfg.CAPS, perCyclePerAgent: 1 } };
  const aurigaBuildId = tightCfg.AGENTS['auriga-build'].id;
  const stale = Date.now() - (60 * 60 * 1000);
  const zombieIssue = makeIssue({ project_id: 'zombie-picks-proj-576', status: 'in_progress', assignee_id: aurigaBuildId, labels: ['not-a-seed'] });
  const todoIssue = makeIssue({ project_id: 'zombie-picks-proj-576', status: 'todo', labels: ['not-a-seed'] });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([zombieIssue, todoIssue], tightCfg.AGENTS);
  runsByIdentifier[zombieIssue.identifier] = [{ status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() }];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.rerun.some((r) => r.identifier === zombieIssue.identifier),
    'zombie must call rerunIssue on the stale issue');
  assert.ok(!calls.assign.some((a) => a.identifier === todoIssue.identifier),
    'picks loop must NOT assign todoIssue — zombie rerun consumed the perCyclePerAgent=1 slot (PANT-576)');
});

test('zombie rerun: updates loopRtProjected, blocking zombie-assign over-dispatch on same runtime (PANT-576)', async () => {
  // Bug: zombie rerun path never incremented loopRtProjected → a subsequent
  // zombie assign in the same cycle could dispatch beyond the runtime cap.
  //
  // Setup: RUNTIME_CAP.codex=2. One zombie-rerun issue assigned to auriga-dev (codex)
  // fills runtimeInflight['codex']=1. With fix, rerun increments loopRtProjected['codex']=1,
  // so total projected=2=cap. A second unassigned zombie in the same project then calls
  // chooseAgentForProject, which sees runtime full and logs zombie_skip(no-lane-capacity).
  // Without fix: loopRtProjected['codex']=0, projected=1 < 2 → over-dispatches.
  const fixtureCfg = withFixtureLanes({ 'zombie-rt-proj-576': ['auriga-dev'] });
  const tightCfg = { ...fixtureCfg, RUNTIME_CAP: { ...fixtureCfg.RUNTIME_CAP, codex: 2 } };
  const aurigaDevId = tightCfg.AGENTS['auriga-dev'].id;
  const stale = Date.now() - (60 * 60 * 1000);
  // Zombie rerun: existing assignee (auriga-dev/codex), stale run.
  const rerunZombie = makeIssue({ project_id: 'zombie-rt-proj-576', status: 'in_progress', assignee_id: aurigaDevId, labels: ['not-a-seed'] });
  // Zombie assign: no assignee → action:'assign' → calls chooseAgentForProject.
  const assignZombie = makeIssue({ project_id: 'zombie-rt-proj-576', status: 'in_progress', assignee_id: null, labels: ['not-a-seed'] });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters([rerunZombie, assignZombie], tightCfg.AGENTS);
  runsByIdentifier[rerunZombie.identifier] = [{ status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() }];
  runsByIdentifier[assignZombie.identifier] = [{ status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() }];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP });

  assert.ok(calls.rerun.some((r) => r.identifier === rerunZombie.identifier),
    'zombie rerun must call rerunIssue for the stale assigned issue');
  assert.ok(!calls.assign.some((a) => a.identifier === assignZombie.identifier),
    'zombie assign must NOT dispatch assignZombie — rerun filled the codex runtime cap (PANT-576)');
  const rtSkips = log.byEvent('zombie_skip').filter((e) => e.reason === 'no-lane-capacity');
  assert.ok(rtSkips.length >= 1, 'zombie_skip(no-lane-capacity) must be logged for the over-capacity assign (PANT-576)');
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

// PANT-522: review dispatch loop was missing the maxAssign guard — every other
// dispatch loop in cycle() has `if (assigned >= maxAssign) break;` but the
// review loop did not, so review dispatches could overrun the hard cap.
test('PANT-522: review dispatch loop respects maxAssign:0 (no review dispatches when cap is exhausted)', async () => {
  // One in_review issue in a valid project: selectReviewDispatch will produce one
  // rerun-review pick. With maxAssign:0, the guard must stop it from firing.
  const PANTHEON_CORE = projectId('Pantheon Core');
  const inReviewIssue = makeIssue({ project_id: PANTHEON_CORE, status: 'in_review' });
  const { backlog, spawn, calls } = createMockAdapters([inReviewIssue], cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg, log, sleep: NOOP_SLEEP, maxAssign: 0 });

  assert.equal(result.assigned, 0, 'maxAssign:0 must block all dispatches including review');
  assert.equal(calls.rerun.length, 0, 'rerunIssue must not be called when maxAssign:0');
  assert.equal(calls.assign.length, 0, 'assignIssue must not be called when maxAssign:0');
});

test('PANT-522: review dispatch loop respects maxAssign when perCycleReview allows multiple picks', async () => {
  // Three in_review issues + perCycleReview:3 produces up to 3 review picks.
  // With maxAssign:1, only the first pick must fire; the guard must stop the rest.
  const PANTHEON_CORE = projectId('Pantheon Core');
  const reviewCfg = { ...cfg, CAPS: { ...cfg.CAPS, perCycleReview: 3 } };
  const issues = Array.from({ length: 3 }, () => makeIssue({ project_id: PANTHEON_CORE, status: 'in_review' }));
  const { backlog, spawn, calls } = createMockAdapters(issues, cfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: reviewCfg, log, sleep: NOOP_SLEEP, maxAssign: 1 });

  assert.equal(result.assigned, 1, 'maxAssign:1 must cap total dispatches at 1 even with 3 review picks');
  const reviewReruns = calls.rerun.filter((r) => issues.some((i) => i.identifier === r.identifier));
  assert.ok(reviewReruns.length <= 1,
    `review loop must not fire more than 1 rerun when maxAssign:1, got ${reviewReruns.length}`);
});

test('review dispatch loop respects maxAssign cap — PANT-516', async () => {
  // With perCycleReview=3 and 3 in_review stories, selectReviewDispatch returns up to
  // 3 picks. With maxAssign=2, only 2 review dispatches must fire — the loop must
  // break when the cap is reached, never overrun it.
  const fixtureCfg = {
    ...withFixtureLanes({ 'review-cap-proj': ['auriga-review'] }),
    CAPS: { ...cfg.CAPS, perCycleReview: 3, reviewMaxAttempts: 10, reviewFairnessMaxAttempts: 10 },
    REVIEW_LANE: ['auriga-review'],
  };
  const issues = Array.from({ length: 3 }, () =>
    makeIssue({ project_id: 'review-cap-proj', status: 'in_review', parent_issue_id: 'fake-parent' })
  );
  const { backlog, spawn, calls } = createMockAdapters(issues, fixtureCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP, maxAssign: 2 });

  assert.ok(calls.assign.length <= 2,
    `review dispatch must not exceed maxAssign=2, got ${calls.assign.length}`);
});

// ---- PANT-726: dispatch-review must not double-dispatch (assign + unconditional rerun) ----
// When Multica enqueues a run on assignment, dispatch-review was calling assignIssue()
// and then unconditionally calling rerunIssue(), producing two runs ~6s apart.
// Fix: check runs after the post-assign sleep; only rerun if assignment did not
// auto-enqueue. One dispatch must equal exactly one run.

test('PANT-726: dispatch-review does NOT call rerunIssue when assignIssue auto-enqueued a run', async () => {
  // Standard mock: assignIssue synthesizes an active run. dispatch-review must
  // detect this and skip the rerun call entirely.
  const fixtureCfg = {
    ...withFixtureLanes({ 'pant726-proj': ['auriga-review'] }),
    CAPS: { ...cfg.CAPS, reviewMaxAttempts: 10, reviewFairnessMaxAttempts: 10 },
    REVIEW_LANE: ['auriga-review'],
  };
  const inReviewIssue = makeIssue({ project_id: 'pant726-proj', status: 'in_review' });
  const { backlog, spawn, calls } = createMockAdapters([inReviewIssue], fixtureCfg.AGENTS);
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1, 'review dispatch must count as one assignment');
  assert.equal(calls.assign.length, 1, 'assignIssue must be called exactly once');
  assert.equal(calls.assign[0].identifier, inReviewIssue.identifier);
  assert.equal(calls.rerun.filter((r) => r.identifier === inReviewIssue.identifier).length, 0,
    'rerunIssue must NOT be called when assignIssue already enqueued a run (PANT-726)');
  assert.equal(log.byEvent('review_assign_enqueued').length, 1,
    'review_assign_enqueued must be logged when assignment auto-enqueued');
});

test('PANT-726: dispatch-review DOES call rerunIssue when assignIssue did not enqueue a run (dead-zone fallback)', async () => {
  // noRunFor prevents auto-enqueue — simulates the legacy dead-zone where
  // assignment alone did not reliably start a run. The fallback rerun must fire.
  const fixtureCfg = {
    ...withFixtureLanes({ 'pant726-fallback-proj': ['auriga-review'] }),
    CAPS: { ...cfg.CAPS, reviewMaxAttempts: 10, reviewFairnessMaxAttempts: 10 },
    REVIEW_LANE: ['auriga-review'],
  };
  const inReviewIssue = makeIssue({ project_id: 'pant726-fallback-proj', status: 'in_review' });
  const { backlog, spawn, calls } = createMockAdapters([inReviewIssue], fixtureCfg.AGENTS, {
    noRunFor: new Set([inReviewIssue.identifier]),
  });
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  assert.equal(result.assigned, 1, 'review dispatch must still count as one assignment');
  assert.equal(calls.assign.length, 1, 'assignIssue must be called exactly once');
  assert.equal(calls.rerun.filter((r) => r.identifier === inReviewIssue.identifier).length, 1,
    'rerunIssue must be called once as a fallback when assignment did not enqueue a run');
  const noRunLog = log.byEvent('review_verify_no_run').find(
    (e) => e.identifier === inReviewIssue.identifier && e.action === 'rerun',
  );
  assert.ok(noRunLog, 'review_verify_no_run(action:rerun) must be logged for the dead-zone fallback');
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
  // skipped. With the PANT-653 fix, the cap is enforced inside chooseAgentForProject
  // so capped agents are excluded from eligible[] — returns null — logged as no-capacity.
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
  const capSkips = log.byEvent('cascade_skip').filter((e) => e.reason === 'no-capacity');
  assert.ok(capSkips.length >= 2,
    `expected >=2 cascade_skip(no-capacity) entries after cap exhausted, got ${capSkips.length}`);
});

// ---- PANT-653: cascade and zombie dispatch must fall back to the next lane agent ----
// When the best lane agent is at its perCyclePerAgent cap, chooseAgentForProject
// must exclude it and return the next eligible agent — not silently skip the item.

test('cascade: per-cycle-per-agent cap falls back to next lane agent instead of skipping (PANT-653)', async () => {
  // Two-agent lane: ['auriga-build', 'heimdall-dev-codex'], perCyclePerAgent=1.
  // Two cascade candidates both need routing. The first gets auriga-build (0 cycle
  // assigns < cap 1). The second sees auriga-build at cap and must fall back to
  // heimdall-dev-codex rather than being silently skipped. Before the fix, the
  // second item got cascade_skip; after the fix it routes to the fallback agent.
  const fixtureCfg = {
    ...withFixtureLanes({ 'pant653-cascade-proj': ['auriga-build', 'heimdall-dev-codex'] }),
    CAPS: { ...cfg.CAPS, perCyclePerAgent: 1 },
  };
  const doneA = makeIssue({ project_id: 'pant653-cascade-proj', status: 'done' });
  const doneB = makeIssue({ project_id: 'pant653-cascade-proj', status: 'done' });
  const cascadeA = makeIssue({
    project_id: 'pant653-cascade-proj',
    status: 'blocked',
    labels: ['not-a-seed'],
    metadata: { depends_on: doneA.id },
  });
  const cascadeB = makeIssue({
    project_id: 'pant653-cascade-proj',
    status: 'blocked',
    labels: ['not-a-seed'],
    metadata: { depends_on: doneB.id },
  });
  const { backlog, spawn, calls } = createMockAdapters([doneA, doneB, cascadeA, cascadeB], fixtureCfg.AGENTS);
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  // Both cascade items must be routed — no silent skips.
  assert.equal(calls.assign.length, 2,
    `expected 2 cascade assignments (one per cascade candidate), got ${calls.assign.length} — PANT-653`);
  const agents = calls.assign.map((a) => a.agentName);
  assert.ok(agents.includes('auriga-build'), 'first cascade must route to auriga-build (first in lane)');
  assert.ok(agents.includes('heimdall-dev-codex'),
    'second cascade must fall back to heimdall-dev-codex when auriga-build is at cap — PANT-653');
  assert.equal(log.byEvent('cascade_skip').length, 0,
    'no cascade_skip entries — both items must be routed, not dropped (PANT-653)');
});

test('zombie assign: per-cycle-per-agent cap falls back to next lane agent instead of skipping (PANT-653)', async () => {
  // Two-agent lane: ['auriga-build', 'heimdall-dev-codex'], perCyclePerAgent=1.
  // A cascade candidate fires first (cascade runs before zombie loop) and routes
  // to auriga-build, filling its per-cycle cap. An unassigned in_progress zombie
  // must then fall back to heimdall-dev-codex rather than being silently skipped.
  const stale = Date.now() - (60 * 60 * 1000);
  const fixtureCfg = {
    ...withFixtureLanes({ 'pant653-zombie-proj': ['auriga-build', 'heimdall-dev-codex'] }),
    CAPS: { ...cfg.CAPS, perCyclePerAgent: 1 },
  };
  const doneDep = makeIssue({ project_id: 'pant653-zombie-proj', status: 'done' });
  const cascadeIssue = makeIssue({
    project_id: 'pant653-zombie-proj',
    status: 'blocked',
    labels: ['not-a-seed'],
    metadata: { depends_on: doneDep.id },
  });
  const zombieIssue = makeIssue({
    project_id: 'pant653-zombie-proj',
    status: 'in_progress',
    assignee_id: null,
    labels: ['not-a-seed'],
  });
  const { backlog, spawn, calls, runsByIdentifier } = createMockAdapters(
    [doneDep, cascadeIssue, zombieIssue], fixtureCfg.AGENTS
  );
  runsByIdentifier[zombieIssue.identifier] = [
    { status: 'failed', error: 'boom', created_at: new Date(stale).toISOString() },
  ];
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  // cascade fills auriga-build's cap, zombie must fall back to heimdall-dev-codex
  const cascadeAssign = calls.assign.find((a) => a.identifier === cascadeIssue.identifier);
  assert.ok(cascadeAssign, 'cascade issue must be assigned');
  assert.equal(cascadeAssign.agentName, 'auriga-build',
    'cascade issue must route to auriga-build (first in lane, cap not yet reached)');
  const zombieAssign = calls.assign.find((a) => a.identifier === zombieIssue.identifier);
  assert.ok(zombieAssign,
    'zombie issue must be assigned — must NOT be skipped when auriga-build is at cap (PANT-653)');
  assert.equal(zombieAssign.agentName, 'heimdall-dev-codex',
    'zombie must fall back to heimdall-dev-codex when auriga-build is at per-cycle cap — PANT-653');
  assert.equal(log.byEvent('zombie_skip').length, 0,
    'no zombie_skip entries — zombie must be routed, not dropped (PANT-653)');
});

// ---- PANT-549: build-dispatch picks loop must skip blocked runtimes ----------
// blockedRuntimes is populated in the picks loop itself (when assignIssue throws
// a rate-limit error). Without a guard at the top of the loop body, subsequent
// picks for the same runtime are dispatched anyway — all fail, and each is an
// unnecessary request to an already-rate-limited endpoint.

test('PANT-549: a rate-limit error on the first pick blocks all subsequent picks for that runtime in the same cycle', async () => {
  const fixtureCfg = withFixtureLanes({ 'pant549-proj': ['auriga-dev'] });
  const issueA = makeIssue({ project_id: 'pant549-proj', parent_issue_id: 'fake-parent' });
  const issueB = makeIssue({ project_id: 'pant549-proj', parent_issue_id: 'fake-parent' });
  // Only issueA fails — without the guard the second call still fires;
  // with the guard issueB's pick is skipped before assignIssue is called.
  const { backlog, spawn, calls } = createMockAdapters([issueA, issueB], fixtureCfg.AGENTS, {
    failAssignFor: new Set([issueA.identifier]),
  });
  const log = createLogSink();

  await cycle({ backlog, spawn, cfg: fixtureCfg, log, sleep: NOOP_SLEEP });

  assert.equal(calls.assign.length, 1, 'only the first (failing) pick should have called assignIssue');
  const skips = log.byEvent('skip_blocked_runtime');
  assert.equal(skips.length, 1, 'the second pick must log skip_blocked_runtime once');
  assert.equal(skips[0].identifier, issueB.identifier);
});

test('cascade: existing-assignee rerun counts toward assigned — maxAssign blocks a second dispatch in the same cycle (PANT-582)', async () => {
  // Bug: the !agent && issueObj.assignee_id path fired rerunIssue but never
  // incremented `assigned`. With maxAssign=1 a cascade existing-assignee rerun
  // should exhaust the budget and prevent a subsequent todo dispatch.
  //
  // Setup: runtimeCap.codex=1, saturatingIssue (auriga-dev / codex) fills the
  // codex lane so cascade returns agent=null. blockedChild has existing assignee
  // auriga-build (claude runtime) — triggers the existing-assignee path.
  // unassignedTodo is a plain todo in a claude lane with capacity.
  //
  // Without fix: assigned stays 0 after cascade rerun → maxAssign=1 still
  // allows unassignedTodo to be dispatched → result.assigned=1 is wrong (2 real
  // dispatches: 1 rerun + 1 assign).
  // With fix: assigned=1 after cascade rerun → maxAssign guard blocks
  // unassignedTodo → result.assigned=1 (only the cascade rerun).
  const fixtureCfg = withFixtureLanes({
    'cascade-582-proj': ['auriga-build', 'heimdall-dev-codex'],
    'todo-582-proj': ['auriga-build'],
  });
  const tightCfg = {
    ...fixtureCfg,
    RUNTIME_CAP: { ...fixtureCfg.RUNTIME_CAP, codex: 1 },
  };
  const aurigaBuildId = tightCfg.AGENTS['auriga-build'].id;
  const aurigaDevId = tightCfg.AGENTS['auriga-dev'].id;
  const saturatingIssue = makeIssue({ project_id: 'cascade-582-proj', status: 'in_progress', assignee_id: aurigaDevId });
  const inReviewParent = makeIssue({ project_id: 'cascade-582-proj', status: 'in_review' });
  const blockedChild = makeIssue({
    project_id: 'cascade-582-proj', status: 'blocked',
    assignee_id: aurigaBuildId, metadata: { depends_on: inReviewParent.id },
  });
  const unassignedTodo = makeIssue({ project_id: 'todo-582-proj', status: 'todo' });
  const { backlog, spawn, calls } = createMockAdapters(
    [saturatingIssue, inReviewParent, blockedChild, unassignedTodo], tightCfg.AGENTS,
  );
  backlog.getIssuePullRequests = (identifier) =>
    identifier === inReviewParent.identifier
      ? [{ state: 'MERGED', title: inReviewParent.identifier }] : [];
  const log = createLogSink();

  const result = await cycle({ backlog, spawn, cfg: tightCfg, log, sleep: NOOP_SLEEP, maxAssign: 1 });

  assert.ok(calls.rerun.some((r) => r.identifier === blockedChild.identifier),
    'cascade must rerun blockedChild via existing-assignee path');
  assert.equal(result.assigned, 1,
    'result.assigned must be 1 — existing-assignee rerun counts toward the budget (PANT-582)');
  assert.ok(!calls.assign.some((a) => a.identifier === unassignedTodo.identifier),
    'unassignedTodo must NOT be dispatched — maxAssign=1 exhausted by cascade rerun');
});
