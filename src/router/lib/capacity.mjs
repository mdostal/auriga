// Agent/runtime capacity + in-flight accounting — extracted from core.mjs
// (t011 decomposition). Depends only on issue-status.mjs (a leaf module) —
// no dependency on any of core.mjs's own dispatch/decision logic.

import { ISSUE_STATUS, ISSUE_STATUS_ALT_SPELLINGS } from './issue-status.mjs';

const ACTIVE_ISSUE_STATUSES = new Set([
  ISSUE_STATUS.IN_PROGRESS, ISSUE_STATUS_ALT_SPELLINGS.IN_PROGRESS_SPACED, ISSUE_STATUS.RUNNING,
]);

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
    if (st === ISSUE_STATUS.TODO) counts[name] += 1;
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
// already-projected assignments this cycle? Returns false immediately when
// the agent's runtime is marked offline (available === false, PAN-8645).
export function agentHasCapacity(name, agents, runtimeCap, inflight, runtimeInflight, projected) {
  return agentCapacityReason(name, agents, runtimeCap, inflight, runtimeInflight, projected) === null;
}

// Why agentHasCapacity() is false for this agent, or null when it has capacity.
// The decision record (PANT-816) logs this per rejected candidate.
export function agentCapacityReason(name, agents, runtimeCap, inflight, runtimeInflight, projected) {
  const a = agents[name];
  if (!a) return 'unknown_agent';
  if (a.available === false) return 'agent_offline'; // PAN-8645: offline runtime block
  const agentNow = (inflight[name] || 0) + (projected.perAgent[name] || 0);
  if (agentNow >= (a.maxInflight ?? Infinity)) return 'agent_at_capacity';
  const rtNow = (runtimeInflight[a.runtime] || 0) + (projected.perRuntime[a.runtime] || 0);
  if (rtNow >= (runtimeCap[a.runtime] ?? Infinity)) return 'runtime_at_capacity';
  return null;
}

// Seed-label check (mirrors core.mjs's isSeedByLabel, kept local to avoid
// a circular import — capacity.mjs is imported by core.mjs).
function isSeedLabel(issue) {
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  if (labelNames.includes('not-a-seed')) return false;
  return labelNames.includes('idea') || labelNames.includes('needs-plan') || labelNames.includes('consus-idea');
}

// In-flight review count per review-lane agent — an issue assigned to a
// review agent = that agent is (or should be) reviewing it, so it holds a
// slot until it leaves in_review (merged->done) or is sent back. This caps
// concurrent reviews at each agent's maxInflight without touching the
// build lanes' claude RUNTIME_CAP accounting (review agents use their own
// bucket).
//
// Seed-labeled issues are excluded: they are skipped by selectReviewDispatch
// and must not occupy a capacity slot — a seed accidentally landing in
// in_review would otherwise deadlock all review dispatch (PANT-737).
export function computeReviewInflight(inReviewIssues, cfg) {
  const lane = cfg.REVIEW_LANE || [];
  const idToName = {};
  for (const n of lane) { const a = cfg.AGENTS[n]; if (a) idToName[a.id] = n; }
  const counts = {};
  for (const n of lane) counts[n] = 0;
  for (const i of inReviewIssues) {
    if (isSeedLabel(i)) continue;
    const name = idToName[i.assignee_id];
    if (name) counts[name] += 1;
  }
  return counts;
}

// Pick the review-lane agent with the most free capacity (lowest current+projected
// load) that is still under its maxInflight, its runtime bucket's RUNTIME_CAP and
// the per-cycle-per-agent cap. Returns null when the lane is full.
// cycleCaps: { perAgentCycle, maxPerAgent } — this cycle's dispatch counts so far.
export function chooseReviewAgent(cfg, reviewInflight, projected = {}, blockedRuntimes = new Set(), cycleCaps = {}, trace = null) {
  const lane = cfg.REVIEW_LANE || [];
  const perAgentCycle = cycleCaps.perAgentCycle || {};
  const maxPerAgent = cycleCaps.maxPerAgent ?? Infinity;
  const loadOf = (name) => (reviewInflight[name] || 0) + (projected[name] || 0);
  const skipReason = (name) => {
    const a = cfg.AGENTS[name];
    if (!a) return 'unknown_agent';
    if (a.available === false) return 'agent_offline'; // PAN-8645: offline runtime
    if (blockedRuntimes.has(a.runtime)) return 'runtime_blocked'; // PANT-587: skip rate-limited runtimes
    if ((perAgentCycle[name] || 0) >= maxPerAgent) return 'per_cycle_per_agent_cap'; // PANT-814: perCyclePerAgent
    // PANT-814: the review bucket's RUNTIME_CAP (e.g. 'claude-review') was never read.
    const rtCap = (cfg.RUNTIME_CAP || {})[a.runtime];
    if (rtCap != null) {
      const rtNow = lane.filter((n) => cfg.AGENTS[n]?.runtime === a.runtime).reduce((sum, n) => sum + loadOf(n), 0);
      if (rtNow >= rtCap) return 'runtime_at_capacity';
    }
    return loadOf(name) < (a.maxInflight ?? Infinity) ? null : 'agent_at_capacity';
  };
  const skips = new Map(lane.map((name) => [name, skipReason(name)]));
  const eligible = lane.filter((name) => skips.get(name) === null);
  eligible.sort((x, y) => {
    const lx = (reviewInflight[x] || 0) + (projected[x] || 0);
    const ly = (reviewInflight[y] || 0) + (projected[y] || 0);
    if (lx !== ly) return lx - ly;
    return lane.indexOf(x) - lane.indexOf(y);
  });
  const chosen = eligible[0] ?? null;
  if (trace) trace.candidates = laneCandidates(lane, chosen, skips, cfg.AGENTS);
  return chosen;
}

// The decision record's `candidates` list (PANT-816): every lane agent
// considered, the chosen one marked, each rejected one with its skip reason.
// An agent that was eligible but lost the load/lane-order tiebreak is
// 'lower_ranked'.
export function laneCandidates(lane, chosen, skips, agents = {}) {
  return lane.map((agent) => {
    const runtime = agents[agent]?.runtime ?? null;
    if (agent === chosen) return { agent, runtime, selected: true };
    return { agent, runtime, selected: false, skip: skips.get(agent) || 'lower_ranked' };
  });
}
