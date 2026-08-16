#!/usr/bin/env node
// Auriga auto-router — the decide+assign layer that drains the Multica board.
// Each cycle: scan board -> recover zombies -> select a small batch of
// unassigned todos -> route by project lane (respecting caps) -> assign ->
// verify a run started (rerun to force-enqueue if not) -> log -> sleep.
//
// SAFETY: single-instance via pidfile; non-destructive (only assign/rerun,
// never delete/cancel); small per-cycle batches; runtime caps to avoid
// single-runtime contention; skips rate-limited lanes.
//
// Flags:
//   --once            run exactly one cycle then exit
//   --dry-run         compute + log decisions but do NOT assign/rerun
//   --max-assign N    hard cap on assignments this process (default: unlimited)
//   --no-zombie       skip zombie recovery this run
// Env overrides: AURIGA_PER_CYCLE_TOTAL, AURIGA_PER_CYCLE_PER_AGENT,
//   AURIGA_CYCLE_MS, AURIGA_PIDFILE, AURIGA_LOG.
//
// TESTABILITY: `cycle()` is exported and accepts an options bag so tests can
// inject fixture/stub backlog+spawn adapters (opts.backlog, opts.spawn), a
// fixture config (opts.cfg), a log sink (opts.log), and a fast/no-op sleep
// (opts.sleep) — see test/router-cycle.e2e.test.mjs and
// test/cutover-e2e.test.mjs. `main()` (the live daemon loop) only runs when
// this file is executed directly, never when imported by a test.

import fs from 'node:fs';
import * as cfg from './lib/config.mjs';
import * as core from './lib/core.mjs';
import { createMulticaBacklogAdapter } from './lib/adapters/multica/backlog.mjs';
import { createMulticaSpawnAdapter } from './lib/adapters/multica/spawn.mjs';

// Live defaults — constructed once at module load (cheap: a factory closure,
// no CLI call happens until a method is actually invoked), exactly mirroring
// the old `import * as mca from './lib/multica.mjs'` singleton-module
// pattern. reviewRepoOwner/reviewSearchRepos are wired from cfg so the
// backlog adapter's internal gh-based PR discovery (which folded in what
// used to be the router's own ghListRepos/ghOpenPrs/ghPrs calls) searches
// the SAME repo set live behavior already depended on — omitting these would
// silently break PR discovery (false-done + review-dispatch would find no
// PRs). verifyDelayMs/lane-map fields mirror the router's live CAPS/lane
// config so a future describeLanes() consumer sees byte-identical values.
const defaultBacklog = createMulticaBacklogAdapter({
  reviewRepoOwner: cfg.REVIEW_REPO_OWNER,
  reviewSearchRepos: cfg.REVIEW_SEARCH_REPOS,
});
const defaultSpawn = createMulticaSpawnAdapter({
  verifyDelayMs: cfg.CAPS.verifyDelayMs,
  projectLane: cfg.PROJECT_LANE,
  defaultLane: cfg.DEFAULT_LANE,
  hiveLane: cfg.HIVE_LANE,
  reviewLane: cfg.REVIEW_LANE,
  runtimeCap: cfg.RUNTIME_CAP,
});

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 && args[i + 1] ? args[i + 1] : d; };

const ONCE = has('--once');
const DRY = has('--dry-run');
const NO_ZOMBIE = has('--no-zombie');
const MAX_ASSIGN = parseInt(val('--max-assign', '0'), 10) || Infinity;

const PIDFILE = process.env.AURIGA_PIDFILE || '/tmp/auriga-router.pid';
const LOGFILE = process.env.AURIGA_LOG || '/tmp/auriga-router.jsonl';

// Apply env cap overrides.
if (process.env.AURIGA_PER_CYCLE_TOTAL) cfg.CAPS.perCycleTotal = parseInt(process.env.AURIGA_PER_CYCLE_TOTAL, 10);
if (process.env.AURIGA_PER_CYCLE_PER_AGENT) cfg.CAPS.perCyclePerAgent = parseInt(process.env.AURIGA_PER_CYCLE_PER_AGENT, 10);
if (process.env.AURIGA_CYCLE_MS) cfg.CAPS.cycleMs = parseInt(process.env.AURIGA_CYCLE_MS, 10);

// ---- single-instance guard -------------------------------------------------
function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function acquireLock() {
  if (fs.existsSync(PIDFILE)) {
    const old = parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10);
    if (old && old !== process.pid && alive(old)) {
      console.error(`[auriga] another router is alive (pid ${old}); refusing to start.`);
      process.exit(3);
    }
  }
  fs.writeFileSync(PIDFILE, String(process.pid));
}
function releaseLock() {
  try {
    if (fs.existsSync(PIDFILE) && parseInt(fs.readFileSync(PIDFILE, 'utf8').trim(), 10) === process.pid) {
      fs.unlinkSync(PIDFILE);
    }
  } catch {}
}

// ---- logging ---------------------------------------------------------------
function log(event, data) {
  const rec = { ts: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(rec);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- one cycle -------------------------------------------------------------
// opts: { backlog, spawn, cfg, core, log, sleep, dryRun, noZombie, maxAssign, now }
// Every dependency defaults to the live module-level singleton, so calling
// cycle() with no args (from main()) is exactly the original live behavior.
// Returns { todo, picked, assigned }.
export async function cycle(opts = {}) {
  const backlog = opts.backlog || defaultBacklog;
  const spawn = opts.spawn || defaultSpawn;
  const cfgImpl = opts.cfg || cfg;
  const coreImpl = opts.core || core;
  const logImpl = opts.log || log;
  const sleepImpl = opts.sleep || sleep;
  const dryRun = opts.dryRun ?? DRY;
  const noZombie = opts.noZombie ?? NO_ZOMBIE;
  const maxAssign = opts.maxAssign ?? Infinity;
  const now = opts.now ?? Date.now();

  let assigned = 0;

  // BOARD-WIDE scan for the STATUS passes (unblock, parent-rollup, false-done,
  // run-completion, verified-done): the blocked/done lies live in projects the
  // build-DISPATCH set (cfgImpl.PROJECT_IDS) deliberately excludes, so scanning only
  // those 4 hid them. selectAssignments still filters to cfgImpl.PROJECT_IDS internally
  // (dispatch stays gated to aligned lanes); only observation goes board-wide.
  const discovered = backlog.listAllProjectIds();
  const scanIds = [...new Set([...(discovered.length ? discovered : cfgImpl.PROJECT_IDS), ...cfgImpl.PROJECT_IDS])];
  const issues = backlog.listAllIssues(scanIds);
  const inflight = coreImpl.computeInflight(issues, cfgImpl.AGENTS);
  const runtimeInflight = coreImpl.computeRuntimeInflight(inflight, cfgImpl.AGENTS);
  // Observability only (NOT capacity): the assigned-todo backlog. If this climbs while
  // inflight stays ~0, dispatch is happening but runs aren't starting (dead-zone) — the
  // signal that used to hide inside the old inflight number and deadlock the router.
  const assignedQueued = coreImpl.computeAssignedQueued(issues, cfgImpl.AGENTS);

  const todo = issues.filter((i) => (i.status || '').toLowerCase() === 'todo' && !i.assignee_id && !coreImpl.isSmokeScratch(i.title));
  logImpl('scan', {
    total: issues.length,
    todoUnassigned: todo.length,
    inflight,
    runtimeInflight,
    assignedQueued,
  });

  const blockedRuntimes = new Set();

  // ---- state-machine: blocked -> todo when declared deps clear (PAN-6662) ----
  // The multi-story crux. A story parked in `blocked` at plan time (its dep stories
  // not built yet) is invisible to every other pass — the build candidate pool only
  // scans `todo`. detectUnblocks finds blocked stories whose DECLARED depends_on graph
  // is fully satisfied and advances them to todo + unassign so they re-enter routing as
  // fresh candidates. Guard: skip any that already have runs (already built / in flight),
  // so an anomalous blocked-with-open-PR story is never re-dispatched.
  {
    const blockedIssues = issues.filter((i) => (i.status || '').toLowerCase() === 'blocked');
    const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
    // Pass the WHOLE board so DESCRIPTION-declared slug deps resolve against siblings
    // (metadata-only dep resolution missed the m-02-depends-on-m-01 case).
    const unblocks = coreImpl.detectUnblocks(blockedIssues, statusById, issues);
    for (const u of unblocks) {
      // Guard: never re-dispatch a story that already produced a PR — an OPEN PR
      // means it is already in review, a MERGED PR means it already shipped. A
      // merely-stale or failed run from earlier churn must NOT block the unblock
      // (that is exactly the cm-02/cm-03 case: one refused run each from the
      // pre-target_repo churn, but never actually built). So gate on a real PR,
      // discovered via gh in the story's own target repo, not on run count.
      const issueObj = blockedIssues.find((b) => b.id === u.issueId) || {};
      const slug = coreImpl.normalizeRepoSlug(coreImpl.targetRepoValue(issueObj) || '');
      let hasPr = false;
      if (slug) {
        // ghPrs(slug, 'all') is now internal to backlog.getIssuePullRequests —
        // the router asks for the story's OWN identifier's PRs instead of a
        // raw repo scan; the matching logic (prMatchesStory) is unchanged.
        try { hasPr = backlog.getIssuePullRequests(u.identifier).some((pr) => coreImpl.prMatchesStory(pr, issueObj)); }
        catch (e) { logImpl('unblock_pr_lookup_error', { identifier: u.identifier, repo: slug, error: e.message }); }
      }
      if (hasPr) { logImpl('unblock_skip', { identifier: u.identifier, reason: 'existing-pr', repo: slug }); continue; }
      logImpl('advance', { identifier: u.identifier, from: 'blocked', to: 'todo', applied: !dryRun });
      if (!dryRun) {
        try {
          backlog.setIssueStatus(u.identifier, 'todo');
          try { spawn.unassignIssue(u.identifier); } catch (e) { logImpl('unblock_unassign_error', { identifier: u.identifier, error: e.message }); }
        } catch (e) { logImpl('advance_error', { identifier: u.identifier, to: 'todo', error: e.message }); }
      }
    }

    // ---- state-machine: parent/epic -> done when every child is terminal ----
    // Nothing else closes a parent when its last child completes. Fires only when
    // ALL of a parent's visible children are done/cancelled and the parent isn't
    // already terminal.
    const parentDone = coreImpl.detectParentDone(issues);
    for (const pd of parentDone) {
      logImpl('advance', { identifier: pd.identifier, to: 'done', kind: 'parent-rollup', applied: !dryRun });
      if (!dryRun) {
        try { backlog.setIssueStatus(pd.identifier, 'done'); } catch (e) { logImpl('advance_error', { identifier: pd.identifier, to: 'done', error: e.message }); }
      }
    }
  }

  // ---- state-machine: in_progress -> in_review, in_review -> done ----
  // Pure-code, no agent calls. Single-instance pidfile lock (acquireLock above)
  // makes each cycle atomic w.r.t. other router processes; re-deriving the
  // candidate set fresh from board state every cycle makes both transitions
  // idempotent (a transitioned issue simply drops out of its source filter).
  const inProgress = issues.filter((i) => ['in_progress', 'in progress', 'running'].includes((i.status || '').toLowerCase()));
  const runsByIssue = {};
  for (const i of inProgress) runsByIssue[i.identifier] = backlog.getIssueRuns(i.identifier);

  const completions = coreImpl.detectRunCompletions(inProgress, runsByIssue, now);
  for (const c of completions) {
    logImpl('advance', { identifier: c.identifier, to: 'in_review', applied: !dryRun });
    if (!dryRun) {
      try { backlog.setIssueStatus(c.identifier, 'in_review'); } catch (e) { logImpl('advance_error', { identifier: c.identifier, to: 'in_review', error: e.message }); }
    }
  }

  const inReview = issues.filter((i) => (i.status || '').toLowerCase() === 'in_review');
  const prsByIssue = {};
  for (const i of inReview) prsByIssue[i.identifier] = backlog.getIssuePullRequests(i.identifier);
  const verified = coreImpl.detectVerifiedDone(inReview, prsByIssue);
  for (const v of verified) {
    logImpl('advance', { identifier: v.identifier, to: 'done', applied: !dryRun });
    if (!dryRun) {
      try { backlog.setIssueStatus(v.identifier, 'done'); } catch (e) { logImpl('advance_error', { identifier: v.identifier, to: 'done', error: e.message }); }
    }
  }

  // ---- CASCADE RE-DISPATCH: a completed story enqueues its now-unblocked dependents ----
  // THE self-draining fix. Pure code, no agent/LLM. When a story is done, any
  // dependent whose FULL dependency graph is now satisfied is ENQUEUED immediately
  // (assignee-mutation alone never enqueues — the dead-zone — so a completion event
  // historically re-fired nothing and a chain only advanced on a manual
  // `multica issue rerun`). The completed set is derived from the LIVE board (done
  // stories), not only this-cycle merges, because a story usually reaches `done` via
  // an agent setting status directly, not via the router's merged-PR gate — a purely
  // event-based trigger would miss most completions and never self-heal an already-
  // stuck chain. Idempotent + bounded: skips any dependent with an active run or an
  // existing PR, caps per cycle (cfgImpl.CAPS.perCycleCascade), and records each handled
  // identifier in `cascaded` so selectAssignments below does not double-dispatch it.
  const cascaded = new Set();
  {
    const doneIds = new Set(
      issues
        .filter((i) => { const s = (i.status || '').toLowerCase(); return s === 'done' || s === 'cancelled' || s === 'canceled'; })
        .map((i) => i.id)
    );
    const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
    const cascades = coreImpl.detectCascadeDispatch(issues, doneIds, statusById, cfgImpl);
    let cascadeFired = 0;
    for (const c of cascades) {
      if (cascadeFired >= cfgImpl.CAPS.perCycleCascade) break;
      if (assigned >= maxAssign) break;
      const issueObj = issues.find((i) => i.id === c.issueId) || { identifier: c.identifier };
      // Idempotency 1: never re-fire a story that already has an active run.
      let activeRun = false;
      try { activeRun = backlog.getIssueRuns(c.identifier).some((r) => coreImpl.classifyRun(r, Date.now()).active); }
      catch (e) { logImpl('cascade_runs_error', { identifier: c.identifier, error: e.message }); }
      if (activeRun) { logImpl('cascade_skip', { identifier: c.identifier, reason: 'active-run' }); continue; }
      // Idempotency 2: never re-dispatch a story that already produced a PR (open =
      // in review, merged = shipped) — same gh-based guard the unblock pass uses,
      // now via backlog.getIssuePullRequests (ghPrs is internal to the adapter).
      const slug = coreImpl.normalizeRepoSlug(coreImpl.targetRepoValue(issueObj) || '');
      if (slug) {
        try {
          if (backlog.getIssuePullRequests(c.identifier).some((pr) => coreImpl.prMatchesStory(pr, issueObj))) {
            logImpl('cascade_skip', { identifier: c.identifier, reason: 'existing-pr', repo: slug });
            continue;
          }
        } catch (e) { logImpl('cascade_pr_lookup_error', { identifier: c.identifier, repo: slug, error: e.message }); }
      }
      logImpl('cascade_dispatch', { identifier: c.identifier, from: c.status, projectId: c.projectId, applied: !dryRun });
      if (dryRun) { cascadeFired++; cascaded.add(c.identifier); continue; }
      try {
        if (c.status === 'blocked') backlog.setIssueStatus(c.identifier, 'todo');
        // Ensure an assignee on the story's lane, then rerun to FORCE-ENQUEUE (rerun
        // re-enqueues the CURRENT assignment; assignee-mutation alone does not).
        const agent = coreImpl.chooseAgentForProject(c.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} }, coreImpl.isHiveStory(issueObj));
        if (agent) {
          spawn.assignIssue(c.identifier, agent);
          inflight[agent] = (inflight[agent] || 0) + 1;
          await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
        }
        spawn.rerunIssue(c.identifier);
        assigned++;
        cascadeFired++;
        cascaded.add(c.identifier);
        logImpl('cascade_enqueued', { identifier: c.identifier, agent: agent || null });
      } catch (e) {
        logImpl('cascade_error', { identifier: c.identifier, error: e.message });
      }
    }
  }

  // ---- BACK-HALF: review / ship dispatch on in_review stories ----
  // detectVerifiedDone only advances a story once its PR is ALREADY merged; it
  // never merges anything. This block dispatches the Claude+plugin-hive REVIEW
  // lane onto in_review stories that have (or should have) an open PR: the agent
  // runs /hive:review + /hive:test on the PR branch, then merges to dev + sets
  // the story done, OR comments the required changes + sends it back to todo.
  // Assignment to the review agent is the idempotency marker (see
  // selectReviewDispatch) so a story under review is not re-dispatched.
  const inReviewRuns = {};
  for (const i of inReview) inReviewRuns[i.identifier] = backlog.getIssueRuns(i.identifier);

  // Per-story PR gather (shared by false-done + review dispatch). Multica's
  // issue<->PR linkage is empty in practice, so backlog.getIssuePullRequests
  // ITSELF falls back to gh discovery (across REVIEW_REPO_OWNER's repos +
  // REVIEW_SEARCH_REPOS — see multica/backlog.mjs) — the router no longer
  // does its own repo-discovery scan (ghListRepos/ghOpenPrs/ghPrs are now
  // internal to the adapter). Matching stays slug-aware via core's
  // prIdentityMatchesStory/detectFalseDone (matches the story's short key,
  // e.g. m-01, not only the PAN id, so slug-branched PRs are still found).
  const doneIssues = issues.filter((i) => (i.status || '').toLowerCase() === 'done');

  // Gate on the story's OWN PR by branch/title identity (not a body mention), so a
  // parent/seed ticket that some unrelated PR merely references is never dispatched.
  // getIssuePullRequests returns PRs of ANY state (unlike the old ghOpenPrs, which
  // was open-only), so prIsOpen must now be checked explicitly here.
  const openPrIds = new Set();
  for (const i of inReview) {
    let prs = [];
    try { prs = backlog.getIssuePullRequests(i.identifier); }
    catch (e) { logImpl('review_pr_lookup_error', { identifier: i.identifier, error: e.message }); }
    if (prs.some((pr) => coreImpl.prIsOpen(pr) && coreImpl.prIdentityMatchesStory(pr, i))) openPrIds.add(i.identifier);
  }
  if (inReview.length) logImpl('review_pr_scan', { checked: inReview.length, withPr: [...openPrIds] });

  // ---- STATUS TRUTH: demote wrongly-"done" stories that still have an OPEN PR ----
  // "done" must mean MERGED. A story a build/ship agent marked done while its PR is
  // still open is a lie; demote it back to in_review (capped, so never a mass flip)
  // so the review lane truly reviews+merges it (or loops it back). PR-gated: a done
  // story with no open PR is left alone (may be a legit non-code done task).
  {
    // Union each done story's OWN PRs (per-identifier, via backlog.getIssuePullRequests)
    // into one array — detectFalseDone itself applies the prIsOpen/ownPrUrl/repo-qualified
    // matching per doneIssue, so passing mixed-state PRs here is correct (unchanged
    // from when openPrsAll mixed states too, in practice, before this dedupe existed).
    const donePrs = [];
    const seenPr = new Set();
    for (const i of doneIssues) {
      let prs = [];
      try { prs = backlog.getIssuePullRequests(i.identifier); }
      catch (e) { logImpl('false_done_pr_lookup_error', { identifier: i.identifier, error: e.message }); }
      for (const pr of prs) {
        const key = pr.url || pr.html_url || `${pr._repo || ''}#${pr.number}`;
        if (seenPr.has(key)) continue;
        seenPr.add(key);
        donePrs.push(pr);
      }
    }
    const falseDone = coreImpl.detectFalseDone(doneIssues, donePrs);
    const cap = (cfgImpl.CAPS && cfgImpl.CAPS.perCycleFalseDone) || 3;
    let n = 0;
    for (const f of falseDone) {
      if (n >= cap) { logImpl('false_done_capped', { remaining: falseDone.length - n }); break; }
      n++;
      logImpl('advance', { identifier: f.identifier, from: 'done', to: 'in_review', kind: 'false-done', prUrl: f.prUrl, applied: !dryRun });
      if (!dryRun) {
        try { backlog.setIssueStatus(f.identifier, 'in_review'); } catch (e) { logImpl('advance_error', { identifier: f.identifier, to: 'in_review', error: e.message }); }
      }
    }
  }

  const reviewInflight = coreImpl.computeReviewInflight(inReview, cfgImpl);
  const reviewPicks = coreImpl.selectReviewDispatch(inReview, inReviewRuns, cfgImpl, reviewInflight, { now, openPrIds });
  const inReviewById = new Map(inReview.map((i) => [i.id, i]));
  for (const r of reviewPicks) {
    // SCALE-BY-TICKET: size the SQUAD for THIS ticket (which of product/technical/
    // qa/ux run, and whether QA drives a real browser via Playwright). Auriga stays
    // the THIN router — it computes the plan and fires ONE dispatch carrying it; the
    // auriga-review SQUAD agent reads the plan (logged here + posted onto the ticket)
    // and runs each enabled perspective, truly verifying. See core.reviewSquadPlan +
    // agents/auriga-review.instructions.md.
    const issueObj = inReviewById.get(r.issueId) || { identifier: r.identifier };
    const plan = coreImpl.reviewSquadPlan(issueObj, cfgImpl);
    logImpl('review', {
      identifier: r.identifier, agent: r.agent, action: r.action, reason: r.reason,
      squad: plan.tier, perspectives: plan.perspectives, playwright: plan.playwright, applied: !dryRun,
    });
    if (dryRun) continue;
    try {
      if (r.action === 'dispatch-review') {
        // Publish the squad plan onto the ticket so what the squad will do is visible
        // on the board up front and is read by the squad agent (best-effort; a comment
        // failure must never block the dispatch).
        backlog.commentOnIssue(
          r.identifier,
          'REVIEW SQUAD PLAN — ' + coreImpl.squadPlanSummary(plan) +
          '\n\nThe review agent runs each enabled perspective and TRULY verifies (QA runs the real build + tests' +
          (plan.playwright ? ' + Playwright/E2E' : '') +
          '), then merges to dev on a real all-perspective pass, or sends the story back with concrete per-perspective feedback.'
        );
        // reassign the in_review story to the review agent, then force-enqueue a
        // fresh run for it (assignee-mutation alone does not reliably enqueue —
        // the dispatch dead-zone; rerun re-enqueues the CURRENT assignment, so we
        // sleep first to let the new assignee propagate before rerun).
        spawn.assignIssue(r.identifier, r.agent);
        await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
      }
      spawn.rerunIssue(r.identifier);
      logImpl('review_dispatched', { identifier: r.identifier, agent: r.agent, squad: plan.tier });
    } catch (e) {
      logImpl('review_error', { identifier: r.identifier, agent: r.agent, error: e.message });
    }
  }

  // ---- zombie recovery ----
  // Board-wide scan feeds the STATUS passes, but zombie recovery DISPATCHES
  // (rerun/assign), so restrict it to the aligned dispatch set (cfgImpl.PROJECT_IDS) —
  // never fire a build run into an unscanned/unaligned project.
  if (!noZombie) {
    const inProgressDispatch = inProgress.filter((i) => cfgImpl.PROJECT_IDS.includes(i.project_id));
    const zombies = coreImpl.detectZombies(inProgressDispatch, runsByIssue, cfgImpl, now);
    for (const z of zombies) {
      if (assigned >= maxAssign) break;
      if (z.action === 'rerun') {
        logImpl('zombie', { ...z, applied: !dryRun });
        if (!dryRun) { try { spawn.rerunIssue(z.identifier); assigned++; } catch (e) { logImpl('zombie_error', { identifier: z.identifier, error: e.message }); } }
      } else {
        // needs (re)routing — route via its lane
        const agent = coreImpl.chooseAgentForProject(z.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} }, z.isHive);
        if (!agent) { logImpl('zombie_skip', { ...z, reason: 'no-lane-capacity' }); continue; }
        logImpl('zombie', { ...z, agent, applied: !dryRun });
        if (!dryRun) {
          try {
            spawn.assignIssue(z.identifier, agent);
            assigned++;
            inflight[agent] = (inflight[agent] || 0) + 1;
          } catch (e) { logImpl('zombie_error', { identifier: z.identifier, error: e.message }); }
        }
      }
    }
  }

  // ---- route new todos ----
  const remaining = Math.max(0, maxAssign - assigned);
  const picks = coreImpl.selectAssignments(issues, cfgImpl, inflight, {
    blockedRuntimes,
    exclude: cascaded,
    maxTotal: Math.min(cfgImpl.CAPS.perCycleTotal, remaining || cfgImpl.CAPS.perCycleTotal),
  });

  for (const p of picks) {
    if (assigned >= maxAssign) break;
    logImpl('route', { identifier: p.identifier, agent: p.agent, lane: p.lane, runtime: p.runtime, applied: !dryRun });
    if (dryRun) continue;
    try {
      spawn.assignIssue(p.identifier, p.agent);
      assigned++;
    } catch (e) {
      const msg = e.message || '';
      logImpl('assign_error', { identifier: p.identifier, agent: p.agent, error: msg });
      // If a lane errors with a limit/quota, block that runtime for the rest of this cycle.
      if (/limit|quota|rate|429|exhaust/i.test(msg)) blockedRuntimes.add(p.runtime);
      continue;
    }
    // verify a run started; force-enqueue if not (dead-zone fix)
    await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
    const runs = backlog.getIssueRuns(p.identifier);
    const started = runs.length > 0 && runs.some((r) => {
      const c = coreImpl.classifyRun(r, Date.now());
      return c.active || c.done || c.failed; // any run row means it dispatched
    });
    if (!started) {
      logImpl('verify_no_run', { identifier: p.identifier, agent: p.agent, action: 'rerun' });
      try { spawn.rerunIssue(p.identifier); } catch (e) { logImpl('rerun_error', { identifier: p.identifier, error: e.message }); }
    } else {
      const lr = coreImpl.latestRun(runs);
      const c = lr ? coreImpl.classifyRun(lr, Date.now()) : {};
      logImpl('verify_ok', { identifier: p.identifier, agent: p.agent, runStatus: c.status, runtimeId: lr && lr.runtime_id });
    }
  }

  return { todo: todo.length, picked: picks.length, assigned };
}

// ---- main loop -------------------------------------------------------------
async function main() {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('start', { pid: process.pid, once: ONCE, dry: DRY, maxAssign: MAX_ASSIGN === Infinity ? null : MAX_ASSIGN, caps: cfg.CAPS });

  let totalAssigned = 0;
  do {
    try {
      const remaining = MAX_ASSIGN === Infinity ? Infinity : Math.max(0, MAX_ASSIGN - totalAssigned);
      const result = await cycle({ maxAssign: remaining });
      totalAssigned += result.assigned;
    } catch (e) {
      log('cycle_error', { error: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
    }
    if (totalAssigned >= MAX_ASSIGN) { log('max_assign_reached', { assigned: totalAssigned }); break; }
    if (!ONCE) await sleep(cfg.CAPS.cycleMs);
  } while (!ONCE);

  log('stop', { assigned: totalAssigned });
  releaseLock();
}

// Only run the live daemon loop when this file is executed directly (`node
// auriga-router.mjs ...` / the `auriga-router` bin) — never when imported,
// e.g. by tests that want `cycle()` against a mock Multica layer.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) main();
