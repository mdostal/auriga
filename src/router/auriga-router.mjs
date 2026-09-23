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
import { ISSUE_STATUS, ISSUE_STATUS_ALT_SPELLINGS, isTerminalIssueStatus } from './lib/issue-status.mjs';
import { createPantheonV2L2BacklogAdapter, createPantheonV2L2SpawnAdapter } from './lib/adapters/pantheon-v2-l2/index.mjs';
import { loadRealTopology, resolveParentBoardConfig } from './lib/orchestrator-topology.mjs';
import { loadExternalConfig } from './lib/config-loader.mjs';
import { loadTenantConfigs, rotate } from './lib/tenant-configs.mjs';

// Live defaults — constructed once at module load (cheap: a factory closure,
// no HTTP call happens until a method is actually invoked), exactly
// mirroring the old `import * as mca from './lib/multica.mjs'`
// singleton-module pattern. verifyDelayMs/lane-map fields mirror the
// router's live CAPS/lane config so a future describeLanes() consumer sees
// byte-identical values.
//
// Cutover (pantheon-owns-multica-board-bridge epic): these were
// createMulticaBacklogAdapter/createMulticaSpawnAdapter (this file's own
// direct-to-Multica adapters, ./lib/adapters/multica/{backlog,spawn}.mjs),
// which shelled out to the native `multica` CLI binary -- a real,
// standing architecture violation (Auriga integrating with Multica
// directly) that also could not run inside this container at all. Now
// routed exclusively through Pantheon's own backlog API -- see
// ./lib/adapters/pantheon-v2-l2/README.md for the full rationale and its
// documented, deliberate scope boundaries.
//
// KNOWN GAP, carried over from that cutover, not silently absorbed: the
// pantheon-v2-l2 backlog adapter's getIssuePullRequests() returns Multica's
// native issue<->PR linkage only -- it does NOT port the old adapter's
// GitHub-based gh-scan fallback (a separate, non-Multica integration, out
// of this epic's scope). That native linkage was previously described as
// "empty in practice" -- so PR-based verification (false-done detection,
// review-dispatch's PR matching) may find fewer/no PRs until a follow-up
// story ports GitHub discovery into this adapter too. Does not block board
// reading, status transitions, or initial dispatch -- only later-lifecycle
// PR-verification steps, which tonight's freshly-filed board items don't
// reach yet.
const defaultBacklog = createPantheonV2L2BacklogAdapter();
const defaultSpawn = createPantheonV2L2SpawnAdapter({
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
const INSTANCE_ID = process.env.AURIGA_INSTANCE_ID || null;
const TENANT_ID = process.env.AURIGA_TENANT_ID || null;

// s14: single-instance multi-tenant consolidation. Off by default -- a
// deliberate, explicit opt-in per docs/s14-consolidation-design.md's own
// no-big-bang rollout plan, never inferred from other env vars.
// AURIGA_TENANT_ID/AURIGA_CONFIG remain fully live and unchanged for every
// existing single-tenant container (standalone mode) when this is unset.
const MULTI_TENANT = process.env.AURIGA_MULTI_TENANT === '1';
const PANTHEON_API_URL = process.env.PANTHEON_API_URL || 'http://core-api:3012';
// Real safety gap found live during s14's own first deploy (2026-09-21): the
// facade returns EVERY tenant with auriga_project_ids set, including ones a
// separate, already-live standalone container is actively dispatching --
// running this loop unfiltered risks a genuine double-dispatch race. Unset
// (the default) means "no restriction" -- the deliberate, later, full-
// rollout mode once a tenant's standalone container has actually been
// retired. Comma-separated tenant_ids, e.g. "dostal-tech,personal".
const _allowlistRaw = process.env.AURIGA_MULTI_TENANT_ALLOWLIST
  ? new Set(process.env.AURIGA_MULTI_TENANT_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
// An empty Set (whitespace-only env value) is truthy but blocks every tenant silently — treat it as null (unfiltered).
const MULTI_TENANT_ALLOWLIST = _allowlistRaw && _allowlistRaw.size > 0 ? _allowlistRaw : null;

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
  if (INSTANCE_ID) rec.instance_id = INSTANCE_ID;
  if (TENANT_ID && !('tenant_id' in rec)) rec.tenant_id = TENANT_ID;
  const line = JSON.stringify(rec);
  try { fs.appendFileSync(LOGFILE, line + '\n'); } catch {}
  console.log(line);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// s14: builds a fresh {backlog, spawn} adapter pair scoped to one tenant's
// merged config -- mirrors defaultBacklog/defaultSpawn's own construction
// above exactly, just parameterized per tenant instead of module-scope-once.
function buildAdaptersForTenant(tenantId, tenantCfg) {
  const backlog = createPantheonV2L2BacklogAdapter({ tenantId });
  const spawn = createPantheonV2L2SpawnAdapter({
    tenantId,
    verifyDelayMs: tenantCfg.CAPS.verifyDelayMs,
    projectLane: tenantCfg.PROJECT_LANE,
    defaultLane: tenantCfg.DEFAULT_LANE,
    hiveLane: tenantCfg.HIVE_LANE,
    reviewLane: tenantCfg.REVIEW_LANE,
    runtimeCap: tenantCfg.RUNTIME_CAP,
  });
  return { backlog, spawn };
}

// s14: wraps the module-level log() with a fixed tenant_id, so per-tenant
// cycle() calls tag their own log lines without log() itself needing any
// change (mirrors the existing INSTANCE_ID/TENANT_ID-on-every-record
// pattern, just bound per call instead of per process).
function tenantLog(tenantId) {
  return (event, data) => log(event, { ...data, tenant_id: tenantId });
}

// ---- one cycle -------------------------------------------------------------
// opts: { backlog, spawn, cfg, core, log, sleep, dryRun, noZombie, maxAssign, now, initialBlockedRuntimes }
// Every dependency defaults to the live module-level singleton, so calling
// cycle() with no args (from main()) is exactly the original live behavior.
// Returns { todo, picked, assigned }.
// opts.initialBlockedRuntimes: Set<string> — pre-seed blockedRuntimes before any pass runs (tests only).
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

  // t015 — orchestrator hand-up: read once per cycle, same pattern as every
  // other per-cycle config read. `createRemoteBacklog` is injectable so a
  // test can stand up a stub adapter instead of a real cross-board HTTP
  // call — see this file's own opts.backlog/opts.spawn precedent.
  const loadTopologyImpl = opts.loadTopology || loadRealTopology;
  const loadExternalConfigImpl = opts.loadExternalConfig || loadExternalConfig;
  const createRemoteBacklog = opts.createRemoteBacklog || createPantheonV2L2BacklogAdapter;
  const topology = loadTopologyImpl();
  const parentBoardConfig = resolveParentBoardConfig(topology, loadExternalConfigImpl());

  let assigned = 0;

  // `issues` itself is fetched board-wide (scanIds spans every known project, not
  // just this tenant's own cfgImpl.PROJECT_IDS) because dependency-graph resolution
  // (detectUnblocks' declared-deps check, etc.) needs to see the WHOLE board to
  // read a sibling issue's status, even outside this tenant's own aligned set.
  //
  // CORRECTION (2026-09-13): an earlier version of this comment claimed "only
  // observation goes board-wide" and asserted selectAssignments was the only pass
  // that needed a cfgImpl.PROJECT_IDS filter. That was WRONG and caused a real,
  // live incident — every one of the STATUS passes below (unblock, parent-rollup,
  // run-completion, verified-done, changeback, false-done) actually WRITES
  // (setIssueStatus/unassignIssue), it is not read-only observation, and none of
  // them were filtering their own input to cfgImpl.PROJECT_IDS before this fix. A
  // second tenant's Auriga instance was confirmed live mutating another tenant's
  // ticket status (a real dostal-tech PANT-* ticket, unblocked by the
  // firefly-events instance). Every pass below now filters its own candidate set
  // to cfgImpl.PROJECT_IDS at the point it's computed — look for that filter
  // locally at each pass rather than trusting a blanket claim here again.
  const discovered = backlog.listAllProjectIds();
  const scanIds = [...new Set([...(discovered.length ? discovered : cfgImpl.PROJECT_IDS), ...cfgImpl.PROJECT_IDS])];
  const issues = backlog.listAllIssues(scanIds);
  const inflight = coreImpl.computeInflight(issues, cfgImpl.AGENTS);
  const runtimeInflight = coreImpl.computeRuntimeInflight(inflight, cfgImpl.AGENTS);
  // Observability only (NOT capacity): the assigned-todo backlog. If this climbs while
  // inflight stays ~0, dispatch is happening but runs aren't starting (dead-zone) — the
  // signal that used to hide inside the old inflight number and deadlock the router.
  const assignedQueued = coreImpl.computeAssignedQueued(issues, cfgImpl.AGENTS);

  // ---- BOARD-WIDE PR candidate scan (ONCE per cycle) ----
  // Restores the pre-cutover router's own top-level ghListRepos/ghOpenPrs/
  // ghPrs gather (which ran once per cycle and was reused across every
  // issue): backlog.listCandidatePullRequests(), when the adapter provides it
  // (the real Multica adapter does; simpler test/stub adapters generally
  // don't), does the raw repo-wide gh scan HERE, ONCE, and every call site
  // below that needs "does issue X have a matching PR" filters this SAME
  // cached, unfiltered list via matchedPrs() — using core.mjs's real
  // prMatchesStory/prIdentityMatchesStory, never a narrower per-adapter
  // heuristic. This fixes two regressions an independent review found in this
  // epic's diff: (1) a PR matching only via a story's short slug key (not the
  // raw ticket identifier) is found again, and (2) the repo-wide gh scan no
  // longer re-runs per issue per call site (an O(issues x repos) subprocess
  // explosion), it runs once per cycle like it always did pre-cutover.
  let candidatePrs = null;
  if (typeof backlog.listCandidatePullRequests === 'function') {
    try { candidatePrs = backlog.listCandidatePullRequests(); }
    catch (e) { logImpl('candidate_pr_scan_error', { error: e.message }); }
  }
  // Returns the PRs in `candidatePrs` matching `issueObj` via `matcher`
  // (coreImpl.prMatchesStory or coreImpl.prIdentityMatchesStory). Falls back
  // to backlog.getIssuePullRequests's own per-identifier lookup (filtered by
  // the SAME rich matcher) only when the adapter has no board-wide scan —
  // e.g. stub/mock adapters used by unit tests.
  function matchedPrs(identifier, issueObj, matcher) {
    if (candidatePrs) return candidatePrs.filter((pr) => matcher(pr, issueObj));
    return backlog.getIssuePullRequests(identifier).filter((pr) => matcher(pr, issueObj));
  }

  const todo = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO && !i.assignee_id && !coreImpl.isSmokeScratch(i.title));
  logImpl('scan', {
    total: issues.length,
    todoUnassigned: todo.length,
    inflight,
    runtimeInflight,
    assignedQueued,
  });

  const blockedRuntimes = new Set(opts.initialBlockedRuntimes || []);

  // ---- state-machine: blocked -> todo when declared deps clear (PAN-6662) ----
  // The multi-story crux. A story parked in `blocked` at plan time (its dep stories
  // not built yet) is invisible to every other pass — the build candidate pool only
  // scans `todo`. detectUnblocks finds blocked stories whose DECLARED depends_on graph
  // is fully satisfied and advances them to todo + unassign so they re-enter routing as
  // fresh candidates. Guard: skip any that already have runs (already built / in flight),
  // so an anomalous blocked-with-open-PR story is never re-dispatched.
  {
    // DISPATCH stays gated to this tenant's own aligned projects (2026-09-13 fix —
    // this pass WRITES setIssueStatus/unassignIssue, it is not observation; a
    // second tenant instance could otherwise unblock/reassign another tenant's
    // own blocked ticket, confirmed live). statusById/issues below stay
    // board-wide on purpose — they're read-only context for resolving a
    // declared dependency's status, never mutated.
    const blockedIssues = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.BLOCKED && cfgImpl.PROJECT_IDS.includes(i.project_id));
    const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
    // Pass the WHOLE board so DESCRIPTION-declared slug deps resolve against siblings
    // (metadata-only dep resolution missed the m-02-depends-on-m-01 case).
    const unblocks = coreImpl.detectUnblocks(blockedIssues, statusById, issues, cfgImpl);
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
        // Matches against the per-cycle cached board-wide PR scan (see
        // matchedPrs above) via the real prMatchesStory — not a narrower
        // per-adapter heuristic.
        try { hasPr = matchedPrs(u.identifier, issueObj, coreImpl.prMatchesStory).length > 0; }
        catch (e) { logImpl('unblock_pr_lookup_error', { identifier: u.identifier, repo: slug, error: e.message }); }
      }
      if (hasPr) { logImpl('unblock_skip', { identifier: u.identifier, reason: 'existing-pr', repo: slug }); continue; }
      logImpl('advance', { identifier: u.identifier, from: ISSUE_STATUS.BLOCKED, to: ISSUE_STATUS.TODO, applied: !dryRun });
      if (!dryRun) {
        try {
          backlog.setIssueStatus(u.identifier, ISSUE_STATUS.TODO);
          try { spawn.unassignIssue(u.identifier); } catch (e) { logImpl('unblock_unassign_error', { identifier: u.identifier, error: e.message }); }
        } catch (e) { logImpl('advance_error', { identifier: u.identifier, to: ISSUE_STATUS.TODO, error: e.message }); }
      }
    }

    // ---- state-machine: parent/epic -> done when every child is terminal ----
    // Nothing else closes a parent when its last child completes. Fires only when
    // ALL of a parent's visible children are done/cancelled and the parent isn't
    // already terminal. Observation is board-wide (mirrors detectUnblocks: children
    // may live in discovered-only projects outside PROJECT_IDS). Mutation is still
    // gated to PROJECT_IDS parents only — never roll up a cross-tenant parent.
    const parentDone = coreImpl.detectParentDone(issues, cfgImpl);
    for (const pd of parentDone) {
      if (!cfgImpl.PROJECT_IDS.includes(pd.projectId)) continue; // never mutate cross-tenant parent
      logImpl('advance', { identifier: pd.identifier, to: ISSUE_STATUS.DONE, kind: 'parent-rollup', applied: !dryRun });
      if (!dryRun) {
        try { backlog.setIssueStatus(pd.identifier, ISSUE_STATUS.DONE); } catch (e) { logImpl('advance_error', { identifier: pd.identifier, to: ISSUE_STATUS.DONE, error: e.message }); }
      }
    }
  }

  // ---- state-machine: in_progress -> in_review, in_review -> done ----
  // Pure-code, no agent calls. Single-instance pidfile lock (acquireLock above)
  // makes each cycle atomic w.r.t. other router processes; re-deriving the
  // candidate set fresh from board state every cycle makes both transitions
  // idempotent (a transitioned issue simply drops out of its source filter).
  // DISPATCH-scoped (writes setIssueStatus) — see the blocked->todo pass above.
  const inProgress = issues.filter((i) => [
    ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS_ALT_SPELLINGS.IN_PROGRESS_SPACED, ISSUE_STATUS.RUNNING,
  ].includes((i.status || '').toLowerCase()) && cfgImpl.PROJECT_IDS.includes(i.project_id));
  const runsByIssue = {};
  for (const i of inProgress) runsByIssue[i.identifier] = backlog.getIssueRuns(i.identifier);

  const completions = coreImpl.detectRunCompletions(inProgress, runsByIssue, now, cfgImpl, issues);
  for (const c of completions) {
    logImpl('advance', { identifier: c.identifier, to: ISSUE_STATUS.IN_REVIEW, applied: !dryRun });
    if (!dryRun) {
      try { backlog.setIssueStatus(c.identifier, ISSUE_STATUS.IN_REVIEW); } catch (e) { logImpl('advance_error', { identifier: c.identifier, to: ISSUE_STATUS.IN_REVIEW, error: e.message }); }
    }
  }

  // DISPATCH-scoped (writes setIssueStatus via detectVerifiedDone below, and
  // feeds review-dispatch further down) — see the blocked->todo pass above.
  const inReview = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.IN_REVIEW && cfgImpl.PROJECT_IDS.includes(i.project_id));
  const prsByIssue = {};
  for (const i of inReview) prsByIssue[i.identifier] = matchedPrs(i.identifier, i, coreImpl.prMatchesStory);
  const verified = coreImpl.detectVerifiedDone(inReview, prsByIssue, cfgImpl, issues);
  for (const v of verified) {
    logImpl('advance', { identifier: v.identifier, to: ISSUE_STATUS.DONE, applied: !dryRun });
    if (!dryRun) {
      try { backlog.setIssueStatus(v.identifier, ISSUE_STATUS.DONE); } catch (e) { logImpl('advance_error', { identifier: v.identifier, to: ISSUE_STATUS.DONE, error: e.message }); }
      if (typeof spawn.reportRouteOutcome === 'function') {
        try { spawn.reportRouteOutcome(v.identifier, 'success'); } catch (e) { logImpl('route_outcome_error', { identifier: v.identifier, error: e.message }); }
      }
    }
  }
  // Exclude just-advanced issues from the review-dispatch snapshot so a stale
  // run on a now-done ticket does not trigger a spurious rerun-review in this
  // same cycle (mirrors the `cascaded` exclusion in selectAssignments below).
  const _verifiedThisCycle = new Set(verified.map((v) => v.identifier));
  const inReviewForDispatch = _verifiedThisCycle.size
    ? inReview.filter((i) => !_verifiedThisCycle.has(i.identifier))
    : inReview;

  // ---- state-machine: changes_requested -> todo (review loop-back) ----
  // The review lane sets changes_requested as the formal "send back" signal;
  // the router owns the todo transition + unassign so a build lane can pick
  // the story up again. This is the durable code path — never rely solely on
  // agent free-text for a status mutation the state machine should handle.
  // DISPATCH-scoped (writes setIssueStatus/unassignIssue) — see the
  // blocked->todo pass above.
  {
    const changesRequested = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.CHANGES_REQUESTED && cfgImpl.PROJECT_IDS.includes(i.project_id));
    const changeBacks = coreImpl.detectChangesRequested(changesRequested, cfgImpl);
    for (const cb of changeBacks) {
      logImpl('advance', { identifier: cb.identifier, from: ISSUE_STATUS.CHANGES_REQUESTED, to: ISSUE_STATUS.TODO, applied: !dryRun });
      if (!dryRun) {
        try {
          backlog.setIssueStatus(cb.identifier, ISSUE_STATUS.TODO);
          try { spawn.unassignIssue(cb.identifier); } catch (e) { logImpl('changeback_unassign_error', { identifier: cb.identifier, error: e.message }); }
        } catch (e) { logImpl('advance_error', { identifier: cb.identifier, to: ISSUE_STATUS.TODO, error: e.message }); }
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
  // existing PR, caps per cycle (cfgImpl.CAPS.perCycleCascade), and records each handled
  // identifier in `cascaded` so selectAssignments below does not double-dispatch it.
  const cascaded = new Set();
  // Accumulate per-runtime assignments across cascade AND zombie loops so the
  // per-runtime cap is enforced within each loop and across both sequentially.
  // selectAssignments derives its own runtimeInflight from inflight, so it is
  // unaffected; this only fixes the within-loop gap.
  const loopRtProjected = {};
  const priorAgentCycleAssigns = {};
  {
    const doneIds = new Set(
      issues
        .filter((i) => isTerminalIssueStatus((i.status || '').toLowerCase()))
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
      let issueRuns = [];
      try { issueRuns = backlog.getIssueRuns(c.identifier); }
      catch (e) { logImpl('cascade_runs_error', { identifier: c.identifier, error: e.message }); }
      if (issueRuns.some((r) => coreImpl.classifyRun(r, now).active)) {
        logImpl('cascade_skip', { identifier: c.identifier, reason: 'active-run' }); continue;
      }
      // Idempotency 2b: skip a story whose last run completed within the cooldown window
      // (bounds tight fail-retry loops — PAN-7771). Run age is free from the already-fetched
      // getIssueRuns result — same bounded-stateless idiom as zombieMaxAttempts.
      // Add to `cascaded` so selectAssignments also skips it this cycle.
      const lrForCooldown = coreImpl.latestRun(issueRuns);
      if (lrForCooldown) {
        const lrC = coreImpl.classifyRun(lrForCooldown, now);
        if (!lrC.active && lrC.ageMs < (cfgImpl.CAPS.redispatchCooldownMs ?? (15 * 60 * 1000))) {
          logImpl('cascade_skip', { identifier: c.identifier, reason: 'redispatch-cooldown', ageMs: lrC.ageMs });
          cascaded.add(c.identifier);
          continue;
        }
      }
      // Idempotency 2: never re-dispatch a story that already produced a PR (open =
      // in review, merged = shipped) — same gh-based guard the unblock pass uses,
      // matched against the per-cycle cached board-wide PR scan (see matchedPrs
      // above).
      const slug = coreImpl.normalizeRepoSlug(coreImpl.targetRepoValue(issueObj) || '');
      if (slug) {
        try {
          if (matchedPrs(c.identifier, issueObj, coreImpl.prMatchesStory).length > 0) {
            logImpl('cascade_skip', { identifier: c.identifier, reason: 'existing-pr', repo: slug });
            continue;
          }
        } catch (e) { logImpl('cascade_pr_lookup_error', { identifier: c.identifier, repo: slug, error: e.message }); }
      }
      logImpl('cascade_dispatch', { identifier: c.identifier, from: c.status, projectId: c.projectId, applied: !dryRun });
      if (dryRun) { cascadeFired++; cascaded.add(c.identifier); continue; }
      let agent; // hoisted so cascade catch can read it for blockedRuntimes
      try {
        if (c.status === ISSUE_STATUS.BLOCKED) backlog.setIssueStatus(c.identifier, ISSUE_STATUS.TODO);
        // Ensure an assignee on the story's lane, then rerun to FORCE-ENQUEUE (rerun
        // re-enqueues the CURRENT assignment; assignee-mutation alone does not).
        // NOT routed through spawn.dispatch() (a real, tested method with a
        // genuinely different contract here — see spawn-adapter.mjs's typedef):
        // dispatch()'s verify-then-conditionally-rerun contract assumes assign
        // SOMETIMES auto-enqueues a run and rerun is only a fallback; this cascade
        // path instead treats rerun as ALWAYS required (assign never enqueues on
        // its own) and always force-reruns, whether or not a run already exists —
        // a genuinely different semantics, not a stale duplicate of the same logic.
        agent = coreImpl.chooseAgentForProject(c.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: loopRtProjected }, coreImpl.isHiveStory(issueObj));
        // Skip only when no agent has capacity AND the issue has no existing assignee.
        // If the issue already has an assignee, rerunIssue re-enqueues it without a
        // new assignment — no need to skip; the assigned-idle path's ~10 min lag is avoided.
        if (!agent && !issueObj.assignee_id) { logImpl('cascade_skip', { identifier: c.identifier, reason: 'no-capacity' }); continue; }
        const maxPerAgentCascade = cfgImpl.CAPS.perCyclePerAgent ?? Infinity;
        if (agent && (priorAgentCycleAssigns[agent] || 0) >= maxPerAgentCascade) {
          logImpl('cascade_skip', { identifier: c.identifier, reason: 'per-cycle-per-agent-cap', agent });
          continue;
        }
        if (agent) {
          if (typeof spawn.selectRoute === 'function') {
            try { spawn.selectRoute(c.identifier, 'build'); } catch (e) { logImpl('route_select_error', { identifier: c.identifier, error: e.message }); }
          }
          spawn.assignIssue(c.identifier, agent);
          inflight[agent] = (inflight[agent] || 0) + 1;
          const cAgentRt = cfgImpl.AGENTS[agent]?.runtime;
          if (cAgentRt) loopRtProjected[cAgentRt] = (loopRtProjected[cAgentRt] || 0) + 1;
          priorAgentCycleAssigns[agent] = (priorAgentCycleAssigns[agent] || 0) + 1;
          await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
          assigned++;
        }
        if (!agent && issueObj.assignee_id) {
          const existingAgentName = Object.entries(cfgImpl.AGENTS).find(([, a]) => a.id === issueObj.assignee_id)?.[0];
          const existingRt = existingAgentName && cfgImpl.AGENTS[existingAgentName]?.runtime;
          if (existingRt && blockedRuntimes.has(existingRt)) {
            logImpl('cascade_skip', { identifier: c.identifier, reason: 'assignee-runtime-blocked', runtime: existingRt });
            continue;
          }
          if (existingAgentName && (priorAgentCycleAssigns[existingAgentName] || 0) >= maxPerAgentCascade) {
            logImpl('cascade_skip', { identifier: c.identifier, reason: 'per-cycle-per-agent-cap', agent: existingAgentName });
            continue;
          }
          if (existingAgentName) priorAgentCycleAssigns[existingAgentName] = (priorAgentCycleAssigns[existingAgentName] || 0) + 1;
          if (existingAgentName) inflight[existingAgentName] = (inflight[existingAgentName] || 0) + 1;
          if (existingRt) loopRtProjected[existingRt] = (loopRtProjected[existingRt] || 0) + 1;
          assigned++;
        }
        spawn.rerunIssue(c.identifier);
        cascadeFired++;
        cascaded.add(c.identifier);
        logImpl('cascade_enqueued', { identifier: c.identifier, agent: agent || issueObj.assignee_id });
      } catch (e) {
        logImpl('cascade_error', { identifier: c.identifier, error: e.message });
        const msg = e.message || '';
        if (/limit|quota|rate|429|exhaust/i.test(msg)) {
          const rt = agent && cfgImpl.AGENTS[agent]?.runtime;
          if (rt) blockedRuntimes.add(rt);
        }
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

  // Per-story PR gather (shared by false-done + review dispatch), drawn from
  // the SAME per-cycle cached board-wide scan (candidatePrs, gathered once
  // near the top of cycle() — see matchedPrs above). Matching stays
  // slug-aware via core's prIdentityMatchesStory/detectFalseDone (matches the
  // story's short key, e.g. m-01, not only the PAN id, so slug-branched PRs
  // are still found).
  // DISPATCH-scoped (feeds detectFalseDone below, which writes setIssueStatus)
  // — see the blocked->todo pass above.
  const doneIssues = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.DONE && cfgImpl.PROJECT_IDS.includes(i.project_id));

  // ---- STATUS TRUTH: demote wrongly-"done" stories that still have an OPEN PR ----
  // "done" must mean MERGED. A story a build/ship agent marked done while its PR is
  // still open is a lie; demote it back to in_review (capped, so never a mass flip)
  // so the review lane truly reviews+merges it (or loops it back). PR-gated: a done
  // story with no open PR is left alone (may be a legit non-code done task).
  {
    // detectFalseDone itself applies the prIsOpen/ownPrUrl/repo-qualified/
    // prIdentityMatchesStory matching per doneIssue against a BOARD-WIDE
    // candidate list (exactly like the pre-cutover router's own openPrsAll),
    // so the full unfiltered candidatePrs scan is passed straight through
    // when available. Only adapters with no board-wide scan (e.g. stub/test
    // adapters) fall back to unioning each done issue's own per-identifier
    // lookup, de-duplicated by PR url — the pre-fix per-issue gather shape,
    // kept only as that fallback's approximation of a board-wide list.
    let donePrs;
    if (candidatePrs) {
      donePrs = candidatePrs;
    } else {
      donePrs = [];
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
    }
    const falseDone = coreImpl.detectFalseDone(doneIssues, donePrs, cfgImpl, issues);
    const cap = (cfgImpl.CAPS && cfgImpl.CAPS.perCycleFalseDone) || 3;
    let n = 0;
    for (const f of falseDone) {
      if (n >= cap) { logImpl('false_done_capped', { remaining: falseDone.length - n }); break; }
      n++;
      logImpl('advance', { identifier: f.identifier, from: ISSUE_STATUS.DONE, to: ISSUE_STATUS.IN_REVIEW, kind: 'false-done', prUrl: f.prUrl, applied: !dryRun });
      if (!dryRun) {
        try { backlog.setIssueStatus(f.identifier, ISSUE_STATUS.IN_REVIEW); } catch (e) { logImpl('advance_error', { identifier: f.identifier, to: ISSUE_STATUS.IN_REVIEW, error: e.message }); }
      }
    }
  }

  // inReview is already PROJECT_IDS-scoped at its own definition above (2026-09-13
  // fix — a firefly-events instance was confirmed live trying to dispatch review
  // for a real PANT-* dostal-tech ticket to its own review-lane agent, before
  // this and the whole board-wide-status-pass audit that followed it).
  const reviewInflight = coreImpl.computeReviewInflight(inReviewForDispatch, cfgImpl);
  const reviewMaxTotal = Math.min((cfgImpl.CAPS && cfgImpl.CAPS.perCycleReview) ?? 1, Math.max(0, maxAssign - assigned));
  const reviewPicks = coreImpl.selectReviewDispatch(inReviewForDispatch, inReviewRuns, cfgImpl, reviewInflight, { now, maxTotal: reviewMaxTotal });
  const inReviewById = new Map(inReview.map((i) => [i.id, i]));
  for (const r of reviewPicks) {
    if (assigned >= maxAssign) break;
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

    // PANT-262: give-up-review parallel to zombie give-up (detectZombies/auriga-router.mjs
    // zombie recovery). Fires after reviewMaxAttempts accumulated runs where the review
    // agent's run is consistently stale/failed — sets blocked + posts a diagnostic comment
    // so a human can find and fix the root-cause startup hang. Never retries further.
    if (r.action === 'give-up-review') {
      logImpl('review_give_up', { identifier: r.identifier, agent: r.agent, applied: true });
      try { backlog.setIssueStatus(r.identifier, ISSUE_STATUS.BLOCKED); } catch (e) { logImpl('review_give_up_error', { identifier: r.identifier, op: 'set-blocked', error: e.message }); }
      try {
        backlog.commentOnIssue(
          r.identifier,
          `Auriga review dispatch accumulated ${cfgImpl.CAPS.reviewMaxAttempts ?? 5}+ runs with no successful output (status: blocked).\n\n` +
          'The live process showed zero output tokens and near-zero CPU — consistent with a startup hang before prompt processing.\n\n' +
          '**Leading hypothesis (PANT-262 / GitHub #94):** a Playwright/E2E MCP server registered for the auriga-review agent hangs on startup — browser binary missing or network-blocked install.\n\n' +
          'Human investigation required:\n' +
          '1. Inspect MCP server registrations in the auriga-review runtime: `claude mcp list` (or `claude mcp get <name>` per server)\n' +
          '2. Look for a Playwright / browser-automation MCP server that fails to start (missing binary, blocked network)\n' +
          '3. Either pre-install the browser binary or remove the problematic MCP registration\n' +
          '4. Once the root cause is fixed, reset this ticket to `in_review` to re-enter the review queue'
        );
      } catch (e) { logImpl('review_give_up_error', { identifier: r.identifier, op: 'comment', error: e.message }); }
      continue;
    }

    const reviewRt = r.agent && cfgImpl.AGENTS[r.agent]?.runtime;
    if (reviewRt && blockedRuntimes.has(reviewRt)) {
      logImpl('review_skip', { identifier: r.identifier, agent: r.agent, reason: 'runtime-blocked', runtime: reviewRt });
      continue;
    }

    try {
      if (r.action === 'dispatch-review') {
        // Publish the squad plan onto the ticket so what the squad will do is visible
        // on the board up front and is read by the squad agent (best-effort; a comment
        // failure must never block the dispatch).
        try {
          backlog.commentOnIssue(
            r.identifier,
            'REVIEW SQUAD PLAN — ' + coreImpl.squadPlanSummary(plan) +
            '\n\nThe review agent runs each enabled perspective and TRULY verifies (QA runs the real build + tests' +
            (plan.playwright ? ' + Playwright/E2E' : '') +
            '), then merges to dev on a real all-perspective pass, or sends the story back with concrete per-perspective feedback.'
          );
        } catch (e) { logImpl('review_comment_error', { identifier: r.identifier, error: e.message }); }
        // reassign the in_review story to the review agent, then force-enqueue a
        // fresh run for it (assignee-mutation alone does not reliably enqueue —
        // the dispatch dead-zone; rerun re-enqueues the CURRENT assignment, so we
        // sleep first to let the new assignee propagate before rerun).
        // NOT routed through spawn.dispatch() (a real, tested method with a
        // genuinely different contract here — see spawn-adapter.mjs's typedef):
        // this ALWAYS force-reruns unconditionally (even on the non-dispatch-review
        // branch, which never assigns at all) rather than verifying a run started
        // first — a different contract than dispatch()'s verify-then-conditionally-
        // rerun, not a stale duplicate of it.
        if (typeof spawn.selectRoute === 'function') {
          try { spawn.selectRoute(r.identifier, 'review'); } catch (e) { logImpl('route_select_error', { identifier: r.identifier, error: e.message }); }
        }
        spawn.assignIssue(r.identifier, r.agent);
        await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
      }
      spawn.rerunIssue(r.identifier);
      assigned++;
      if (r.agent) {
        inflight[r.agent] = (inflight[r.agent] || 0) + 1;
        priorAgentCycleAssigns[r.agent] = (priorAgentCycleAssigns[r.agent] || 0) + 1;
      }
      if (reviewRt) loopRtProjected[reviewRt] = (loopRtProjected[reviewRt] || 0) + 1;
      logImpl('review_dispatched', { identifier: r.identifier, agent: r.agent, squad: plan.tier });
      // PANT-262: post-dispatch verification — mirrors plain dispatch's own verify step
      // (auriga-router.mjs "route new todos") to detect the zero-output startup hang early.
      // For dispatch-review this is the SECOND sleep (first was pre-rerunIssue); for
      // rerun-review there was no prior sleep, so this is the only one. Both cases end
      // with a run-presence check that logs review_verify_ok / review_verify_no_run —
      // the latter is the clearest early signal that the hang is happening THIS cycle
      // (not 30 minutes later when idle_watchdog fires).
      await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
      const reviewVerifyRuns = backlog.getIssueRuns(r.identifier);
      const reviewRunStarted = reviewVerifyRuns.some((run) => {
        const c = coreImpl.classifyRun(run, now);
        return c.active || c.done || c.failed;
      });
      if (!reviewRunStarted) {
        logImpl('review_verify_no_run', { identifier: r.identifier, agent: r.agent, action: r.action });
      } else {
        const lr = coreImpl.latestRun(reviewVerifyRuns);
        const c = lr ? coreImpl.classifyRun(lr, now) : {};
        logImpl('review_verify_ok', { identifier: r.identifier, agent: r.agent, action: r.action, runStatus: c.status });
      }
    } catch (e) {
      logImpl('review_error', { identifier: r.identifier, agent: r.agent, error: e.message });
      const msg = e.message || '';
      if (/limit|quota|rate|429|exhaust/i.test(msg)) {
        const rt = r.agent && cfgImpl.AGENTS[r.agent]?.runtime;
        if (rt) blockedRuntimes.add(rt);
      }
    }
  }

  // ---- zombie recovery ----
  // Board-wide scan feeds the STATUS passes, but zombie recovery DISPATCHES
  // (rerun/assign), so restrict it to the aligned dispatch set (cfgImpl.PROJECT_IDS) —
  // never fire a build run into an unscanned/unaligned project.
  if (!noZombie) {
    const inProgressDispatch = inProgress.filter((i) => cfgImpl.PROJECT_IDS.includes(i.project_id));
    const zombies = coreImpl.detectZombies(inProgressDispatch, runsByIssue, cfgImpl, now, issues);
    for (const z of zombies) {
      if (assigned >= maxAssign) break;
      if (z.action === 'give-up') {
        // GH #75 / t001-zombie-give-up: attempt cap exhausted — stop re-actuating.
        // Never call spawn.assignIssue/rerunIssue on this path. Best-effort leave
        // a human-visible marker on the issue; a comment failure must never crash
        // the cycle (matches zombie_error/unblock_unassign_error convention).
        logImpl('zombie_give_up', { ...z, applied: !dryRun });
        if (!dryRun) {
          try { backlog.setIssueStatus(z.identifier, ISSUE_STATUS.BLOCKED); } catch (e) { logImpl('zombie_give_up_error', { identifier: z.identifier, op: 'set-blocked', error: e.message }); }
          try {
            backlog.commentOnIssue(
              z.identifier,
              `Auriga auto-retried this issue ${cfgImpl.CAPS.zombieMaxAttempts} time(s) and it is still stuck with no successful run.\n` +
              'Giving up on further automatic retry attempts (bounded-retry stopgap).\n' +
              'Status set to `blocked` — a human must review and manually re-trigger or reassign.'
            );
          } catch (e) { logImpl('zombie_give_up_error', { identifier: z.identifier, op: 'comment', error: e.message }); }
        }
        continue;
      }
      if (z.action === 'rerun') {
        const zombieAgentName = Object.entries(cfgImpl.AGENTS).find(([, a]) => a.id === z.assigneeId)?.[0];
        const zombieRt = zombieAgentName && cfgImpl.AGENTS[zombieAgentName]?.runtime;
        if (zombieRt && blockedRuntimes.has(zombieRt)) {
          logImpl('zombie_skip', { ...z, reason: 'assignee-runtime-blocked', runtime: zombieRt }); continue;
        }
        const maxPerAgentZombie = cfgImpl.CAPS.perCyclePerAgent ?? Infinity;
        if (zombieAgentName && (priorAgentCycleAssigns[zombieAgentName] || 0) >= maxPerAgentZombie) {
          logImpl('zombie_skip', { ...z, reason: 'per-cycle-per-agent-cap', agent: zombieAgentName }); continue;
        }
        logImpl('zombie', { ...z, applied: !dryRun });
        if (!dryRun) {
          try {
            spawn.rerunIssue(z.identifier);
            assigned++;
            if (zombieAgentName) {
              inflight[zombieAgentName] = (inflight[zombieAgentName] || 0) + 1;
              priorAgentCycleAssigns[zombieAgentName] = (priorAgentCycleAssigns[zombieAgentName] || 0) + 1;
            }
            if (zombieRt) loopRtProjected[zombieRt] = (loopRtProjected[zombieRt] || 0) + 1;
          } catch (e) { logImpl('zombie_error', { identifier: z.identifier, error: e.message }); }
        }
      } else {
        // needs (re)routing — route via its lane
        const agent = coreImpl.chooseAgentForProject(z.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: loopRtProjected }, z.isHive);
        if (!agent) { logImpl('zombie_skip', { ...z, reason: 'no-lane-capacity' }); continue; }
        const zAgentRt = cfgImpl.AGENTS[agent]?.runtime;
        if (zAgentRt && blockedRuntimes.has(zAgentRt)) {
          logImpl('zombie_skip', { ...z, reason: 'assignee-runtime-blocked', agent, runtime: zAgentRt }); continue;
        }
        const maxPerAgentZombie = cfgImpl.CAPS.perCyclePerAgent ?? Infinity;
        if ((priorAgentCycleAssigns[agent] || 0) >= maxPerAgentZombie) {
          logImpl('zombie_skip', { ...z, reason: 'per-cycle-per-agent-cap', agent });
          continue;
        }
        logImpl('zombie', { ...z, agent, applied: !dryRun });
        if (!dryRun) {
          try {
            if (typeof spawn.selectRoute === 'function') {
              try { spawn.selectRoute(z.identifier, 'build'); } catch (e) { logImpl('route_select_error', { identifier: z.identifier, error: e.message }); }
            }
            spawn.assignIssue(z.identifier, agent);
            assigned++;
            inflight[agent] = (inflight[agent] || 0) + 1;
            priorAgentCycleAssigns[agent] = (priorAgentCycleAssigns[agent] || 0) + 1;
            if (zAgentRt) loopRtProjected[zAgentRt] = (loopRtProjected[zAgentRt] || 0) + 1;
            await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
            spawn.rerunIssue(z.identifier);
          } catch (e) {
            logImpl('zombie_error', { identifier: z.identifier, error: e.message });
            const msg = e.message || '';
            if (/limit|quota|rate|429|exhaust/i.test(msg)) {
              const rt = cfgImpl.AGENTS[agent]?.runtime;
              if (rt) blockedRuntimes.add(rt);
            }
          }
        }
      }
    }
  }

  // ---- assigned-idle recovery (PAN-7492 / PAN-8244) ----
  // Recover assigned `todo` issues that never had a run start (the dead-zone
  // scenario). Like zombie recovery, dispatches are restricted to
  // cfgImpl.PROJECT_IDS — never fire into an unscanned/unaligned project.
  {
    const agentIds = coreImpl.agentIdSet(cfgImpl.AGENTS);
    const todoAssigned = issues.filter(
      (i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO &&
        i.assignee_id && agentIds.has(i.assignee_id) &&
        cfgImpl.PROJECT_IDS.includes(i.project_id)
    );
    const todoRunsByIssue = {};
    for (const i of todoAssigned) todoRunsByIssue[i.identifier] = backlog.getIssueRuns(i.identifier);
    const idleActions = coreImpl.detectAssignedIdle(todoAssigned, todoRunsByIssue, cfgImpl, agentIds, now, issues);
    // runtimeInflight is the cycle-start snapshot and does NOT include cascade/zombie
    // additions made this cycle (those update inflight[] directly). Omitting it here
    // causes limitAssignedIdleRecoveries to recompute from the updated inflight, giving
    // the per-runtime cap the correct view. Same fix as PANT-331 bug 2 for the cascade
    // and zombie passes; see capacity.mjs:computeRuntimeInflight.
    const { selected: idleSelected } = coreImpl.limitAssignedIdleRecoveries(idleActions, cfgImpl, {
      inflight,
      blockedRuntimes,
      priorAgentCycleAssigns,
      maxTotal: Math.min(
        cfgImpl.CAPS.assignedIdlePerCycle ?? cfgImpl.CAPS.perCycleTotal,
        Math.max(0, maxAssign - assigned)
      ),
    });
    for (const a of idleSelected) {
      if (assigned >= maxAssign) break;
      logImpl('assigned_idle', { identifier: a.identifier, agent: a.agent, idleAgeMs: a.idleAgeMs, reason: a.reason, applied: !dryRun });
      if (!dryRun) {
        try {
          spawn.rerunIssue(a.identifier);
          assigned++;
          inflight[a.agent] = (inflight[a.agent] || 0) + 1;
          if (a.runtime) loopRtProjected[a.runtime] = (loopRtProjected[a.runtime] || 0) + 1;
          priorAgentCycleAssigns[a.agent] = (priorAgentCycleAssigns[a.agent] || 0) + 1;
        } catch (e) {
          logImpl('assigned_idle_error', { identifier: a.identifier, error: e.message });
          const msg = e.message || '';
          if (/limit|quota|rate|429|exhaust/i.test(msg)) {
            if (a.runtime) blockedRuntimes.add(a.runtime);
          }
        }
      }
    }
  }

  // ---- route new todos ----
  const remaining = Math.max(0, maxAssign - assigned);
  const picks = coreImpl.selectAssignments(issues, cfgImpl, inflight, {
    blockedRuntimes,
    exclude: cascaded,
    maxTotal: Math.min(cfgImpl.CAPS.perCycleTotal, remaining),
    parentBoardConfig,
    priorAgentCycleAssigns,
  });

  for (const p of picks) {
    if (assigned >= maxAssign) break;
    if (blockedRuntimes.has(p.runtime)) {
      logImpl('skip_blocked_runtime', { identifier: p.identifier, agent: p.agent, runtime: p.runtime });
      continue;
    }
    logImpl('route', { identifier: p.identifier, agent: p.agent, lane: p.lane, runtime: p.runtime, applied: !dryRun });
    if (dryRun) continue;
    try {
      if (typeof spawn.selectRoute === 'function') {
        try { spawn.selectRoute(p.identifier, 'build'); } catch (e) { logImpl('route_select_error', { identifier: p.identifier, error: e.message }); }
      }
      spawn.assignIssue(p.identifier, p.agent);
      assigned++;
    } catch (e) {
      const msg = e.message || '';
      logImpl('assign_error', { identifier: p.identifier, agent: p.agent, error: msg });
      // If a lane errors with a limit/quota, block that runtime for the rest of this cycle.
      if (/limit|quota|rate|429|exhaust/i.test(msg)) blockedRuntimes.add(p.runtime);
      continue;
    }
    // verify a run started; force-enqueue if not (dead-zone fix).
    //
    // Deliberately INLINE here, not routed through spawn.dispatch() (which
    // ports this exact assign -> verify -> force-rerun sequence — see
    // lib/adapters/multica/spawn.mjs's dispatch() and
    // lib/adapters/spawn-adapter.mjs's typedef), for the same "don't force a
    // bad abstraction" reasoning that already keeps the cascade-dispatch and
    // review-dispatch passes below off dispatch(), just a different mismatch:
    // dispatch()'s verify-wait is a REAL synchronous Atomics.wait block
    // (consistent with the SpawnAdapter interface's synchronous-by-design
    // contract — see spawn.mjs's header comment). That's fine for a
    // short-lived caller, but auriga-router.mjs is a long-lived, supervised
    // daemon (see main()'s SIGTERM/SIGINT handlers) that must stay responsive
    // during this wait, so this call site keeps its own non-blocking
    // `await sleepImpl(...)` instead of freezing the event loop for up to
    // CAPS.verifyDelayMs per dispatch (bounded by CAPS.perCycleTotal /
    // perCyclePerAgent, but still a real, live hit to signal responsiveness).
    // dispatch() itself remains correct and available for a future caller
    // that doesn't need non-blocking behavior (e.g. a short-lived CLI tool).
    await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
    const runs = backlog.getIssueRuns(p.identifier);
    const started = runs.some((r) => {
      const c = coreImpl.classifyRun(r, now);
      return c.active || c.done || c.failed; // any run row means it dispatched
    });
    if (!started) {
      logImpl('verify_no_run', { identifier: p.identifier, agent: p.agent, action: 'rerun' });
      try { spawn.rerunIssue(p.identifier); } catch (e) { logImpl('rerun_error', { identifier: p.identifier, error: e.message }); }
    } else {
      const lr = coreImpl.latestRun(runs);
      const c = lr ? coreImpl.classifyRun(lr, now) : {};
      logImpl('verify_ok', { identifier: p.identifier, agent: p.agent, runStatus: c.status, runtimeId: lr && lr.runtime_id });
    }
  }

  // ---- route hand-ups (t015 — orchestrator hand-up) ----
  // coreImpl.selectAssignments only ever populates picks.handUps when
  // parentBoardConfig was non-null (see that function's own routing branch),
  // so this loop is a no-op whenever no real parent board is configured —
  // exactly the "no knowledge or nowhere to move it -- 100% human job"
  // fallback; those tickets already fell through to the existing
  // isHumanTodo/human-queue-export path untouched.
  for (const h of picks.handUps || []) {
    logImpl('hand_up', {
      identifier: h.identifier, reason: h.reason,
      parent: topology.parent ? topology.parent.id : null,
      targetProjectId: parentBoardConfig.projectId,
      applied: !dryRun,
    });
    if (dryRun) continue;

    const issue = issues.find((i) => i.identifier === h.identifier);

    // Cancel locally BEFORE the remote create. Once CANCELLED the issue is
    // out of the todo candidate pool, so a later cycle cannot create a second
    // parent-board issue even if the post-create local mutations below fail
    // (the original duplicate-on-retry bug). If the cancel itself fails we
    // skip the remote create entirely and let the next cycle retry.
    try {
      backlog.setIssueStatus(h.identifier, ISSUE_STATUS.CANCELLED);
    } catch (e) {
      logImpl('hand_up_pre_cancel_error', { identifier: h.identifier, error: e.message });
      continue;
    }

    let createdIssue;
    try {
      const remoteBacklog = createRemoteBacklog({ baseUrl: parentBoardConfig.baseUrl, project: parentBoardConfig.projectId });
      createdIssue = remoteBacklog.createIssue({
        title: issue ? issue.title : h.identifier,
        description: issue ? issue.description : undefined,
        metadata: { handed_up_from: h.identifier },
      });
    } catch (e) {
      // Remote create failed — undo the pre-cancel so the issue re-enters
      // the candidate pool next cycle rather than being stranded as cancelled.
      logImpl('hand_up_error', { identifier: h.identifier, error: e.message });
      try { backlog.setIssueStatus(h.identifier, ISSUE_STATUS.TODO); } catch (_) {}
      continue;
    }

    logImpl('hand_up_ok', { identifier: h.identifier, newIdentifier: createdIssue && createdIssue.identifier });
    try {
      backlog.commentOnIssue(h.identifier, `Handed up — created ${createdIssue && createdIssue.identifier} on the parent board.`);
    } catch (e) { logImpl('hand_up_comment_error', { identifier: h.identifier, error: e.message }); }
    try {
      spawn.unassignIssue(h.identifier);
    } catch (e) { logImpl('hand_up_unassign_error', { identifier: h.identifier, error: e.message }); }
  }

  return { todo: todo.length, picked: picks.length, assigned };
}

// ---- main loop (single-tenant, standalone -- unchanged) --------------------
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

// ---- main loop (s14: multi-tenant consolidation) ---------------------------
// One process, every real tenant. Fetches the live tenant list + per-tenant
// config once per FULL loop iteration (not per cycle-internal step -- see
// s14 design doc §4's cycle-timing note), then runs one cycle() per tenant,
// sequentially, rotating iteration order each pass so no single tenant is
// always scanned last. AURIGA_TENANT_ID/AURIGA_CONFIG are not read at all in
// this mode -- every tenant's config comes from the live facade.
async function mainMultiTenant() {
  acquireLock();
  process.on('exit', releaseLock);
  process.on('SIGINT', () => { releaseLock(); process.exit(0); });
  process.on('SIGTERM', () => { releaseLock(); process.exit(0); });

  log('start_multi_tenant', { pid: process.pid, once: ONCE, dry: DRY, pantheonApiUrl: PANTHEON_API_URL });

  let rotation = 0;
  let iterations = 0;
  let totalAssigned = 0;
  do {
    let tenants = [];
    try {
      tenants = await loadTenantConfigs({ pantheonApiBaseUrl: PANTHEON_API_URL, baseCfg: cfg, allowlist: MULTI_TENANT_ALLOWLIST });
    } catch (e) {
      log('tenant_configs_error', { error: e.message });
    }
    if (!tenants.length) {
      log('no_tenants_found', {});
    } else {
      for (const { tenantId, cfg: tenantCfg } of rotate(tenants, rotation)) {
        if (totalAssigned >= MAX_ASSIGN) break;
        const remaining = MAX_ASSIGN === Infinity ? Infinity : Math.max(0, MAX_ASSIGN - totalAssigned);
        try {
          const { backlog, spawn } = buildAdaptersForTenant(tenantId, tenantCfg);
          const result = await cycle({ backlog, spawn, cfg: tenantCfg, log: tenantLog(tenantId), dryRun: DRY, maxAssign: remaining });
          totalAssigned += result.assigned;
          log('tenant_cycle_done', { tenant_id: tenantId, todo: result.todo, picked: result.picked, assigned: result.assigned });
        } catch (e) {
          log('tenant_cycle_error', { tenant_id: tenantId, error: e.message, stack: (e.stack || '').split('\n').slice(0, 3).join(' | ') });
        }
      }
      rotation += 1;
    }
    iterations += 1;
    if (totalAssigned >= MAX_ASSIGN) { log('max_assign_reached', { assigned: totalAssigned }); break; }
    if (!ONCE) await sleep(cfg.CAPS.cycleMs);
  } while (!ONCE);

  log('stop_multi_tenant', { iterations, assigned: totalAssigned });
  releaseLock();
}

// Only run the live daemon loop when this file is executed directly (`node
// auriga-router.mjs ...` / the `auriga-router` bin) — never when imported,
// e.g. by tests that want `cycle()` against a mock Multica layer.
const isMainModule = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  if (MULTI_TENANT) { mainMultiTenant(); } else { main(); }
}

export { buildAdaptersForTenant, mainMultiTenant };
