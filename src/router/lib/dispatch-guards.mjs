// The dispatch guards every cycle() dispatch pass applies (PANT-815). Pure: no
// I/O, no mutation. The passes used to hand-roll these checks one copy each,
// and a guard missing from one copy was the most common router regression
// (see test/dispatch-guard-matrix.test.mjs). cycle() now asks
// dispatchEligible() before every dispatch, and commits the dispatch through
// commitDispatch() in auriga-router.mjs.

import { PLANNING_AGENT, isAgentParked, isHiveStory, isSeedByLabel, isSeedForTenant } from './core.mjs';

// Passes that route an issue to a newly chosen agent. The other passes rerun
// an issue on its current assignee, which never re-routes it anywhere.
const ROUTING_PASSES = new Set(['build', 'cascade', 'review', 'zombie-assign']);

// The skip reason each pass has always logged for a blocked runtime.
const RUNTIME_BLOCKED_REASON = {
  'cascade-rerun': 'assignee-runtime-blocked',
  'zombie-rerun': 'assignee-runtime-blocked',
  'zombie-assign': 'assignee-runtime-blocked',
};

// Errors that mean the runtime is out of capacity for the rest of the cycle.
export function isRateLimitError(e) {
  return /limit|quota|rate|429|exhaust/i.test((e && e.message) || '');
}

// Can `pass` dispatch `issue` to ctx.agent on ctx.runtime? Returns
// { ok: true } or { ok: false, reason, stop }. stop=true means the cycle-wide
// or per-pass cap is spent, so the pass should end rather than skip.
//
// Guards run in this fixed order:
//   max-assign, pass cap, agent-parked, seed, blocked runtime, perCyclePerAgent.
// Leave ctx.agent/ctx.runtime unset to check only the caps and the issue itself
// (a pass does this at the top of its loop, before it has picked an agent).
//
// The seed guard only applies to routing passes: a seed is only ever routed to
// the planning agent. A rerun on the current assignee is left alone (PANT-643).
// The build pass uses the tenant-aware seed check selectAssignments uses; the
// other passes use the label-only check their detect* functions use, because
// the top-level + childless heuristic matches most in-flight tickets.
export function dispatchEligible(issue, pass, ctx = {}) {
  const {
    agent, runtime, cfg, allIssues = [],
    assigned = 0, maxAssign = Infinity,
    passCount = 0, passCap = Infinity,
    blockedRuntimes = new Set(),
    agentCycleAssigns = {}, perCyclePerAgent = Infinity,
  } = ctx;

  if (assigned >= maxAssign) return { ok: false, reason: 'max-assign', stop: true };
  if (passCount >= passCap) return { ok: false, reason: 'pass-cap', stop: true };
  if (isAgentParked(issue)) return { ok: false, reason: 'agent-parked', stop: false };
  if (agent && agent !== PLANNING_AGENT && ROUTING_PASSES.has(pass) && issue && !isHiveStory(issue)) {
    const seed = pass === 'build' ? isSeedForTenant(issue, allIssues, cfg) : isSeedByLabel(issue);
    if (seed) return { ok: false, reason: 'seed', stop: false };
  }
  if (runtime && blockedRuntimes.has(runtime)) {
    return { ok: false, reason: RUNTIME_BLOCKED_REASON[pass] || 'runtime-blocked', stop: false };
  }
  if (agent && (agentCycleAssigns[agent] || 0) >= perCyclePerAgent) {
    return { ok: false, reason: 'per-cycle-per-agent-cap', stop: false };
  }
  return { ok: true };
}
