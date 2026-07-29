// Auriga auto-router — PURE decision logic (no live calls).
// Everything here is deterministic and unit-tested with mocked inputs.

const ACTIVE_RUN_STATUSES = new Set([
  'running', 'in_progress', 'in progress', 'queued', 'pending', 'dispatched', 'started', 'assigned',
]);
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timeout']);
const ACTIVE_ISSUE_STATUSES = new Set(['in_progress', 'in progress', 'running']);

// Ignore smoke/scratch/verification tickets by title.
export function isSmokeScratch(title = '') {
  return /\b(smoke|scratch)\b/i.test(title) || /verification-swarm/i.test(title);
}

// Classify a single run object.
export function classifyRun(run, now = Date.now()) {
  const status = (run.status || '').toLowerCase();
  const failed = FAILED_RUN_STATUSES.has(status) || (run.error != null && run.error !== '');
  const hasCompleted = !!run.completed_at || status === 'completed' || status === 'done' || status === 'succeeded';
  const active = !failed && !hasCompleted && (ACTIVE_RUN_STATUSES.has(status) || (!run.completed_at && status === ''));
  const ts = run.completed_at || run.started_at || run.dispatched_at || run.created_at;
  const ageMs = ts ? now - new Date(ts).getTime() : Infinity;
  return { active, failed, done: hasCompleted && !failed, ageMs, status };
}

// Given an issue's runs (array), is any run currently active AND fresh?
// A run stuck in "running" longer than staleMs is treated as a silent hang
// (not active) so it can be recovered.
export function hasActiveRun(runs = [], now = Date.now(), staleMs = Infinity) {
  return runs.some((r) => {
    const c = classifyRun(r, now);
    return c.active && c.ageMs < staleMs;
  });
}

// Latest run by created_at/dispatched_at.
export function latestRun(runs = []) {
  if (!runs.length) return null;
  return [...runs].sort((a, b) => {
    const ta = new Date(a.created_at || a.dispatched_at || 0).getTime();
    const tb = new Date(b.created_at || b.dispatched_at || 0).getTime();
    return tb - ta;
  })[0];
}

// In-flight count per agent id. An issue is "in flight" for an agent ONLY when it
// is assigned to that agent AND actively running (in_progress / running).
//
// FIX 2026-07-28 (audit P0 "master switch"): previously this also counted assigned
// `todo`s as in-flight ("|| st === 'todo'"). That deadlocked the whole router:
// because assignee-mutation does not reliably enqueue a run (the dispatch dead-zone),
// assigned-todos accumulate on the board forever and never transition to running.
// Their phantom count then exceeds every RUNTIME_CAP (e.g. codex 12 > 4, claude 5 > 4)
// while real in_progress is 0 — so selectAssignments finds no agent with capacity and
// the router dispatches NOTHING, for hours, silently. Counting only truly-running
// issues makes real inflight ~0, freeing every lane. The per-cycle batch caps
// (CAPS.perCycleTotal / perCyclePerAgent) prevent over-assignment during the brief
// assign->run gap, and each assign is immediately re-run (enqueued) by the cycle loop.
export function computeInflight(issues, agents) {
  const idToName = {};
  for (const [name, a] of Object.entries(agents)) idToName[a.id] = name;
  const counts = {};
  for (const name of Object.keys(agents)) counts[name] = 0;
  for (const i of issues) {
    if (!i.assignee_id) continue;
    const name = idToName[i.assignee_id];
    if (!name) continue;
    const st = (i.status || '').toLowerCase();
    if (ACTIVE_ISSUE_STATUSES.has(st)) counts[name] += 1;
  }
  return counts;
}

// Count assigned-but-not-running issues per agent (the old "inflight" definition).
// Not used for capacity — kept for observability so the divergence between real
// in-flight and the assigned-todo backlog stays visible in the scan log.
export function computeAssignedQueued(issues, agents) {
  const idToName = {};
  for (const [name, a] of Object.entries(agents)) idToName[a.id] = name;
  const counts = {};
  for (const name of Object.keys(agents)) counts[name] = 0;
  for (const i of issues) {
    if (!i.assignee_id) continue;
    const name = idToName[i.assignee_id];
    if (!name) continue;
    const st = (i.status || '').toLowerCase();
    if (st === 'todo') counts[name] += 1;
  }
  return counts;
}

// Runtime in-flight totals derived from per-agent counts.
export function computeRuntimeInflight(inflight, agents) {
  const rt = {};
  for (const [name, count] of Object.entries(inflight)) {
    const r = agents[name]?.runtime;
    if (!r) continue;
    rt[r] = (rt[r] || 0) + count;
  }
  return rt;
}

// Can this agent accept one more, given per-agent and per-runtime caps and
// already-projected assignments this cycle?
export function agentHasCapacity(name, agents, runtimeCap, inflight, runtimeInflight, projected) {
  const a = agents[name];
  if (!a) return false;
  const agentNow = (inflight[name] || 0) + (projected.perAgent[name] || 0);
  if (agentNow >= a.maxInflight) return false;
  const rtNow = (runtimeInflight[a.runtime] || 0) + (projected.perRuntime[a.runtime] || 0);
  if (rtNow >= (runtimeCap[a.runtime] ?? Infinity)) return false;
  return true;
}

// Choose the best lane agent for a project: honor PROJECT_LANE order, else
// DEFAULT_LANE, picking the candidate with the lowest current+projected load
// that still has capacity.
export function chooseAgentForProject(projectId, cfg, inflight, runtimeInflight, projected) {
  const lane = cfg.PROJECT_LANE[projectId] || cfg.DEFAULT_LANE;
  const eligible = lane.filter((name) =>
    agentHasCapacity(name, cfg.AGENTS, cfg.RUNTIME_CAP, inflight, runtimeInflight, projected)
  );
  if (!eligible.length) return null;
  // Prefer lane order but break by lowest projected load.
  eligible.sort((x, y) => {
    const lx = (inflight[x] || 0) + (projected.perAgent[x] || 0);
    const ly = (inflight[y] || 0) + (projected.perAgent[y] || 0);
    if (lx !== ly) return lx - ly;
    return lane.indexOf(x) - lane.indexOf(y);
  });
  return eligible[0];
}

// Select this cycle's assignments from the board.
// Returns [{ identifier, issueId, projectId, agent, lane, runtime }].
// Respects per-agent inflight caps, per-runtime caps, and small per-cycle batch caps.
// blockedRuntimes: Set of runtime names to skip this cycle (rate-limited lanes).
export function selectAssignments(issues, cfg, inflight, opts = {}) {
  const blockedRuntimes = opts.blockedRuntimes || new Set();
  const maxTotal = opts.maxTotal ?? cfg.CAPS.perCycleTotal;
  const maxPerAgent = opts.maxPerAgent ?? cfg.CAPS.perCyclePerAgent;

  const runtimeInflight = computeRuntimeInflight(inflight, cfg.AGENTS);
  const projected = { perAgent: {}, perRuntime: {}, perAgentCycle: {} };

  // Candidate pool: unassigned, status todo, not smoke/scratch, project in scan set.
  const candidates = issues
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
    .filter((i) => !i.assignee_id)
    .filter((i) => !isSmokeScratch(i.title))
    .filter((i) => cfg.PROJECT_IDS.includes(i.project_id));

  // Stable ordering: by project scan order, then by issue number ascending
  // (older/foundational tickets first).
  candidates.sort((a, b) => {
    const pa = cfg.PROJECT_IDS.indexOf(a.project_id);
    const pb = cfg.PROJECT_IDS.indexOf(b.project_id);
    if (pa !== pb) return pa - pb;
    return (a.number || 0) - (b.number || 0);
  });

  const chosen = [];
  for (const issue of candidates) {
    if (chosen.length >= maxTotal) break;
    const agent = chooseAgentForProject(issue.project_id, cfg, inflight, runtimeInflight, projected);
    if (!agent) continue;
    const runtime = cfg.AGENTS[agent].runtime;
    if (blockedRuntimes.has(runtime)) continue;
    if ((projected.perAgentCycle[agent] || 0) >= maxPerAgent) continue;

    // commit projection
    projected.perAgent[agent] = (projected.perAgent[agent] || 0) + 1;
    projected.perRuntime[runtime] = (projected.perRuntime[runtime] || 0) + 1;
    projected.perAgentCycle[agent] = (projected.perAgentCycle[agent] || 0) + 1;

    chosen.push({
      identifier: issue.identifier,
      issueId: issue.id,
      projectId: issue.project_id,
      lane: cfg.PROJECT_NAMES[issue.project_id] || issue.project_id,
      agent,
      runtime,
    });
  }
  return chosen;
}

// Pure-code state-machine: advance in_progress issues whose latest run
// completed successfully to in_review. No agent call — a done, non-failed run
// (see classifyRun) is the only signal. Only considers issues currently
// in_progress, so a re-scan after the transition naturally stops re-firing
// (the issue is no longer in the input set) — idempotent by construction.
export function detectRunCompletions(inProgressIssues, runsByIssue, now = Date.now()) {
  const actions = [];
  for (const i of inProgressIssues) {
    if (isSmokeScratch(i.title)) continue;
    const lr = latestRun(runsByIssue[i.identifier] || []);
    if (!lr) continue;
    if (classifyRun(lr, now).done) {
      actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'advance-in-review' });
    }
  }
  return actions;
}

// Pure-code state-machine: advance in_review issues to done once verify_ok is
// real — a linked PR has actually merged (state 'merged' or a non-null
// merged_at), not merely runStatus reporting success. This is the
// false-confidence guard: runStatus is never treated as "done" on its own.
// prsByIssue: { [identifier]: pullRequest[] } from `multica issue pull-requests`.
export function detectVerifiedDone(inReviewIssues, prsByIssue) {
  const actions = [];
  for (const i of inReviewIssues) {
    if (isSmokeScratch(i.title)) continue;
    const prs = prsByIssue[i.identifier] || [];
    const merged = prs.some((pr) => pr.state === 'merged' || pr.merged_at != null);
    if (merged) {
      actions.push({ identifier: i.identifier, issueId: i.id, projectId: i.project_id, action: 'advance-done' });
    }
  }
  return actions;
}

// Detect zombies among in_progress issues.
// runsByIssue: { [identifier]: runs[] }. Returns recovery actions.
// action 'rerun' when the issue already has an assignee; 'assign' when it needs (re)routing.
export function detectZombies(inProgressIssues, runsByIssue, cfg, now = Date.now()) {
  const actions = [];
  for (const i of inProgressIssues) {
    if (isSmokeScratch(i.title)) continue;
    const runs = runsByIssue[i.identifier] || [];
    if (hasActiveRun(runs, now, cfg.CAPS.zombieStaleMs)) continue; // healthy & fresh
    const lr = latestRun(runs);
    const stale = !lr || classifyRun(lr, now).failed || classifyRun(lr, now).ageMs > cfg.CAPS.zombieStaleMs;
    if (!stale) continue;
    actions.push({
      identifier: i.identifier,
      issueId: i.id,
      projectId: i.project_id,
      lane: cfg.PROJECT_NAMES[i.project_id] || i.project_id,
      hasAssignee: !!i.assignee_id,
      action: i.assignee_id ? 'rerun' : 'assign',
      reason: !lr ? 'no-runs' : (classifyRun(lr, now).failed ? 'last-run-failed' : 'run-stale'),
    });
  }
  return actions;
}
