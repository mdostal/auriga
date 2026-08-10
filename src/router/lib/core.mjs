// Auriga auto-router — PURE decision logic (no live calls).
// Everything here is deterministic and unit-tested with mocked inputs.

import { getEligibleAgentsByTreePath } from './tree-aware.mjs';
import {
  assignmentFingerprint,
  assignmentFingerprintMatches,
  isRouterManagedAssignment,
} from './fingerprint.mjs';

const ACTIVE_RUN_STATUSES = new Set([
  'running', 'in_progress', 'in progress', 'queued', 'pending', 'dispatched', 'started', 'assigned',
]);
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timeout']);
const ACTIVE_ISSUE_STATUSES = new Set(['in_progress', 'in progress', 'running']);

// Ignore smoke/scratch/verification tickets by title.
export function isSmokeScratch(title = '') {
  return /\b(smoke|scratch)\b/i.test(title) || /verification-swarm/i.test(title);
}

const HUMAN_TODO_LABEL = 'human-todo';

// Priority-1 filter: true when an issue must never enter the agent dispatch
// pool — labeled `human-todo`, or `waiting_on` a known human (cfg.HUMAN_NAMES)
// — because only a human can complete it. Excluded issues belong in the
// separate human queue instead (see scripts/export-human-queue.mjs).
export function isHumanTodo(issue, cfg) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '').toLowerCase());
  if (labels.includes(HUMAN_TODO_LABEL)) return true;
  const waitingOn = issue.metadata && issue.metadata.waiting_on;
  if (typeof waitingOn !== 'string' || !waitingOn.trim()) return false;
  const humanNames = (cfg && cfg.HUMAN_NAMES) || [];
  const w = waitingOn.trim().toLowerCase();
  return humanNames.some((name) => w === name.toLowerCase() || w.includes(name.toLowerCase()));
}

// Why an issue was routed to the human queue — 'label' or 'waiting_on'.
// Callers should only call this once isHumanTodo(issue, cfg) is true.
export function humanTodoReason(issue) {
  const labels = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l?.name || '').toLowerCase());
  return labels.includes(HUMAN_TODO_LABEL) ? 'label' : 'waiting_on';
}

function extractStoryKey(str = '') {
  const m = String(str).match(/^\s*\[?\s*([a-z]{1,8}-\d{1,3})(?![0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// Short epic-scoped key from a story title's leading "[key-...]" bracket.
export function storyKey(issue = {}) {
  return extractStoryKey(issue.title || '');
}

// Short epic-scoped key from a dependency slug.
export function slugKey(slug = '') {
  return extractStoryKey(slug);
}

const HIVE_PHASE_TOKENS = new Set([
  'research', 'implement', 'implementation', 'test', 'test-spec', 'tests',
  'review', 'plan', 'design', 'integrate', 'integration', 'spec', 'build',
]);

export function descStoryDeps(issue = {}) {
  const desc = issue.description || '';
  const m = desc.match(/(^|\n)[ \t]*depends_on:[ \t]*(\[[^\]]*\]|\r?\n(?:[ \t]*-[ \t]*[^\n]+\r?\n?)+)/i);
  let raw = [];
  if (m) {
    const body = m[2];
    if (body.trimStart().startsWith('[')) {
      raw = body.trim().replace(/^\[|\]$/g, '').split(',');
    } else {
      raw = body.split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, ''));
    }
  }
  return raw
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .filter((s) => !HIVE_PHASE_TOKENS.has(s.toLowerCase()));
}

export function descStoryId(issue = {}) {
  const desc = issue.description || '';
  const m = desc.match(/(^|\n)\s*id:\s*([a-z0-9][a-z0-9_-]*)/i);
  if (m) return m[2].trim().toLowerCase();
  const title = issue.title || '';
  const titleMatch = title.match(/^\s*\[\s*([a-z0-9][a-z0-9_-]*)\s*\]/i);
  return titleMatch ? titleMatch[1].trim().toLowerCase() : null;
}

export function descDepsSatisfied(issue, allIssues = []) {
  const slugs = descStoryDeps(issue);
  if (!slugs.length) return true;
  const siblings = allIssues.filter((s) => (
    s.parent_issue_id &&
    s.parent_issue_id === issue.parent_issue_id &&
    s.id !== issue.id
  ));
  const terminal = (s) => s === 'done' || s === 'cancelled' || s === 'canceled';

  for (const slug of slugs) {
    const slugLower = slug.toLowerCase();
    let dep = siblings.find((s) => descStoryId(s) === slugLower);
    if (!dep) {
      const key = slugKey(slug);
      if (!key) return false;
      dep = siblings.find((s) => storyKey(s) === key);
      if (!dep) continue;
    }
    if (!terminal((dep.status || '').toLowerCase())) return false;
  }
  return true;
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
export function chooseAgentFromLane(lane, cfg, inflight, runtimeInflight, projected) {
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

export function chooseAgentForProject(projectId, cfg, inflight, runtimeInflight, projected) {
  const lane = cfg.PROJECT_LANE[projectId] || cfg.DEFAULT_LANE;
  return chooseAgentFromLane(lane, cfg, inflight, runtimeInflight, projected);
}

export function chooseAgentForIssue(issue, cfg, inflight, runtimeInflight, projected) {
  const treeLane = getEligibleAgentsByTreePath(issue, cfg);
  const treeAgent = treeLane.length
    ? chooseAgentFromLane(treeLane, cfg, inflight, runtimeInflight, projected)
    : null;
  return treeAgent || chooseAgentForProject(issue.project_id, cfg, inflight, runtimeInflight, projected);
}

function agentNameForAssignee(assigneeId, agents) {
  if (!assigneeId) return null;
  const found = Object.entries(agents).find(([, agent]) => agent.id === assigneeId);
  return found ? found[0] : null;
}

export function assignmentDecision(issue, targetAgent, cfg, opts = {}) {
  if (!issue.assignee_id) {
    return { action: 'assign', reason: 'unassigned' };
  }

  const currentAgent = agentNameForAssignee(issue.assignee_id, cfg.AGENTS);
  if (currentAgent === targetAgent) {
    return { action: 'noop', reason: 'already-assigned-target', currentAgent };
  }

  if (!isRouterManagedAssignment(issue)) {
    return { action: 'noop', reason: 'manual-assignment', currentAgent };
  }

  if (currentAgent && assignmentFingerprintMatches(issue, currentAgent, cfg, opts)) {
    return { action: 'noop', reason: 'unchanged-router-assignment', currentAgent };
  }

  return { action: 'assign', reason: 'changed-router-assignment', currentAgent };
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

  // Candidate pool: unassigned or router-managed assigned, status todo, not smoke/scratch, project in scan set,
  // and NOT a human-todo (priority-1 rule — see isHumanTodo; routed to the human
  // queue instead via scripts/export-human-queue.mjs).
  const candidates = issues
    .filter((i) => (i.status || '').toLowerCase() === 'todo')
    .filter((i) => !i.assignee_id || isRouterManagedAssignment(i))
    .filter((i) => !isSmokeScratch(i.title))
    .filter((i) => cfg.PROJECT_IDS.includes(i.project_id))
    .filter((i) => !isHumanTodo(i, cfg));

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
    const agent = chooseAgentForIssue(issue, cfg, inflight, runtimeInflight, projected);
    if (!agent) continue;
    const runtime = cfg.AGENTS[agent].runtime;
    if (blockedRuntimes.has(runtime)) continue;
    const decision = assignmentDecision(issue, agent, cfg, opts);
    if (decision.action === 'noop') continue;
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
      assignmentFingerprint: assignmentFingerprint(issue, agent, cfg, opts),
      assignmentReason: decision.reason,
    });
  }
  return chosen;
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
      assigneeId: i.assignee_id || null,
      hasAssignee: !!i.assignee_id,
      action: i.assignee_id ? 'rerun' : 'assign',
      reason: !lr ? 'no-runs' : (classifyRun(lr, now).failed ? 'last-run-failed' : 'run-stale'),
    });
  }
  return actions;
}

export function hasOpenPullRequest(prs = []) {
  return prs.some((pr) => pr.state === 'open');
}

export function hasMergedPullRequest(prs = []) {
  return prs.some((pr) => pr.state === 'merged' || pr.merged_at != null);
}

export function detectVerifiedDone(inReviewIssues, prsByIssue) {
  const actions = [];
  for (const i of inReviewIssues) {
    if (isSmokeScratch(i.title)) continue;
    if (hasMergedPullRequest(prsByIssue[i.identifier] || [])) {
      actions.push({
        identifier: i.identifier,
        issueId: i.id,
        parentIssueId: i.parent_issue_id || null,
        projectId: i.project_id,
        title: i.title,
        action: 'advance-done',
        reason: 'pr-merged',
      });
    }
  }
  return actions;
}

export function computeReviewInflight(inReviewIssues, cfg) {
  const squad = cfg.VERIFY_SQUAD;
  if (!squad) return 0;
  return inReviewIssues.filter((i) =>
    (i.assignee_type === 'squad' && i.assignee_id === squad.id) ||
    i.assignee_id === squad.id ||
    i.assignee_id === squad.leaderAgentId
  ).length;
}

export function selectReviewDispatch(inReviewIssues, runsByIssue, prsByIssue, cfg, opts = {}) {
  const squad = cfg.VERIFY_SQUAD;
  if (!squad) return [];

  const now = opts.now ?? Date.now();
  const staleMs = (cfg.CAPS && cfg.CAPS.zombieStaleMs) ?? Infinity;
  const maxTotal = opts.maxTotal ?? (cfg.CAPS && cfg.CAPS.perCycleReview) ?? 1;
  const currentInflight = opts.reviewInflight ?? computeReviewInflight(inReviewIssues, cfg);
  let projected = 0;
  const actions = [];

  for (const i of inReviewIssues) {
    if (actions.length >= maxTotal) break;
    if (isSmokeScratch(i.title)) continue;

    const prs = prsByIssue[i.identifier] || [];
    if (!hasOpenPullRequest(prs)) continue;

    const assignedToVerify =
      (i.assignee_type === 'squad' && i.assignee_id === squad.id) ||
      i.assignee_id === squad.id ||
      i.assignee_id === squad.leaderAgentId;

    const runs = runsByIssue[i.identifier] || [];
    if (assignedToVerify) {
      if (hasActiveRun(runs, now, staleMs)) continue;
      const lr = latestRun(runs);
      const stale = !lr || classifyRun(lr, now).failed || classifyRun(lr, now).ageMs > staleMs;
      if (!stale) continue;
      actions.push({
        identifier: i.identifier,
        issueId: i.id,
        projectId: i.project_id,
        squad: squad.name,
        action: 'rerun-review',
        reason: 'review-stale',
      });
      continue;
    }

    if (currentInflight + projected >= squad.maxInflight) continue;
    projected += 1;
    actions.push({
      identifier: i.identifier,
      issueId: i.id,
      projectId: i.project_id,
      squad: squad.name,
      action: 'dispatch-review',
      reason: 'open-pr',
    });
  }

  return actions;
}

// ---- PAN-7492 self-heal: recover assigned-but-idle stories (added to dev) ----

export function agentIdSet(agents = {}) {
  return new Set(Object.values(agents).map((a) => a && a.id).filter(Boolean));
}

// Detect assigned `todo` issues that should have dispatched already but are
// still idle. These do not count as capacity, so recovery is a separate bounded
// pass instead of part of route selection.
export function detectAssignedIdle(todoIssues, runsByIssue, cfg, knownAgentIds = agentIdSet(cfg.AGENTS), now = Date.now()) {
  const staleMs = cfg.CAPS.assignedIdleStaleMs ?? cfg.CAPS.zombieStaleMs;
  const actions = [];
  for (const i of todoIssues) {
    if ((i.status || '').toLowerCase() !== 'todo') continue;
    if (!i.assignee_id || !knownAgentIds.has(i.assignee_id)) continue;
    if (isSmokeScratch(i.title)) continue;
    if (isHumanTodo(i, cfg)) continue;

    const touchedAt = i.updated_at || i.created_at;
    const idleAgeMs = touchedAt ? now - new Date(touchedAt).getTime() : Infinity;
    if (idleAgeMs < staleMs) continue;

    const runs = runsByIssue[i.identifier] || [];
    if (hasActiveRun(runs, now, staleMs)) continue;
    const lr = latestRun(runs);
    const classified = lr ? classifyRun(lr, now) : null;
    actions.push({
      identifier: i.identifier,
      issueId: i.id,
      assigneeId: i.assignee_id,
      projectId: i.project_id,
      lane: cfg.PROJECT_NAMES[i.project_id] || i.project_id,
      idleAgeMs,
      action: 'start',
      reason: !lr ? 'assigned-todo-no-runs' : (classified.failed ? 'assigned-todo-last-run-failed' : 'assigned-todo-stale'),
    });
  }
  return actions;
}

export function limitAssignedIdleRecoveries(actions, cfg, opts = {}) {
  const maxTotal = opts.maxTotal ?? cfg.CAPS.assignedIdlePerCycle ?? cfg.CAPS.perCycleTotal;
  const maxPerAgent = opts.maxPerAgent ?? cfg.CAPS.assignedIdlePerAgent ?? 1;
  const perAgent = {};
  const selected = [];
  for (const action of [...actions].sort((a, b) => b.idleAgeMs - a.idleAgeMs)) {
    if (selected.length >= maxTotal) break;
    if ((perAgent[action.assigneeId] || 0) >= maxPerAgent) continue;
    perAgent[action.assigneeId] = (perAgent[action.assigneeId] || 0) + 1;
    selected.push(action);
  }
  return selected;
}
