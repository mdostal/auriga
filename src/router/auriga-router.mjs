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
//   AURIGA_CYCLE_MS, AURIGA_PIDFILE, AURIGA_LOG, AURIGA_HEARTBEAT_FILE.
// Logging: JSONL to stdout by default; to the AURIGA_LOG file when set.
// Every cycle ends with one `cycle_summary` event and a heartbeat-file write
// (see README "Observability").
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
import { assignmentMetadata } from './lib/fingerprint.mjs';
import { dispatchEligible, isRateLimitError } from './lib/dispatch-guards.mjs';
import { loadRealTopology, resolveParentBoardConfig, resolveChildBoardConfigs } from './lib/orchestrator-topology.mjs';
import { loadExternalConfig } from './lib/config-loader.mjs';
import { loadTenantConfigs, rotate } from './lib/tenant-configs.mjs';
import { createCycleCounter, createLogger, defaultHeartbeatFile, DEFAULT_PIDFILE, writeHeartbeat } from './lib/observability.mjs';

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

const PIDFILE = process.env.AURIGA_PIDFILE || DEFAULT_PIDFILE;
const HEARTBEAT_FILE = defaultHeartbeatFile(process.env);

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
// JSONL to stdout, or to the AURIGA_LOG file when set; stamps
// AURIGA_INSTANCE_ID/AURIGA_TENANT_ID on every record (lib/observability.mjs).
const log = createLogger();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// s14: builds a fresh {backlog, spawn} adapter pair scoped to one tenant's
// merged config -- mirrors defaultBacklog/defaultSpawn's own construction
// above exactly, just parameterized per tenant instead of module-scope-once.
function buildAdaptersForTenant(tenantId, tenantCfg, { decisions } = {}) {
  const backlog = createPantheonV2L2BacklogAdapter({ tenantId });
  const spawn = createPantheonV2L2SpawnAdapter({
    tenantId,
    decisions,
    verifyDelayMs: tenantCfg.CAPS.verifyDelayMs,
    projectLane: tenantCfg.PROJECT_LANE,
    defaultLane: tenantCfg.DEFAULT_LANE,
    hiveLane: tenantCfg.HIVE_LANE,
    reviewLane: tenantCfg.REVIEW_LANE,
    runtimeCap: tenantCfg.RUNTIME_CAP,
  });
  return { backlog, spawn };
}

// PANT-388: the spawn adapter's _decisions store (selectRoute() at dispatch
// in cycle N -> reportRouteOutcome() once the run is verified in cycle N+K)
// must outlive a single cycle, exactly like defaultSpawn does in main().
// mainMultiTenant() therefore keeps one adapter pair per tenant across
// cycles, rebuilding it only when the tenant config the adapters capture at
// construction time changes -- and even then the same per-tenant decisions
// Map is handed to the rebuilt spawn adapter, so no pending outcome is lost.
function tenantAdapterFingerprint(tenantCfg) {
  return JSON.stringify([
    tenantCfg.CAPS?.verifyDelayMs,
    tenantCfg.PROJECT_LANE,
    tenantCfg.DEFAULT_LANE,
    tenantCfg.HIVE_LANE,
    tenantCfg.REVIEW_LANE,
    tenantCfg.RUNTIME_CAP,
  ]);
}

function getTenantAdapters(cache, tenantId, tenantCfg, build = buildAdaptersForTenant) {
  const fingerprint = tenantAdapterFingerprint(tenantCfg);
  const cached = cache.get(tenantId);
  if (cached && cached.fingerprint === fingerprint) return cached.adapters;
  const decisions = cached ? cached.decisions : new Map();
  const adapters = build(tenantId, tenantCfg, { decisions });
  cache.set(tenantId, { fingerprint, decisions, adapters });
  return adapters;
}

// s14: wraps the module-level log() with a fixed tenant_id, so per-tenant
// cycle() calls tag their own log lines without log() itself needing any
// change (mirrors the existing INSTANCE_ID/TENANT_ID-on-every-record
// pattern, just bound per call instead of per process).
function tenantLog(tenantId) {
  return (event, data) => log(event, { ...data, tenant_id: tenantId });
}

// ---- one dispatch ----------------------------------------------------------
// The one place a cycle() pass commits a dispatch (PANT-815). Always in this
// order:
//   1. the adapter call: `assign` selects the route then calls assignIssue,
//      `rerun` calls rerunIssue.
//   2. on success, reserve the cycle's shared counters so later passes see it.
//   3. on an `assign`, write the assignment fingerprint (PAN-8245).
// A rate-limit error blocks `runtime` for the rest of the cycle. Errors are
// returned rather than logged, so each pass keeps its own error event.
//
// reserve: 'slot' (inflight, per-agent and runtime counters), 'held-slot' (the
// issue is in_progress, so already counted in inflight at cycle start: per-agent
// and runtime only), or 'none' (an earlier assign already reserved the slot).
// countDispatch: count it against maxAssign (dc.assigned). An assign that a
// forced rerun follows passes false, so only the rerun counts (PANT-677).
function commitDispatch(dc, { identifier, agent, runtime, pass, action, issue, reserve = 'slot', countDispatch = true }) {
  try {
    if (action === 'assign') {
      if (typeof dc.spawn.selectRoute === 'function') {
        const kind = pass === 'review' ? 'review' : 'build';
        try { dc.spawn.selectRoute(identifier, kind); } catch (e) { dc.log('route_select_error', { identifier, error: e.message }); }
      }
      dc.spawn.assignIssue(identifier, agent);
    } else {
      dc.spawn.rerunIssue(identifier);
    }
  } catch (error) {
    if (runtime && isRateLimitError(error)) dc.blockedRuntimes.add(runtime);
    return { ok: false, error };
  }

  if (reserve !== 'none') {
    if (agent) {
      if (reserve === 'slot') dc.inflight[agent] = (dc.inflight[agent] || 0) + 1;
      dc.priorAgentCycleAssigns[agent] = (dc.priorAgentCycleAssigns[agent] || 0) + 1;
    }
    if (runtime) dc.loopRtProjected[runtime] = (dc.loopRtProjected[runtime] || 0) + 1;
  }
  if (countDispatch) dc.assigned++;

  if (action === 'assign' && typeof dc.backlog.setIssueMetadata === 'function') {
    const issueObj = issue || dc.issues.find((i) => i.identifier === identifier) || { identifier };
    try { dc.backlog.setIssueMetadata(identifier, assignmentMetadata(issueObj, agent, dc.cfg, { now: dc.now })); }
    catch (e) { dc.log('assign_metadata_error', { identifier, error: e.message }); }
  }
  return { ok: true };
}

// Has any run row appeared for the issue (any row means it dispatched)?
function runState(dc, identifier) {
  const runs = dc.backlog.getIssueRuns(identifier);
  const started = runs.some((run) => {
    const c = dc.core.classifyRun(run, dc.now);
    return c.active || c.done || c.failed;
  });
  const lr = started ? dc.core.latestRun(runs) : null;
  return { started, status: lr ? dc.core.classifyRun(lr, dc.now).status : undefined, runtimeId: lr && lr.runtime_id };
}

// After an assign, check a run started and force-enqueue one if not: an
// assignment alone does not always enqueue a run (the dead-zone fix).
//
// Deliberately not routed through spawn.dispatch(), which ports this same
// assign -> verify -> force-rerun sequence (see lib/adapters/spawn-adapter.mjs's
// typedef). dispatch()'s verify-wait is a REAL synchronous Atomics.wait block,
// consistent with the SpawnAdapter interface's synchronous-by-design contract.
// That's fine for a short-lived caller, but the router is a long-lived,
// supervised daemon (see main()'s SIGTERM/SIGINT handlers) that must stay
// responsive, so it waits with a non-blocking `await dc.sleep(...)` instead of
// freezing the event loop for up to CAPS.verifyDelayMs per dispatch.
async function verifyAssignStarted(dc, { identifier, agent, runtime, pass, noRunEvent, okEvent }) {
  await dc.sleep(dc.cfg.CAPS.verifyDelayMs);
  const run = runState(dc, identifier);
  if (run.started) {
    dc.log(okEvent, { identifier, agent, runStatus: run.status, runtimeId: run.runtimeId });
    return;
  }
  dc.log(noRunEvent, { identifier, agent, action: 'rerun' });
  const rerun = commitDispatch(dc, { identifier, agent, runtime, pass, action: 'rerun', reserve: 'none', countDispatch: false });
  if (!rerun.ok) dc.log('rerun_error', { identifier, error: rerun.error.message });
}

// Park an issue for a human once automatic retries give up: blocked status, a
// blocked_reason, and a comment explaining why. Each step is best-effort and a
// failure is logged, never thrown, so it can't crash the cycle.
function parkForHuman(dc, identifier, { blockedReason, comment, errorEvent }) {
  try { dc.backlog.setIssueStatus(identifier, ISSUE_STATUS.BLOCKED); }
  catch (e) { dc.log(errorEvent, { identifier, op: 'set-blocked', error: e.message }); }
  if (typeof dc.backlog.setIssueMetadata === 'function') {
    try { dc.backlog.setIssueMetadata(identifier, { blocked_reason: blockedReason }); }
    catch (e) { dc.log(errorEvent, { identifier, op: 'set-blocked-reason', error: e.message }); }
  }
  try { dc.backlog.commentOnIssue(identifier, comment); }
  catch (e) { dc.log(errorEvent, { identifier, op: 'comment', error: e.message }); }
}

function reviewGiveUpComment(cfgImpl) {
  return `Auriga review dispatch accumulated ${cfgImpl.CAPS.reviewMaxAttempts ?? 5}+ runs with no successful output (status: blocked).\n\n` +
    'The live process showed zero output tokens and near-zero CPU — consistent with a startup hang before prompt processing.\n\n' +
    '**Leading hypothesis (PANT-262 / GitHub #94):** a Playwright/E2E MCP server registered for the auriga-review agent hangs on startup — browser binary missing or network-blocked install.\n\n' +
    'Human investigation required:\n' +
    '1. Inspect MCP server registrations in the auriga-review runtime: `claude mcp list` (or `claude mcp get <name>` per server)\n' +
    '2. Look for a Playwright / browser-automation MCP server that fails to start (missing binary, blocked network)\n' +
    '3. Either pre-install the browser binary or remove the problematic MCP registration\n' +
    '4. Once the root cause is fixed, reset this ticket to `in_review` to re-enter the review queue';
}

function zombieGiveUpComment(cfgImpl) {
  return `Auriga auto-retried this issue ${cfgImpl.CAPS.zombieMaxAttempts} time(s) and it is still stuck with no successful run.\n` +
    'Giving up on further automatic retry attempts (bounded-retry stopgap).\n' +
    'Status set to `blocked` — a human must review and manually re-trigger or reassign.';
}

// Publish the review squad plan onto the ticket, so what the squad will do is
// visible on the board up front and is read by the squad agent. Best-effort: a
// comment failure must never block the dispatch.
function postSquadPlan(dc, identifier, plan) {
  try {
    dc.backlog.commentOnIssue(
      identifier,
      'REVIEW SQUAD PLAN — ' + dc.core.squadPlanSummary(plan) +
      '\n\nThe review agent runs each enabled perspective and TRULY verifies (QA runs the real build + tests' +
      (plan.playwright ? ' + Playwright/E2E' : '') +
      '), then merges to dev on a real all-perspective pass, or sends the story back with concrete per-perspective feedback.'
    );
  } catch (e) { dc.log('review_comment_error', { identifier, error: e.message }); }
}

// PANT-684: unassign todo issues whose assignee is an archived/removed agent.
// selectAssignments skips them (non-router-managed assignee), detectZombies
// skips them (todo, not in_progress), and detectAssignedIdle skips them
// (assignee not in knownAgentIds). Unassigning lets them re-enter the normal
// candidate pool as fresh todos so selectAssignments routes them this cycle.
function unassignArchivedAgents(dc, agentIds, dryRun) {
  const todoArchivedAssigned = dc.issues.filter(
    (i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO &&
      i.assignee_id && !agentIds.has(i.assignee_id) &&
      dc.cfg.PROJECT_IDS.includes(i.project_id)
  );
  const archivedActions = dc.core.detectArchivedAssignments(todoArchivedAssigned, dc.cfg, agentIds);
  const archivedCap = dc.cfg.CAPS.archivedAgentPerCycle ?? 5;
  let archivedFired = 0;
  for (const a of archivedActions) {
    if (archivedFired >= archivedCap) break;
    dc.log('archived_agent_unassign', { identifier: a.identifier, assigneeId: a.assigneeId, applied: !dryRun });
    if (dryRun) { archivedFired++; continue; }
    try {
      dc.spawn.unassignIssue(a.identifier);
      archivedFired++;
    } catch (e) {
      dc.log('archived_agent_unassign_error', { identifier: a.identifier, error: e.message });
    }
  }
}

// ---- one cycle -------------------------------------------------------------
// opts: { backlog, spawn, cfg, core, log, sleep, dryRun, noZombie, maxAssign, now, initialBlockedRuntimes, heartbeatFile }
// Every dependency defaults to the live module-level singleton, so calling
// cycle() with no args (from main()) is exactly the original live behavior.
// Returns { todo, picked, assigned }.
// opts.initialBlockedRuntimes: Set<string> — pre-seed blockedRuntimes before any pass runs (tests only).
// opts.heartbeatFile: rewritten after every cycle_summary. Only main()/
// mainMultiTenant() pass it, so tests calling cycle() touch no files.
//
// PANT-817: exactly one `cycle_summary` closes every cycle, including one
// that throws part-way (emitted from `finally`, then the error propagates to
// the caller's cycle_error/tenant_cycle_error handling as before).
export async function cycle(opts = {}) {
  const baseLog = opts.log || log;
  const counter = createCycleCounter();
  const state = { issuesScanned: 0, blockedRuntimes: null };
  const startedAt = Date.now();
  let result = null;
  let thrown = null;
  try {
    result = await runCycle({ ...opts, log: counter.wrap(baseLog) }, state);
    return result;
  } catch (e) {
    thrown = e;
    throw e;
  } finally {
    const summary = {
      ts: new Date().toISOString(),
      duration_ms: Date.now() - startedAt,
      issues_scanned: state.issuesScanned,
      todo: result ? result.todo : null,
      picked: result ? result.picked : null,
      assigned: result ? result.assigned : null,
      passes: counter.passes(),
      errors: counter.errors() + (thrown ? 1 : 0),
      aborted: Boolean(thrown),
      ...(thrown ? { abort_error: thrown.message } : {}),
      blocked_runtimes: state.blockedRuntimes ? [...state.blockedRuntimes].sort() : [],
      dry_run: opts.dryRun ?? DRY,
    };
    try { baseLog('cycle_summary', summary); } catch {}
    if (opts.heartbeatFile) {
      try { writeHeartbeat(opts.heartbeatFile, { ...summary, pid: process.pid }); }
      catch (e) { try { baseLog('heartbeat_error', { file: opts.heartbeatFile, error: e.message }); } catch {} }
    }
  }
}

async function runCycle(opts, state) {
  const backlog = opts.backlog || defaultBacklog;
  const spawn = opts.spawn || defaultSpawn;
  const cfgImpl = opts.cfg || cfg;
  const coreImpl = opts.core || core;
  const logImpl = opts.log;
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
  const externalConfig = loadExternalConfigImpl();
  const parentBoardConfig = resolveParentBoardConfig(topology, externalConfig);
  // t016 — orchestrator hand-down: every registered child's board config
  // (null when unreachable), resolved from the same per-cycle reads.
  const childBoards = resolveChildBoardConfigs(topology, externalConfig);

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
  state.issuesScanned = issues.length;
  const inflight = coreImpl.computeInflight(issues, cfgImpl.AGENTS);
  const runtimeInflight = coreImpl.computeRuntimeInflight(inflight, cfgImpl.AGENTS);
  // Observability only (NOT capacity): the assigned-todo backlog. If this climbs while
  // inflight stays ~0, dispatch is happening but runs aren't starting (dead-zone) — the
  // signal that used to hide inside the old inflight number and deadlock the router.
  const assignedQueued = coreImpl.computeAssignedQueued(issues, cfgImpl.AGENTS);

  const todo = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO && !i.assignee_id && !coreImpl.isSmokeScratch(i.title));
  logImpl('scan', {
    total: issues.length,
    todoUnassigned: todo.length,
    inflight,
    runtimeInflight,
    assignedQueued,
  });

  const blockedRuntimes = new Set(opts.initialBlockedRuntimes || []);
  state.blockedRuntimes = blockedRuntimes;

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

  // DISPATCH-scoped (feeds review-dispatch further down) — see the blocked->todo pass above.
  const inReview = issues.filter((i) => (i.status || '').toLowerCase() === ISSUE_STATUS.IN_REVIEW && cfgImpl.PROJECT_IDS.includes(i.project_id));

  // ---- state-machine: in_review -> done on a verified merged PR ----
  // Each in_review issue is checked for a real merged PR via getIssuePullRequests.
  // detectVerifiedDone requires a real merge (state=merged or merged_at set) — never
  // fires on an open/closed PR, never fires on smoke/scratch issues or human-owned stories.
  const verifiedThisCycle = new Set();
  {
    const prsByIssue = {};
    for (const i of inReview) {
      try { prsByIssue[i.identifier] = backlog.getIssuePullRequests(i.identifier); }
      catch (e) { prsByIssue[i.identifier] = []; logImpl('prs_fetch_error', { identifier: i.identifier, error: e.message }); }
    }
    const verifiedDone = coreImpl.detectVerifiedDone(inReview, prsByIssue, cfgImpl, issues);
    for (const vd of verifiedDone) {
      logImpl('advance', { identifier: vd.identifier, to: ISSUE_STATUS.DONE, kind: 'verified-done', applied: !dryRun });
      if (!dryRun) {
        try { backlog.setIssueStatus(vd.identifier, ISSUE_STATUS.DONE); }
        catch (e) { logImpl('advance_error', { identifier: vd.identifier, to: ISSUE_STATUS.DONE, error: e.message }); }
        if (typeof spawn.reportRouteOutcome === 'function') {
          try { spawn.reportRouteOutcome(vd.identifier, 'success'); } catch (e) { logImpl('route_outcome_error', { identifier: vd.identifier, error: e.message }); }
        }
      }
    }
    for (const vd of verifiedDone) verifiedThisCycle.add(vd.identifier);
  }
  // Exclude just-advanced issues from the review-dispatch snapshot so a stale
  // run on a now-done ticket does not trigger a spurious rerun-review in this
  // same cycle (PANT-431; mirrors the `cascaded` exclusion in selectAssignments below).
  const inReviewForDispatch = verifiedThisCycle.size
    ? inReview.filter((i) => !verifiedThisCycle.has(i.identifier))
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
    const changeBacks = coreImpl.detectChangesRequested(changesRequested, cfgImpl, issues);
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
  // Shared state for commitDispatch(): every dispatch below reserves these
  // counters and propagates rate limits into blockedRuntimes the same way.
  const dc = {
    spawn, backlog, cfg: cfgImpl, core: coreImpl, log: logImpl, sleep: sleepImpl, now, issues,
    blockedRuntimes, inflight, loopRtProjected, priorAgentCycleAssigns, assigned: 0,
  };
  // Guard inputs for dispatchEligible(), read fresh at each call.
  const guardCtx = (extra = {}) => ({
    cfg: cfgImpl, allIssues: issues,
    assigned: dc.assigned, maxAssign, blockedRuntimes,
    agentCycleAssigns: priorAgentCycleAssigns, perCyclePerAgent: cfgImpl.CAPS.perCyclePerAgent ?? Infinity,
    ...extra,
  });
  const agentNameById = (id) => Object.entries(cfgImpl.AGENTS).find(([, a]) => a.id === id)?.[0];
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
      const issueObj = issues.find((i) => i.id === c.issueId) || { identifier: c.identifier };
      const pre = dispatchEligible(issueObj, 'cascade', guardCtx({ passCount: cascadeFired, passCap: cfgImpl.CAPS.perCycleCascade }));
      if (pre.stop) break;
      if (!pre.ok) { logImpl('cascade_skip', { identifier: c.identifier, reason: pre.reason }); continue; }
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
      logImpl('cascade_dispatch', { identifier: c.identifier, from: c.status, projectId: c.projectId, applied: !dryRun });
      if (dryRun) { cascadeFired++; cascaded.add(c.identifier); continue; }
      try {
        if (c.status === ISSUE_STATUS.BLOCKED) backlog.setIssueStatus(c.identifier, ISSUE_STATUS.TODO);
      } catch (e) { logImpl('cascade_error', { identifier: c.identifier, error: e.message }); continue; }
      // Ensure an assignee on the story's lane, then rerun to FORCE-ENQUEUE (rerun
      // re-enqueues the CURRENT assignment; assignee-mutation alone does not).
      // Unlike verifyAssignStarted (and spawn.dispatch()), cascade always
      // force-reruns, whether or not the assign already enqueued a run.
      const maxPerAgentCascade = cfgImpl.CAPS.perCyclePerAgent ?? Infinity;
      const agent = coreImpl.chooseAgentForProject(c.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: loopRtProjected, perAgentCycle: priorAgentCycleAssigns }, coreImpl.isHiveStory(issueObj), blockedRuntimes, maxPerAgentCascade);
      // Skip only when no agent has capacity AND the issue has no existing assignee.
      // If the issue already has an assignee, rerunIssue re-enqueues it without a
      // new assignment — no need to skip; the assigned-idle path's ~10 min lag is avoided.
      if (!agent && !issueObj.assignee_id) { logImpl('cascade_skip', { identifier: c.identifier, reason: 'no-capacity' }); continue; }
      // PANT-648: with no lane agent, the rerun goes to the existing assignee, and
      // that assignee's runtime is the one a rate limit blocks.
      const target = agent || agentNameById(issueObj.assignee_id);
      const targetRt = target && cfgImpl.AGENTS[target]?.runtime;
      const ok = dispatchEligible(issueObj, agent ? 'cascade' : 'cascade-rerun', guardCtx({ agent: target, runtime: targetRt }));
      if (!ok.ok) {
        logImpl('cascade_skip', { identifier: c.identifier, reason: ok.reason, agent: target, runtime: targetRt });
        continue;
      }
      if (agent) {
        const res = commitDispatch(dc, { identifier: c.identifier, agent, runtime: targetRt, pass: 'cascade', action: 'assign', issue: issueObj, countDispatch: false });
        if (!res.ok) { logImpl('cascade_error', { identifier: c.identifier, error: res.error.message }); continue; }
        await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
      }
      // Commit the cascade slot and exclusion BEFORE rerun (PANT-379): a rerun
      // failure must still count toward the per-cycle cap and keep
      // selectAssignments from re-dispatching this story. `assigned` counts
      // only the rerun, an actual dispatch (PANT-677).
      cascadeFired++;
      cascaded.add(c.identifier);
      const res = commitDispatch(dc, { identifier: c.identifier, agent: target, runtime: targetRt, pass: 'cascade', action: 'rerun', reserve: agent ? 'none' : 'slot' });
      if (!res.ok) { logImpl('cascade_error', { identifier: c.identifier, error: res.error.message }); continue; }
      logImpl('cascade_enqueued', { identifier: c.identifier, agent: agent || issueObj.assignee_id });
    }
  }

  // ---- BACK-HALF: review dispatch on in_review stories ----
  // Assignment to the review agent is the idempotency marker (see
  // selectReviewDispatch) so a story under review is not re-dispatched.
  const inReviewRuns = {};
  for (const i of inReview) inReviewRuns[i.identifier] = backlog.getIssueRuns(i.identifier);

  // inReview is already PROJECT_IDS-scoped at its own definition above (2026-09-13
  // fix — a firefly-events instance was confirmed live trying to dispatch review
  // for a real PANT-* dostal-tech ticket to its own review-lane agent, before
  // this and the whole board-wide-status-pass audit that followed it).
  const reviewInflight = coreImpl.computeReviewInflight(inReviewForDispatch, cfgImpl);
  const reviewMaxTotal = Math.min((cfgImpl.CAPS && cfgImpl.CAPS.perCycleReview) ?? 1, Math.max(0, maxAssign - dc.assigned));
  const reviewPicks = coreImpl.selectReviewDispatch(inReviewForDispatch, inReviewRuns, cfgImpl, reviewInflight, { now, maxTotal: reviewMaxTotal, blockedRuntimes, priorAgentCycleAssigns });
  const inReviewById = new Map(inReview.map((i) => [i.id, i]));
  for (const r of reviewPicks) {
    // SCALE-BY-TICKET: size the SQUAD for THIS ticket (which of product/technical/
    // qa/ux run, and whether QA drives a real browser via Playwright). Auriga stays
    // the THIN router — it computes the plan and fires ONE dispatch carrying it; the
    // auriga-review SQUAD agent reads the plan (logged here + posted onto the ticket)
    // and runs each enabled perspective, truly verifying. See core.reviewSquadPlan +
    // agents/auriga-review.instructions.md.
    const issueObj = inReviewById.get(r.issueId) || { identifier: r.identifier };
    const pre = dispatchEligible(issueObj, 'review', guardCtx());
    if (pre.stop) break;
    if (!pre.ok) { logImpl('review_skip', { identifier: r.identifier, agent: r.agent, reason: pre.reason }); continue; }
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
      parkForHuman(dc, r.identifier, {
        blockedReason: 'review-give-up-max-attempts', comment: reviewGiveUpComment(cfgImpl), errorEvent: 'review_give_up_error',
      });
      continue;
    }

    const reviewPass = r.action === 'dispatch-review' ? 'review' : 'review-rerun';
    const reviewRt = r.agent && cfgImpl.AGENTS[r.agent]?.runtime;
    const ok = dispatchEligible(issueObj, reviewPass, guardCtx({ agent: r.agent, runtime: reviewRt }));
    if (!ok.ok) {
      logImpl('review_skip', { identifier: r.identifier, agent: r.agent, reason: ok.reason, runtime: reviewRt });
      continue;
    }

    try {
      if (r.action === 'dispatch-review') {
        postSquadPlan(dc, r.identifier, plan);
        // Reassign the in_review story to the review agent, then verify a run
        // started (Multica enqueues a run on assignment); force-rerun only if
        // the assignment did not auto-enqueue one (dead-zone fallback).
        // NOT routed through spawn.dispatch() (different contract — see spawn-adapter.mjs).
        const res = commitDispatch(dc, { identifier: r.identifier, agent: r.agent, runtime: reviewRt, pass: 'review', action: 'assign', issue: issueObj });
        if (!res.ok) { logImpl('review_error', { identifier: r.identifier, agent: r.agent, error: res.error.message }); continue; }
        await verifyAssignStarted(dc, {
          identifier: r.identifier, agent: r.agent, runtime: reviewRt, pass: 'review',
          noRunEvent: 'review_verify_no_run', okEvent: 'review_assign_enqueued',
        });
      } else {
        // rerun-review: no assign happened, always force-enqueue.
        const res = commitDispatch(dc, { identifier: r.identifier, agent: r.agent, runtime: reviewRt, pass: 'review', action: 'rerun' });
        if (!res.ok) { logImpl('review_error', { identifier: r.identifier, agent: r.agent, error: res.error.message }); continue; }
      }
      logImpl('review_dispatched', { identifier: r.identifier, agent: r.agent, squad: plan.tier });
      // PANT-262: post-dispatch run check, to catch the zero-output startup hang
      // THIS cycle (review_verify_no_run) rather than 30 minutes later when
      // idle_watchdog fires. For dispatch-review it's the second wait.
      await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
      const run = runState(dc, r.identifier);
      if (!run.started) logImpl('review_verify_no_run', { identifier: r.identifier, agent: r.agent, action: r.action });
      else logImpl('review_verify_ok', { identifier: r.identifier, agent: r.agent, action: r.action, runStatus: run.status });
    } catch (e) {
      // Only the board reads above can throw here; dispatch errors return from commitDispatch.
      logImpl('review_error', { identifier: r.identifier, agent: r.agent, error: e.message });
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
      const zIssue = issues.find((i) => i.identifier === z.identifier) || { identifier: z.identifier };
      const pre = dispatchEligible(zIssue, z.action === 'rerun' ? 'zombie-rerun' : 'zombie-assign', guardCtx());
      if (pre.stop) break;
      if (!pre.ok) { logImpl('zombie_skip', { ...z, reason: pre.reason }); continue; }
      if (z.action === 'give-up') {
        // GH #75 / t001-zombie-give-up: attempt cap exhausted — stop re-actuating.
        // Never call spawn.assignIssue/rerunIssue on this path. Best-effort leave
        // a human-visible marker on the issue; a comment failure must never crash
        // the cycle (matches zombie_error/unblock_unassign_error convention).
        logImpl('zombie_give_up', { ...z, applied: !dryRun });
        if (!dryRun) {
          parkForHuman(dc, z.identifier, {
            blockedReason: 'zombie-give-up-max-attempts', comment: zombieGiveUpComment(cfgImpl), errorEvent: 'zombie_give_up_error',
          });
        }
        continue;
      }
      if (z.action === 'rerun') {
        const zombieAgentName = agentNameById(z.assigneeId);
        const zombieRt = zombieAgentName && cfgImpl.AGENTS[zombieAgentName]?.runtime;
        const ok = dispatchEligible(zIssue, 'zombie-rerun', guardCtx({ agent: zombieAgentName, runtime: zombieRt }));
        if (!ok.ok) { logImpl('zombie_skip', { ...z, reason: ok.reason, agent: zombieAgentName, runtime: zombieRt }); continue; }
        logImpl('zombie', { ...z, applied: !dryRun });
        if (!dryRun) {
          const res = commitDispatch(dc, { identifier: z.identifier, agent: zombieAgentName, runtime: zombieRt, pass: 'zombie-rerun', action: 'rerun', reserve: 'held-slot' });
          if (!res.ok) logImpl('zombie_error', { identifier: z.identifier, error: res.error.message });
        }
      } else {
        // needs (re)routing — route via its lane
        const maxPerAgentZombie = cfgImpl.CAPS.perCyclePerAgent ?? Infinity;
        const agent = coreImpl.chooseAgentForProject(z.projectId, cfgImpl, inflight, runtimeInflight, { perAgent: {}, perRuntime: loopRtProjected, perAgentCycle: priorAgentCycleAssigns }, z.isHive, blockedRuntimes, maxPerAgentZombie);
        if (!agent) { logImpl('zombie_skip', { ...z, reason: 'no-lane-capacity' }); continue; }
        const zAgentRt = cfgImpl.AGENTS[agent]?.runtime;
        const ok = dispatchEligible(zIssue, 'zombie-assign', guardCtx({ agent, runtime: zAgentRt }));
        if (!ok.ok) { logImpl('zombie_skip', { ...z, reason: ok.reason, agent, runtime: zAgentRt }); continue; }
        logImpl('zombie', { ...z, agent, applied: !dryRun });
        if (!dryRun) {
          const res = commitDispatch(dc, { identifier: z.identifier, agent, runtime: zAgentRt, pass: 'zombie-assign', action: 'assign', issue: zIssue, countDispatch: false });
          if (!res.ok) { logImpl('zombie_error', { identifier: z.identifier, error: res.error.message }); continue; }
          await sleepImpl(cfgImpl.CAPS.verifyDelayMs);
          const rerun = commitDispatch(dc, { identifier: z.identifier, agent, runtime: zAgentRt, pass: 'zombie-assign', action: 'rerun', reserve: 'none' });
          if (!rerun.ok) logImpl('zombie_error', { identifier: z.identifier, error: rerun.error.message });
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

    unassignArchivedAgents(dc, agentIds, dryRun);

    const todoAssigned = issues.filter(
      (i) => (i.status || '').toLowerCase() === ISSUE_STATUS.TODO &&
        i.assignee_id && agentIds.has(i.assignee_id) &&
        cfgImpl.PROJECT_IDS.includes(i.project_id)
    );
    const todoRunsByIssue = {};
    for (const i of todoAssigned) todoRunsByIssue[i.identifier] = backlog.getIssueRuns(i.identifier);
    const idleActions = coreImpl.detectAssignedIdle(todoAssigned, todoRunsByIssue, cfgImpl, agentIds, now, issues);
    // PANT-736: unassign actions (review-lane agent on todo) bypass the capacity gate —
    // they don't dispatch a run so must not consume a slot or count against inflight.
    const idleUnassigns = idleActions.filter((a) => a.action === 'unassign');
    const idleStartActions = idleActions.filter((a) => a.action !== 'unassign');
    for (const a of idleUnassigns) {
      logImpl('assigned_idle_unassign', { identifier: a.identifier, reason: a.reason, applied: !dryRun });
      if (!dryRun) {
        try { spawn.unassignIssue(a.identifier); } catch (e) { logImpl('assigned_idle_error', { identifier: a.identifier, error: e.message }); }
      }
    }
    // runtimeInflight is the cycle-start snapshot and does NOT include cascade/zombie
    // additions made this cycle (commitDispatch updates inflight directly). Omitting it here
    // causes limitAssignedIdleRecoveries to recompute from the updated inflight, giving
    // the per-runtime cap the correct view. Same fix as PANT-331 bug 2 for the cascade
    // and zombie passes; see capacity.mjs:computeRuntimeInflight.
    const { selected: idleSelected } = coreImpl.limitAssignedIdleRecoveries(idleStartActions, cfgImpl, {
      inflight,
      blockedRuntimes,
      priorAgentCycleAssigns,
      maxTotal: Math.min(
        cfgImpl.CAPS.assignedIdlePerCycle ?? cfgImpl.CAPS.perCycleTotal,
        Math.max(0, maxAssign - dc.assigned)
      ),
    });
    const todoAssignedById = new Map(todoAssigned.map((i) => [i.id, i]));
    for (const a of idleSelected) {
      // PANT-814: idleSelected was chosen before this loop ran, so a 429 on an
      // earlier recovery must still stop later ones on the same runtime.
      const aIssue = todoAssignedById.get(a.issueId) || { identifier: a.identifier };
      const ok = dispatchEligible(aIssue, 'assigned-idle', guardCtx({ agent: a.agent, runtime: a.runtime }));
      if (ok.stop) break;
      if (!ok.ok) {
        logImpl('assigned_idle_skip', { identifier: a.identifier, agent: a.agent, reason: ok.reason, runtime: a.runtime });
        continue;
      }
      logImpl('assigned_idle', { identifier: a.identifier, agent: a.agent, idleAgeMs: a.idleAgeMs, reason: a.reason, applied: !dryRun });
      if (!dryRun) {
        const res = commitDispatch(dc, { identifier: a.identifier, agent: a.agent, runtime: a.runtime, pass: 'assigned-idle', action: 'rerun' });
        if (!res.ok) logImpl('assigned_idle_error', { identifier: a.identifier, error: res.error.message });
      }
    }
  }

  // ---- route new todos ----
  const remaining = Math.max(0, maxAssign - dc.assigned);
  const picks = coreImpl.selectAssignments(issues, cfgImpl, inflight, {
    blockedRuntimes,
    exclude: cascaded,
    maxTotal: Math.min(cfgImpl.CAPS.perCycleTotal, remaining),
    parentBoardConfig,
    childBoards,
    priorAgentCycleAssigns,
  });

  // PANT-772: seeds on a tenant with no planning agent. Heuristic-only seeds
  // were already routed to the build lane (they appear in picks); explicitly
  // labeled ones are held. Log both every cycle so neither is ever silent.
  for (const s of picks.seedNoPlanning || []) {
    logImpl('seed_no_planning_agent', { identifier: s.identifier, planningAgent: coreImpl.PLANNING_AGENT, fallback: s.fallback ? 'build_lane' : 'held' });
  }

  for (const p of picks) {
    const pickIssueObj = issues.find((i) => i.identifier === p.identifier) || { identifier: p.identifier };
    const ok = dispatchEligible(pickIssueObj, 'build', guardCtx({ agent: p.agent, runtime: p.runtime }));
    if (ok.stop) break;
    if (!ok.ok) {
      if (ok.reason === 'runtime-blocked') logImpl('skip_blocked_runtime', { identifier: p.identifier, agent: p.agent, runtime: p.runtime });
      else logImpl('route_skip', { identifier: p.identifier, agent: p.agent, runtime: p.runtime, reason: ok.reason });
      continue;
    }
    logImpl('route', { identifier: p.identifier, agent: p.agent, lane: p.lane, runtime: p.runtime, applied: !dryRun });
    if (dryRun) continue;
    // The assignment fingerprint commitDispatch writes makes
    // isRouterManagedAssignment() true for this issue next cycle, so re-routing
    // is idempotent (PAN-8245).
    const res = commitDispatch(dc, { identifier: p.identifier, agent: p.agent, runtime: p.runtime, pass: 'build', action: 'assign', issue: pickIssueObj });
    if (!res.ok) {
      logImpl('assign_error', { identifier: p.identifier, agent: p.agent, error: res.error.message || '' });
      continue;
    }
    await verifyAssignStarted(dc, {
      identifier: p.identifier, agent: p.agent, runtime: p.runtime ?? cfgImpl.AGENTS[p.agent]?.runtime, pass: 'build',
      noRunEvent: 'verify_no_run', okEvent: 'verify_ok',
    });
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
    handOffToBoard(h.identifier, {
      board: parentBoardConfig, event: 'hand_up', metadataKey: 'handed_up_from',
      comment: (created) => `Handed up — created ${created && created.identifier} on the parent board.`,
    }, { issues, backlog, spawn, logImpl, createRemoteBacklog });
  }

  // ---- route hand-downs (t016 — orchestrator hand-down) ----
  // Explicit project -> child-board routes (projects.json `route`). Same
  // cross-board createIssue primitive and cancel-first idempotency guard as
  // hand-up. A route naming an unknown/unreachable child is held for a human
  // (never dispatched to an agent) and logged loudly every cycle until fixed.
  for (const r of picks.handDownRejected || []) {
    logImpl('hand_down_rejected', {
      identifier: r.identifier, childId: r.childId, reason: r.reason,
      warning: `project routes to child '${r.childId}' which is ${r.reason === 'unknown-child' ? 'not registered in orchestrator-topology.json' : 'missing baseUrl/projectId reachability config'} — held for a human, not dispatched`,
    });
  }
  for (const d of picks.handDowns || []) {
    logImpl('hand_down', {
      identifier: d.identifier, childId: d.childId,
      targetProjectId: d.board.projectId,
      applied: !dryRun,
    });
    if (dryRun) continue;
    handOffToBoard(d.identifier, {
      board: d.board, event: 'hand_down', metadataKey: 'handed_down_from',
      comment: (created) => `Handed down — created ${created && created.identifier} on child board '${d.childId}'.`,
    }, { issues, backlog, spawn, logImpl, createRemoteBacklog });
  }

  return { todo: todo.length, picked: picks.length, assigned: dc.assigned };
}

// Cross-board hand-off shared by hand-up (t015) and hand-down (t016): create
// the issue on another board, then close/comment/unassign it locally.
//
// Cancel locally BEFORE the remote create. Once CANCELLED the issue is out of
// the todo candidate pool, so a later cycle cannot create a second remote
// issue even if the post-create local mutations fail (the original
// duplicate-on-retry bug, PANT-397). If the cancel itself fails we skip the
// remote create entirely and let the next cycle retry.
function handOffToBoard(identifier, { board, event, metadataKey, comment }, { issues, backlog, spawn, logImpl, createRemoteBacklog }) {
  const issue = issues.find((i) => i.identifier === identifier);
  try {
    backlog.setIssueStatus(identifier, ISSUE_STATUS.CANCELLED);
  } catch (e) {
    logImpl(`${event}_pre_cancel_error`, { identifier, error: e.message });
    return;
  }

  let createdIssue;
  try {
    const remoteBacklog = createRemoteBacklog({ baseUrl: board.baseUrl, project: board.projectId });
    createdIssue = remoteBacklog.createIssue({
      title: issue ? issue.title : identifier,
      description: issue ? issue.description : undefined,
      metadata: { [metadataKey]: identifier },
    });
  } catch (e) {
    // Remote create failed — undo the pre-cancel so the issue re-enters
    // the candidate pool next cycle rather than being stranded as cancelled.
    logImpl(`${event}_error`, { identifier, error: e.message });
    try { backlog.setIssueStatus(identifier, ISSUE_STATUS.TODO); } catch { /* next cycle retries */ }
    return;
  }

  logImpl(`${event}_ok`, { identifier, newIdentifier: createdIssue && createdIssue.identifier });
  try {
    backlog.commentOnIssue(identifier, comment(createdIssue));
  } catch (e) { logImpl(`${event}_comment_error`, { identifier, error: e.message }); }
  try {
    spawn.unassignIssue(identifier);
  } catch (e) { logImpl(`${event}_unassign_error`, { identifier, error: e.message }); }
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
      const result = await cycle({ maxAssign: remaining, heartbeatFile: HEARTBEAT_FILE });
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
  // PANT-388: per-tenant adapters live across cycles -- see getTenantAdapters().
  const tenantAdapters = new Map();
  do {
    let tenants = [];
    try {
      tenants = await loadTenantConfigs({ pantheonApiBaseUrl: PANTHEON_API_URL, baseCfg: cfg, allowlist: MULTI_TENANT_ALLOWLIST });
    } catch (e) {
      log('tenant_configs_error', { error: e.message });
    }
    if (!tenants.length) {
      log('no_tenants_found', {});
      // No cycle() ran, but the loop itself is alive: keep the heartbeat fresh
      // so the healthcheck reports liveness, not tenant availability.
      try { writeHeartbeat(HEARTBEAT_FILE, { ts: new Date().toISOString(), pid: process.pid, tenants: 0 }); }
      catch (e) { log('heartbeat_error', { file: HEARTBEAT_FILE, error: e.message }); }
    } else {
      for (const { tenantId, cfg: tenantCfg } of rotate(tenants, rotation)) {
        if (totalAssigned >= MAX_ASSIGN) break;
        const remaining = MAX_ASSIGN === Infinity ? Infinity : Math.max(0, MAX_ASSIGN - totalAssigned);
        try {
          const { backlog, spawn } = getTenantAdapters(tenantAdapters, tenantId, tenantCfg);
          const result = await cycle({ backlog, spawn, cfg: tenantCfg, log: tenantLog(tenantId), dryRun: DRY, maxAssign: remaining, heartbeatFile: HEARTBEAT_FILE });
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

export { buildAdaptersForTenant, getTenantAdapters, mainMultiTenant };
