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

import fs from 'node:fs';
import * as cfg from './lib/config.mjs';
import * as core from './lib/core.mjs';
import * as mca from './lib/multica.mjs';

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

let assignedThisProcess = 0;

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
async function cycle() {
  const now = Date.now();
  const issues = mca.listAllIssues(cfg.PROJECT_IDS);
  const inflight = core.computeInflight(issues, cfg.AGENTS);
  const runtimeInflight = core.computeRuntimeInflight(inflight, cfg.AGENTS);
  // Observability only (NOT capacity): the assigned-todo backlog. If this climbs while
  // inflight stays ~0, dispatch is happening but runs aren't starting (dead-zone) — the
  // signal that used to hide inside the old inflight number and deadlock the router.
  const assignedQueued = core.computeAssignedQueued(issues, cfg.AGENTS);

  const todo = issues.filter((i) => (i.status || '').toLowerCase() === 'todo' && !i.assignee_id && !core.isSmokeScratch(i.title));
  log('scan', {
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
    const unblocks = core.detectUnblocks(blockedIssues, statusById);
    for (const u of unblocks) {
      const priorRuns = mca.issueRuns(u.identifier);
      if (priorRuns.length > 0) { log('unblock_skip', { identifier: u.identifier, reason: 'has-prior-runs', runs: priorRuns.length }); continue; }
      log('advance', { identifier: u.identifier, from: 'blocked', to: 'todo', applied: !DRY });
      if (!DRY) {
        try {
          mca.issueStatus(u.identifier, 'todo');
          try { mca.unassignIssue(u.identifier); } catch (e) { log('unblock_unassign_error', { identifier: u.identifier, error: e.message }); }
        } catch (e) { log('advance_error', { identifier: u.identifier, to: 'todo', error: e.message }); }
      }
    }

    // ---- state-machine: parent/epic -> done when every child is terminal ----
    // Nothing else closes a parent when its last child completes. Fires only when
    // ALL of a parent's visible children are done/cancelled and the parent isn't
    // already terminal.
    const parentDone = core.detectParentDone(issues);
    for (const pd of parentDone) {
      log('advance', { identifier: pd.identifier, to: 'done', kind: 'parent-rollup', applied: !DRY });
      if (!DRY) {
        try { mca.issueStatus(pd.identifier, 'done'); } catch (e) { log('advance_error', { identifier: pd.identifier, to: 'done', error: e.message }); }
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
  for (const i of inProgress) runsByIssue[i.identifier] = mca.issueRuns(i.identifier);

  const completions = core.detectRunCompletions(inProgress, runsByIssue, now);
  for (const c of completions) {
    log('advance', { identifier: c.identifier, to: 'in_review', applied: !DRY });
    if (!DRY) {
      try { mca.issueStatus(c.identifier, 'in_review'); } catch (e) { log('advance_error', { identifier: c.identifier, to: 'in_review', error: e.message }); }
    }
  }

  const inReview = issues.filter((i) => (i.status || '').toLowerCase() === 'in_review');
  const prsByIssue = {};
  for (const i of inReview) prsByIssue[i.identifier] = mca.issuePullRequests(i.identifier);
  const verified = core.detectVerifiedDone(inReview, prsByIssue);
  for (const v of verified) {
    log('advance', { identifier: v.identifier, to: 'done', applied: !DRY });
    if (!DRY) {
      try { mca.issueStatus(v.identifier, 'done'); } catch (e) { log('advance_error', { identifier: v.identifier, to: 'done', error: e.message }); }
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
  for (const i of inReview) inReviewRuns[i.identifier] = mca.issueRuns(i.identifier);

  // Compute which in_review stories have a REAL open PR referencing the ticket.
  // Multica's issue<->PR linkage is empty in practice, so discover PRs directly via
  // gh across the baseline review-search repos PLUS any explicit target_repo declared
  // on an in_review story, matching broadly (head branch / title / body). Stories with
  // no matching open PR (parent seeds / planning / idea tickets) are NOT dispatched to
  // review, so the review path can never false-block them.
  const repoSet = new Set((cfg.REVIEW_SEARCH_REPOS || []).map((r) => core.normalizeRepoSlug(r)).filter(Boolean));
  for (const i of inReview) {
    const slug = core.normalizeRepoSlug(core.targetRepoValue(i) || '');
    if (slug) repoSet.add(slug);
  }
  const openPrsAll = [];
  for (const repo of repoSet) {
    try { for (const pr of mca.ghOpenPrs(repo)) openPrsAll.push(pr); } catch { /* one repo failing must not abort the scan */ }
  }
  const openPrIds = new Set();
  for (const i of inReview) {
    if (openPrsAll.some((pr) => core.prReferencesIssue(pr, i.identifier))) openPrIds.add(i.identifier);
  }
  if (inReview.length) log('review_pr_scan', { repos: repoSet.size, openPrs: openPrsAll.length, withPr: [...openPrIds] });

  const reviewInflight = core.computeReviewInflight(inReview, cfg);
  const reviewPicks = core.selectReviewDispatch(inReview, inReviewRuns, cfg, reviewInflight, { now, openPrIds });
  for (const r of reviewPicks) {
    log('review', { identifier: r.identifier, agent: r.agent, action: r.action, reason: r.reason, applied: !DRY });
    if (DRY) continue;
    try {
      if (r.action === 'dispatch-review') {
        // reassign the in_review story to the review agent, then force-enqueue a
        // fresh run for it (assignee-mutation alone does not reliably enqueue —
        // the dispatch dead-zone; rerun re-enqueues the CURRENT assignment, so we
        // sleep first to let the new assignee propagate before rerun).
        mca.assignIssue(r.identifier, r.agent);
        await sleep(cfg.CAPS.verifyDelayMs);
      }
      mca.rerunIssue(r.identifier);
      log('review_dispatched', { identifier: r.identifier, agent: r.agent });
    } catch (e) {
      log('review_error', { identifier: r.identifier, agent: r.agent, error: e.message });
    }
  }

  // ---- zombie recovery ----
  if (!NO_ZOMBIE) {
    const zombies = core.detectZombies(inProgress, runsByIssue, cfg, now);
    for (const z of zombies) {
      if (assignedThisProcess >= MAX_ASSIGN) break;
      if (z.action === 'rerun') {
        log('zombie', { ...z, applied: !DRY });
        if (!DRY) { try { mca.rerunIssue(z.identifier); assignedThisProcess++; } catch (e) { log('zombie_error', { identifier: z.identifier, error: e.message }); } }
      } else {
        // needs (re)routing — route via its lane
        const agent = core.chooseAgentForProject(z.projectId, cfg, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} }, z.isHive);
        if (!agent) { log('zombie_skip', { ...z, reason: 'no-lane-capacity' }); continue; }
        log('zombie', { ...z, agent, applied: !DRY });
        if (!DRY) {
          try {
            mca.assignIssue(z.identifier, agent);
            assignedThisProcess++;
            inflight[agent] = (inflight[agent] || 0) + 1;
          } catch (e) { log('zombie_error', { identifier: z.identifier, error: e.message }); }
        }
      }
    }
  }

  // ---- route new todos ----
  const remaining = Math.max(0, MAX_ASSIGN - assignedThisProcess);
  const picks = core.selectAssignments(issues, cfg, inflight, {
    blockedRuntimes,
    maxTotal: Math.min(cfg.CAPS.perCycleTotal, remaining || cfg.CAPS.perCycleTotal),
  });

  for (const p of picks) {
    if (assignedThisProcess >= MAX_ASSIGN) break;
    log('route', { identifier: p.identifier, agent: p.agent, lane: p.lane, runtime: p.runtime, applied: !DRY });
    if (DRY) continue;
    try {
      mca.assignIssue(p.identifier, p.agent);
      assignedThisProcess++;
    } catch (e) {
      const msg = e.message || '';
      log('assign_error', { identifier: p.identifier, agent: p.agent, error: msg });
      // If a lane errors with a limit/quota, block that runtime for the rest of this cycle.
      if (/limit|quota|rate|429|exhaust/i.test(msg)) blockedRuntimes.add(p.runtime);
      continue;
    }
    // verify a run started; force-enqueue if not (dead-zone fix)
    await sleep(cfg.CAPS.verifyDelayMs);
    const runs = mca.issueRuns(p.identifier);
    const started = runs.length > 0 && runs.some((r) => {
      const c = core.classifyRun(r, Date.now());
      return c.active || c.done || c.failed; // any run row means it dispatched
    });
    if (!started) {
      log('verify_no_run', { identifier: p.identifier, agent: p.agent, action: 'rerun' });
      try { mca.rerunIssue(p.identifier); } catch (e) { log('rerun_error', { identifier: p.identifier, error: e.message }); }
    } else {
      const lr = core.latestRun(runs);
      const c = lr ? core.classifyRun(lr, Date.now()) : {};
      log('verify_ok', { identifier: p.identifier, agent: p.agent, runStatus: c.status, runtimeId: lr && lr.runtime_id });
    }
  }

  return { todo: todo.length, picked: picks.length };
}

// ---- main loop -------------------------------------------------------------
async function main() {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('start', { pid: process.pid, once: ONCE, dry: DRY, maxAssign: MAX_ASSIGN === Infinity ? null : MAX_ASSIGN, caps: cfg.CAPS });

  do {
    try {
      await cycle();
    } catch (e) {
      log('cycle_error', { error: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
    }
    if (assignedThisProcess >= MAX_ASSIGN) { log('max_assign_reached', { assigned: assignedThisProcess }); break; }
    if (!ONCE) await sleep(cfg.CAPS.cycleMs);
  } while (!ONCE);

  log('stop', { assigned: assignedThisProcess });
  releaseLock();
}

main();
