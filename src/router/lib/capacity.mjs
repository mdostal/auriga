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

// In-flight review count per review-lane agent — an issue assigned to a
// review agent = that agent is (or should be) reviewing it, so it holds a
// slot until it leaves in_review (merged->done) or is sent back. This caps
// concurrent reviews at each agent's maxInflight without touching the
// build lanes' claude RUNTIME_CAP accounting (review agents use their own
// bucket).
export function computeReviewInflight(inReviewIssues, cfg) {
  const lane = cfg.REVIEW_LANE || [];
  const idToName = {};
  for (const n of lane) { const a = cfg.AGENTS[n]; if (a) idToName[a.id] = n; }
  const counts = {};
  for (const n of lane) counts[n] = 0;
  for (const i of inReviewIssues) {
    const name = idToName[i.assignee_id];
    if (name) counts[name] += 1;
  }
  return counts;
}

// Pick the review-lane agent with the most free capacity (lowest current+projected
// load) that is still under its maxInflight. Returns null when the lane is full.
export function chooseReviewAgent(cfg, reviewInflight, projected = {}) {
  const lane = cfg.REVIEW_LANE || [];
  const eligible = lane.filter((name) => {
    const a = cfg.AGENTS[name];
    if (!a) return false;
    const now = (reviewInflight[name] || 0) + (projected[name] || 0);
    return now < a.maxInflight;
  });
  if (!eligible.length) return null;
  eligible.sort((x, y) => {
    const lx = (reviewInflight[x] || 0) + (projected[x] || 0);
    const ly = (reviewInflight[y] || 0) + (projected[y] || 0);
    if (lx !== ly) return lx - ly;
    return lane.indexOf(x) - lane.indexOf(y);
  });
  return eligible[0];
}
