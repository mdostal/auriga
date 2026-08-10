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
import { probeClaudeAuth } from './lib/claude-auth-status.mjs';
import { runCompletionHook } from '../auriga/hooks.ts';

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

function liveAgentMap() {
  const agents = { ...cfg.AGENTS };
  try {
    for (const a of mca.listAgents()) {
      if (!a.id || !a.name) continue;
      agents[a.name] = {
        id: a.id,
        runtime: a.runtime_id || agents[a.name]?.runtime || 'unknown',
        maxInflight: a.max_concurrent_tasks || agents[a.name]?.maxInflight || 1,
      };
    }
  } catch (e) {
    log('agent_list_error', { error: e.message });
  }
  return agents;
}

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
const runtimeForAgentId = (agentId) =>
  Object.values(cfg.AGENTS).find((a) => a.id === agentId)?.runtime || null;

// ---- one cycle -------------------------------------------------------------
async function cycle() {
  const now = Date.now();
  const blockedRuntimes = new Set();
  if (Object.values(cfg.AGENTS).some((a) => a.runtime === 'claude')) {
    const auth = probeClaudeAuth();
    if (auth.status === 'auth_required') blockedRuntimes.add('claude');
    log('claude_auth_status', {
      status: auth.status,
      checkedAt: auth.checked_at,
      blocked: blockedRuntimes.has('claude'),
      ...(auth.error ? { error: auth.error } : {}),
    });
  }

  // Board-wide observation for status passes; selectAssignments still gates
  // dispatch to cfg.PROJECT_IDS internally.
  const discovered = mca.listAllProjectIds();
  const scanIds = [...new Set([...(discovered.length ? discovered : cfg.PROJECT_IDS), ...cfg.PROJECT_IDS])];
  const issues = mca.listAllIssues(scanIds);
  const allAgents = liveAgentMap();
  const allAgentIds = core.agentIdSet(allAgents);
  const agentNameById = Object.fromEntries(Object.entries(allAgents).map(([name, a]) => [a.id, name]));
  let workspaceTodoIssues = [];
  let workspaceInProgressIssues = [];
  try {
    workspaceTodoIssues = mca.listAllWorkspaceIssues('todo');
  } catch (e) {
    log('assigned_idle_list_error', { error: e.message, phase: 'todo' });
  }
  try {
    workspaceInProgressIssues = mca.listAllWorkspaceIssues('in_progress');
  } catch (e) {
    log('assigned_idle_list_error', { error: e.message, phase: 'in_progress' });
  }
  const inflight = core.computeInflight(issues, cfg.AGENTS);
  const runtimeInflight = core.computeRuntimeInflight(inflight, cfg.AGENTS);
  // Workspace-wide inflight (all live agents, not just the aligned-lane subset
  // in cfg.AGENTS) — the self-heal pass below recovers stuck work for every
  // agent on the board, so its capacity math must see every agent's real load.
  const workspaceInflight = core.computeInflight(workspaceInProgressIssues, allAgents);
  const workspaceRuntimeInflight = core.computeRuntimeInflight(workspaceInflight, allAgents);
  // Observability only (NOT capacity): the assigned-todo backlog. If this climbs while
  // inflight stays ~0, dispatch is happening but runs aren't starting (dead-zone) — the
  // signal that used to hide inside the old inflight number and deadlock the router.
  const assignedQueued = core.computeAssignedQueued(issues, cfg.AGENTS);
  const assignedQueuedAll = core.computeAssignedQueued(workspaceTodoIssues, allAgents);

  const todo = issues.filter((i) => (i.status || '').toLowerCase() === 'todo' && !i.assignee_id && !core.isSmokeScratch(i.title));
  log('scan', {
    total: issues.length,
    todoUnassigned: todo.length,
    inflight,
    runtimeInflight,
    assignedQueued,
    assignedQueuedAll,
  });

  // ---- assigned-todo self-heal (PAN-7492 / PAN-8244) ----
  const assignedTodoIssues = workspaceTodoIssues
    .filter((i) => i.assignee_id && allAgentIds.has(i.assignee_id))
    .filter((i) => !core.isSmokeScratch(i.title))
    .filter((i) => !core.isHumanTodo(i, cfg));
  const assignedRuns = {};
  for (const i of assignedTodoIssues) assignedRuns[i.identifier] = mca.issueRuns(i.identifier);
  const { selected: assignedIdle, skipped: assignedIdleSkipped } = core.limitAssignedIdleRecoveries(
    core.detectAssignedIdle(assignedTodoIssues, assignedRuns, cfg, allAgentIds, now),
    cfg,
    {
      agents: allAgents,
      agentNameById,
      inflight: workspaceInflight,
      runtimeInflight: workspaceRuntimeInflight,
      runtimeCap: cfg.RUNTIME_CAP,
      blockedRuntimes,
      maxTotal: Math.min(cfg.CAPS.assignedIdlePerCycle ?? cfg.CAPS.perCycleTotal, Math.max(0, MAX_ASSIGN - assignedThisProcess)),
    }
  );
  // Every non-recovered item carries a skipReason (rate-limited / at-capacity /
  // per-cycle-cap) so a stuck assignedQueued count is explainable, not just a
  // number that never moves.
  for (const s of assignedIdleSkipped) {
    log('assigned_idle_skip', { identifier: s.identifier, agent: s.agent || agentNameById[s.assigneeId] || s.assigneeId, runtime: s.runtime, skipReason: s.skipReason, idleAgeMs: s.idleAgeMs });
  }
  for (const a of assignedIdle) {
    if (assignedThisProcess >= MAX_ASSIGN) break;
    log('assigned_idle', { ...a, applied: !DRY });
    if (DRY) continue;
    // `issue rerun` is the documented, deterministic way to re-enqueue an
    // issue's current agent assignment — unlike flipping status to
    // in_progress (which only enqueues on a backlog -> non-backlog
    // transition server-side and is a no-op from todo), this always fires.
    try {
      mca.rerunIssue(a.identifier);
      assignedThisProcess++;
    } catch (e) {
      log('assigned_idle_rerun_error', { identifier: a.identifier, agent: a.agent, error: e.message });
      continue;
    }
    await sleep(cfg.CAPS.verifyDelayMs);
    const runs = mca.issueRuns(a.identifier);
    const lr = core.latestRun(runs);
    const c = lr ? core.classifyRun(lr, Date.now()) : null;
    if (c && (c.active || c.done || c.failed)) {
      log('assigned_idle_verify_ok', { identifier: a.identifier, agent: a.agent, runStatus: c.status, runtimeId: lr && lr.runtime_id });
    } else {
      log('assigned_idle_verify_no_run', { identifier: a.identifier, agent: a.agent });
    }
  }

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
    const unblocks = core.detectUnblocks(blockedIssues, statusById, issues);
    for (const u of unblocks) {
      // Guard: never re-dispatch a story that already produced a PR — an OPEN PR
      // means it is already in review, a MERGED PR means it already shipped. A
      // merely-stale or failed run from earlier churn must NOT block the unblock
      // (that is exactly the cm-02/cm-03 case: one refused run each from the
      // pre-target_repo churn, but never actually built). So gate on a real PR,
      // discovered via gh in the story's own target repo, not on run count.
      const issueObj = blockedIssues.find((b) => b.id === u.issueId) || {};
      const slug = core.normalizeRepoSlug(core.targetRepoValue(issueObj) || '');
      let hasPr = false;
      if (slug) {
        try { hasPr = mca.ghPrs(slug, 'all').some((pr) => core.prMatchesStory(pr, issueObj)); }
        catch (e) { log('unblock_pr_lookup_error', { identifier: u.identifier, repo: slug, error: e.message }); }
      }
      if (hasPr) { log('unblock_skip', { identifier: u.identifier, reason: 'existing-pr', repo: slug }); continue; }
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
  const issueByIdentifier = new Map(inReview.map((i) => [i.identifier, i]));
  for (const v of verified) {
    log('advance', { identifier: v.identifier, to: 'done', applied: !DRY });
    if (!DRY) {
      try {
        mca.issueStatus(v.identifier, 'done');
      } catch (e) {
        log('advance_error', { identifier: v.identifier, to: 'done', error: e.message });
        continue;
      }
      try {
        const issueObj = issueByIdentifier.get(v.identifier) || {};
        const result = runCompletionHook(
          {
            id: v.issueId,
            identifier: v.identifier,
            title: issueObj.title,
            status: 'done',
            project_id: v.projectId,
            parent_issue_id: issueObj.parent_issue_id || null,
          },
          {
            getIssue: mca.getIssue,
            listChildren: mca.issueChildren,
            listProjectIssues: mca.listIssues,
            createIssue: mca.createIssue,
            setIssueMetadata: mca.setIssueMetadata,
          },
          cfg.PROJECT_NAMES,
        );
        log('completion_hook', { identifier: v.identifier, ...result });
      } catch (e) {
        log('completion_hook_error', { identifier: v.identifier, error: e.message });
      }
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
  // existing PR, caps per cycle (CAPS.perCycleCascade), and records each handled
  // identifier in `cascaded` so selectAssignments below does not double-dispatch it.
  const cascaded = new Set();
  {
    const doneIds = new Set(
      issues
        .filter((i) => { const s = (i.status || '').toLowerCase(); return s === 'done' || s === 'cancelled' || s === 'canceled'; })
        .map((i) => i.id)
    );
    const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
    const cascades = core.detectCascadeDispatch(issues, doneIds, statusById, cfg);
    let cascadeFired = 0;
    for (const c of cascades) {
      if (cascadeFired >= cfg.CAPS.perCycleCascade) break;
      if (assignedThisProcess >= MAX_ASSIGN) break;
      const issueObj = issues.find((i) => i.id === c.issueId) || { identifier: c.identifier };
      // Idempotency 1: never re-fire a story that already has an active run OR that
      // ran within the re-dispatch cooldown. A run that just COMPLETED (even a build
      // run that finished by setting the story back to blocked) counts as "already
      // attempted" — re-firing it here cancels the fresh/just-finished run and starts
      // the ~2-minute cancel-thrash (dispatch->cancel->complete->cancel forever,
      // PAN-7771). Treat BOTH in-flight and recently-finished as "started"; fetch the
      // runs once and reuse.
      let runs = [];
      try { runs = mca.issueRuns(c.identifier); }
      catch (e) { log('cascade_runs_error', { identifier: c.identifier, error: e.message }); }
      const nowT = Date.now();
      if (runs.some((r) => core.classifyRun(r, nowT).active)) { log('cascade_skip', { identifier: c.identifier, reason: 'active-run' }); continue; }
      const lastRun = core.latestRun(runs);
      if (lastRun) {
        const runAgeMs = core.classifyRun(lastRun, nowT).ageMs;
        const cooldown = cfg.CAPS.redispatchCooldownMs || (15 * 60 * 1000);
        if (runAgeMs < cooldown) { log('cascade_skip', { identifier: c.identifier, reason: 'recent-run', ageMs: runAgeMs }); continue; }
      }
      // Idempotency 2: never re-dispatch a story that already produced a PR (open =
      // in review, merged = shipped) — same gh-based guard the unblock pass uses.
      const slug = core.normalizeRepoSlug(core.targetRepoValue(issueObj) || '');
      if (slug) {
        try {
          if (mca.ghPrs(slug, 'all').some((pr) => core.prMatchesStory(pr, issueObj))) {
            log('cascade_skip', { identifier: c.identifier, reason: 'existing-pr', repo: slug });
            continue;
          }
        } catch (e) { log('cascade_pr_lookup_error', { identifier: c.identifier, repo: slug, error: e.message }); }
      }
      log('cascade_dispatch', { identifier: c.identifier, from: c.status, projectId: c.projectId, applied: !DRY });
      if (DRY) { cascadeFired++; cascaded.add(c.identifier); continue; }
      try {
        if (c.status === 'blocked') mca.issueStatus(c.identifier, 'todo');
        // Ensure an assignee on the story's lane, then rerun to FORCE-ENQUEUE (rerun
        // re-enqueues the CURRENT assignment; assignee-mutation alone does not).
        const agent = core.chooseAgentForProject(c.projectId, cfg, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} }, core.isHiveStory(issueObj));
        if (agent) {
          mca.assignIssue(c.identifier, agent);
          inflight[agent] = (inflight[agent] || 0) + 1;
          await sleep(cfg.CAPS.verifyDelayMs);
        }
        mca.rerunIssue(c.identifier);
        assignedThisProcess++;
        cascadeFired++;
        cascaded.add(c.identifier);
        log('cascade_enqueued', { identifier: c.identifier, agent: agent || null });
      } catch (e) {
        log('cascade_error', { identifier: c.identifier, error: e.message });
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
  for (const i of inReview) inReviewRuns[i.identifier] = mca.issueRuns(i.identifier);

  // Board-wide open-PR gather (shared by false-done + review dispatch).
  // Multica's issue<->PR linkage is empty in practice, so discover PRs directly via
  // gh across ALL of the owner's repos (live discovery — a new repo like logic-loops
  // is covered the moment it exists) PLUS the static fallback PLUS any explicit
  // target_repo on an in_review/done story. Matching is slug-aware (prMatchesStory):
  // it matches the story's short key (m-01) in a branch, not only the PAN id, so
  // slug-branched PRs (mnemosyne#1 feat/m-01-service) are found.
  const discoveredRepos = mca.ghListRepos(cfg.REVIEW_REPO_OWNER);
  const repoSet = new Set([
    ...discoveredRepos,
    ...(cfg.REVIEW_SEARCH_REPOS || []),
  ].map((r) => core.normalizeRepoSlug(r)).filter(Boolean));
  for (const i of inReview) { const s = core.normalizeRepoSlug(core.targetRepoValue(i) || ''); if (s) repoSet.add(s); }
  const doneIssues = issues.filter((i) => (i.status || '').toLowerCase() === 'done');
  for (const i of doneIssues) { const s = core.normalizeRepoSlug(core.targetRepoValue(i) || ''); if (s) repoSet.add(s); }
  const openPrsAll = [];
  for (const repo of repoSet) {
    try { for (const pr of mca.ghOpenPrs(repo)) { pr._repo = repo; openPrsAll.push(pr); } } catch { /* one repo failing must not abort the scan */ }
  }
  // Gate on the story's OWN PR by branch/title identity (not a body mention), so a
  // parent/seed ticket that some unrelated PR merely references is never dispatched.
  const openPrIds = new Set();
  for (const i of inReview) {
    if (openPrsAll.some((pr) => core.prIdentityMatchesStory(pr, i))) openPrIds.add(i.identifier);
  }
  if (inReview.length) log('review_pr_scan', { repos: repoSet.size, openPrs: openPrsAll.length, withPr: [...openPrIds] });

  // ---- STATUS TRUTH: demote wrongly-"done" stories that still have an OPEN PR ----
  // "done" must mean MERGED. A story a build/ship agent marked done while its PR is
  // still open is a lie; demote it back to in_review (capped, so never a mass flip)
  // so the review lane truly reviews+merges it (or loops it back). PR-gated: a done
  // story with no open PR is left alone (may be a legit non-code done task).
  {
    const falseDone = core.detectFalseDone(doneIssues, openPrsAll);
    const cap = (cfg.CAPS && cfg.CAPS.perCycleFalseDone) || 3;
    let n = 0;
    for (const f of falseDone) {
      if (n >= cap) { log('false_done_capped', { remaining: falseDone.length - n }); break; }
      n++;
      log('advance', { identifier: f.identifier, from: 'done', to: 'in_review', kind: 'false-done', prUrl: f.prUrl, applied: !DRY });
      if (!DRY) {
        try { mca.issueStatus(f.identifier, 'in_review'); } catch (e) { log('advance_error', { identifier: f.identifier, to: 'in_review', error: e.message }); }
      }
    }
  }

  const reviewInflight = core.computeReviewInflight(inReview, cfg);
  const reviewPicks = core.selectReviewDispatch(inReview, inReviewRuns, cfg, reviewInflight, { now, openPrIds });
  const inReviewById = new Map(inReview.map((i) => [i.id, i]));
  for (const r of reviewPicks) {
    // SCALE-BY-TICKET: size the SQUAD for THIS ticket (which of product/technical/
    // qa/ux run, and whether QA drives a real browser via Playwright). Auriga stays
    // the THIN router — it computes the plan and fires ONE dispatch carrying it; the
    // auriga-review SQUAD agent reads the plan (logged here + posted onto the ticket)
    // and runs each enabled perspective, truly verifying. See core.reviewSquadPlan +
    // agents/auriga-review.instructions.md.
    const issueObj = inReviewById.get(r.issueId) || { identifier: r.identifier };
    const plan = core.reviewSquadPlan(issueObj, cfg);
    log('review', {
      identifier: r.identifier, agent: r.agent, action: r.action, reason: r.reason,
      squad: plan.tier, perspectives: plan.perspectives, playwright: plan.playwright, applied: !DRY,
    });
    if (DRY) continue;
    try {
      if (r.action === 'dispatch-review') {
        // Publish the squad plan onto the ticket so what the squad will do is visible
        // on the board up front and is read by the squad agent (best-effort; a comment
        // failure must never block the dispatch).
        mca.issueComment(
          r.identifier,
          'REVIEW SQUAD PLAN — ' + core.squadPlanSummary(plan) +
          '\n\nThe review agent runs each enabled perspective and TRULY verifies (QA runs the real build + tests' +
          (plan.playwright ? ' + Playwright/E2E' : '') +
          '), then merges to dev on a real all-perspective pass, or sends the story back with concrete per-perspective feedback.'
        );
        // reassign the in_review story to the review agent, then force-enqueue a
        // fresh run for it (assignee-mutation alone does not reliably enqueue —
        // the dispatch dead-zone; rerun re-enqueues the CURRENT assignment, so we
        // sleep first to let the new assignee propagate before rerun).
        mca.assignIssue(r.identifier, r.agent);
        await sleep(cfg.CAPS.verifyDelayMs);
      }
      mca.rerunIssue(r.identifier);
      log('review_dispatched', { identifier: r.identifier, agent: r.agent, squad: plan.tier });
    } catch (e) {
      log('review_error', { identifier: r.identifier, agent: r.agent, error: e.message });
    }
  }

  // ---- zombie recovery ----
  // Board-wide scan feeds the STATUS passes, but zombie recovery DISPATCHES
  // (rerun/assign), so restrict it to the aligned dispatch set (cfg.PROJECT_IDS) —
  // never fire a build run into an unscanned/unaligned project.
  if (!NO_ZOMBIE) {
    const inProgressDispatch = inProgress.filter((i) => cfg.PROJECT_IDS.includes(i.project_id));
    const zombies = core.detectZombies(inProgressDispatch, runsByIssue, cfg, now);
    for (const z of zombies) {
      if (assignedThisProcess >= MAX_ASSIGN) break;
      if (z.action === 'rerun') {
        const runtime = runtimeForAgentId(z.assigneeId);
        if (runtime && blockedRuntimes.has(runtime)) {
          log('zombie_skip', { ...z, runtime, reason: 'runtime-blocked' });
          continue;
        }
        log('zombie', { ...z, applied: !DRY });
        if (!DRY) { try { mca.rerunIssue(z.identifier); assignedThisProcess++; } catch (e) { log('zombie_error', { identifier: z.identifier, error: e.message }); } }
      } else {
        // needs (re)routing — route via its lane
        const agent = core.chooseAgentForProject(z.projectId, cfg, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} }, z.isHive);
        if (!agent) { log('zombie_skip', { ...z, reason: 'no-lane-capacity' }); continue; }
        if (blockedRuntimes.has(cfg.AGENTS[agent].runtime)) {
          log('zombie_skip', { ...z, agent, runtime: cfg.AGENTS[agent].runtime, reason: 'runtime-blocked' });
          continue;
        }
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
    exclude: cascaded,
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
