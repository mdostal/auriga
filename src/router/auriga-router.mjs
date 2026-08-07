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

  const issues = mca.listAllIssues(cfg.PROJECT_IDS);
  const allAgents = liveAgentMap();
  const allAgentIds = core.agentIdSet(allAgents);
  const agentNameById = Object.fromEntries(Object.entries(allAgents).map(([name, a]) => [a.id, name]));
  let workspaceTodoIssues = [];
  try {
    workspaceTodoIssues = mca.listAllWorkspaceIssues('todo');
  } catch (e) {
    log('assigned_idle_list_error', { error: e.message });
  }
  const reviewIssues = mca.listAllIssues(cfg.REVIEW_PROJECT_IDS || cfg.PROJECT_IDS);
  const inflight = core.computeInflight(issues, cfg.AGENTS);
  const runtimeInflight = core.computeRuntimeInflight(inflight, cfg.AGENTS);
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
  });

  // ---- assigned-todo self-heal (PAN-7492) ----
  const assignedTodoIssues = workspaceTodoIssues
    .filter((i) => i.assignee_id && allAgentIds.has(i.assignee_id))
    .filter((i) => !core.isSmokeScratch(i.title))
    .filter((i) => !core.isHumanTodo(i, cfg));
  const assignedRuns = {};
  for (const i of assignedTodoIssues) assignedRuns[i.identifier] = mca.issueRuns(i.identifier);
  const assignedIdle = core.limitAssignedIdleRecoveries(
    core.detectAssignedIdle(assignedTodoIssues, assignedRuns, cfg, allAgentIds, now),
    cfg,
    { maxTotal: Math.min(cfg.CAPS.assignedIdlePerCycle ?? cfg.CAPS.perCycleTotal, Math.max(0, MAX_ASSIGN - assignedThisProcess)) }
  );
  for (const a of assignedIdle) {
    if (assignedThisProcess >= MAX_ASSIGN) break;
    const agent = agentNameById[a.assigneeId] || a.assigneeId;
    log('assigned_idle', { ...a, agent, applied: !DRY });
    if (DRY) continue;
    try {
      mca.startIssue(a.identifier);
      assignedThisProcess++;
    } catch (e) {
      log('assigned_idle_start_error', { identifier: a.identifier, agent, error: e.message });
      continue;
    }
    await sleep(cfg.CAPS.verifyDelayMs);
    const runs = mca.issueRuns(a.identifier);
    const started = runs.length > 0 && runs.some((r) => {
      const c = core.classifyRun(r, Date.now());
      return c.active || c.done || c.failed;
    });
    if (!started) {
      log('assigned_idle_verify_no_run', { identifier: a.identifier, agent, action: 'rerun' });
      try { mca.rerunIssue(a.identifier); } catch (e) { log('assigned_idle_rerun_error', { identifier: a.identifier, error: e.message }); }
    } else {
      const lr = core.latestRun(runs);
      const c = lr ? core.classifyRun(lr, Date.now()) : {};
      log('assigned_idle_verify_ok', { identifier: a.identifier, agent, runStatus: c.status, runtimeId: lr && lr.runtime_id });
    }
  }

  // ---- BACK-HALF: in_review PR verification / ship dispatch ----
  // The verify-team-squad leader (auriga-review) reviews/tests the PR branch,
  // then merges to dev + marks done on pass, or comments and loops the story
  // back to in_progress on fail. The router only dispatches and self-heals.
  const inReview = reviewIssues.filter((i) => (i.status || '').toLowerCase() === 'in_review');
  const prsByIssue = {};
  const reviewRunsByIssue = {};
  for (const i of inReview) {
    prsByIssue[i.identifier] = mca.issuePullRequests(i.identifier);
    reviewRunsByIssue[i.identifier] = mca.issueRuns(i.identifier);
  }

  const verified = core.detectVerifiedDone(inReview, prsByIssue);
  for (const v of verified) {
    log('advance', { identifier: v.identifier, to: 'done', reason: v.reason, applied: !DRY });
    if (!DRY) {
      try { mca.issueStatus(v.identifier, 'done'); } catch (e) { log('advance_error', { identifier: v.identifier, to: 'done', error: e.message }); }
    }
  }

  const reviewInflight = core.computeReviewInflight(inReview, cfg);
  const reviewPicks = core.selectReviewDispatch(inReview, reviewRunsByIssue, prsByIssue, cfg, { now, reviewInflight });
  for (const r of reviewPicks) {
    log('review', { identifier: r.identifier, squad: r.squad, action: r.action, reason: r.reason, applied: !DRY });
    if (DRY) continue;
    try {
      if (r.action === 'dispatch-review') {
        mca.assignIssue(r.identifier, r.squad);
        await sleep(cfg.CAPS.verifyDelayMs);
      }
      mca.rerunIssue(r.identifier);
      log('review_dispatched', { identifier: r.identifier, squad: r.squad });
    } catch (e) {
      log('review_error', { identifier: r.identifier, squad: r.squad, error: e.message });
    }
  }

  // ---- zombie recovery ----
  if (!NO_ZOMBIE) {
    const inProgress = issues.filter((i) => ['in_progress', 'in progress', 'running'].includes((i.status || '').toLowerCase()));
    const runsByIssue = {};
    for (const i of inProgress) runsByIssue[i.identifier] = mca.issueRuns(i.identifier);
    const zombies = core.detectZombies(inProgress, runsByIssue, cfg, now);
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
        const agent = core.chooseAgentForProject(z.projectId, cfg, inflight, runtimeInflight, { perAgent: {}, perRuntime: {} });
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
