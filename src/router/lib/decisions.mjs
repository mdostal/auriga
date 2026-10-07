// Decision records (PANT-816, VISION.md ② "metrics at every decision"). One
// `decision` JSONL event per routing choice cycle() makes (dispatched, dry-run,
// handed off or skipped by a guard), in one versioned shape, so routing policy
// can be compared across runs. The schema is documented in src/router/README.md
// ("Decision records"). Pure except for the skip limiter's own state.

export const DECISION_SCHEMA_VERSION = 1;

export const DECISION_PASSES = Object.freeze([
  'build', 'cascade', 'zombie', 'assigned_idle', 'review', 'hand_up', 'hand_down',
]);

export const DECISION_ACTIONS = Object.freeze(['assign', 'rerun', 'create_remote', 'skip']);

export const REVIEW_TIERS = Object.freeze(['full', 'light', 'backend', 'standard']);

// Why the agent (or the skip) was chosen. Dispatch reasons first, then skip
// reasons. dispatchEligible()'s hyphenated reasons map here via reasonCode().
export const DECISION_REASONS = Object.freeze([
  // dispatch
  'hive_story', 'tree_attachment', 'project_lane', 'default_lane', 'seed_planning',
  'existing_assignee', ...REVIEW_TIERS.map((t) => `review_tier_${t}`),
  'no_local_route', 'project_route_child',
  // skip: dispatchEligible() guards
  'max_assign', 'pass_cap', 'agent_parked', 'seed', 'runtime_blocked',
  'assignee_runtime_blocked', 'per_cycle_per_agent_cap',
  // skip: pass-local
  'no_capacity', 'give_up_max_attempts', 'unknown_child', 'child_unreachable',
]);

const REASON_SET = new Set(DECISION_REASONS);

export function isDecisionReason(reason) {
  return REASON_SET.has(reason);
}

// 'per-cycle-per-agent-cap' -> 'per_cycle_per_agent_cap'. Aliases fold the
// pass-local spellings that mean the same thing.
const REASON_ALIASES = { no_lane_capacity: 'no_capacity' };
export function reasonCode(reason) {
  const code = String(reason || '').replace(/-/g, '_');
  return REASON_ALIASES[code] || code;
}

// cycle() pass names (dispatchEligible's, which split rerun vs assign shapes)
// -> the decision record's pass.
const PASS_FOR = {
  build: 'build',
  cascade: 'cascade', 'cascade-rerun': 'cascade',
  review: 'review', 'review-rerun': 'review',
  'zombie-rerun': 'zombie', 'zombie-assign': 'zombie', zombie: 'zombie',
  'assigned-idle': 'assigned_idle',
  hand_up: 'hand_up', hand_down: 'hand_down',
};
export function decisionPass(pass) {
  return PASS_FOR[pass] || pass;
}

// The lane reason chooseAgentForProject() routes by.
export function laneReason(projectId, cfg, isHive = false) {
  if (isHive) return 'hive_story';
  return cfg.PROJECT_LANE && cfg.PROJECT_LANE[projectId] ? 'project_lane' : 'default_lane';
}

// Headroom for `agent` / `runtime` at decision time. Nulls when the pass has no
// agent yet (a pre-selection skip). A null cap means uncapped.
export function capsSnapshot({ agent, runtime, cfg, inflight = {}, loopRtProjected = {}, priorAgentCycleAssigns = {}, assigned = 0, maxAssign = Infinity }) {
  const a = agent ? cfg.AGENTS?.[agent] : null;
  const rt = runtime ?? a?.runtime ?? null;
  let rtInflight = null;
  if (rt) {
    rtInflight = loopRtProjected[rt] || 0;
    for (const [name, n] of Object.entries(inflight)) if (cfg.AGENTS?.[name]?.runtime === rt) rtInflight += n;
  }
  const finite = (n) => (Number.isFinite(n) ? n : null);
  return {
    agent_inflight: agent ? inflight[agent] || 0 : null,
    agent_max_inflight: finite(a?.maxInflight),
    agent_cycle_assigns: agent ? priorAgentCycleAssigns[agent] || 0 : null,
    per_cycle_per_agent: finite(cfg.CAPS?.perCyclePerAgent),
    runtime_inflight: rtInflight,
    runtime_cap: rt ? finite(cfg.RUNTIME_CAP?.[rt]) : null,
    assigned,
    max_assign: finite(maxAssign),
  };
}

// Builds one record. Every schema field is always present (null when unknown)
// so consumers never branch on a missing key.
export function buildDecision({
  now = Date.now(), tenantId = null, instanceId = null,
  identifier, pass, action, agent = null, runtime = null, lane = null,
  reason, candidates = [], caps = null, dryRun = false, error = null,
}) {
  return {
    schema: DECISION_SCHEMA_VERSION,
    ts: new Date(now).toISOString(),
    tenant_id: tenantId,
    instance_id: instanceId,
    identifier,
    pass: decisionPass(pass),
    action,
    agent,
    runtime,
    lane,
    reason: reasonCode(reason),
    candidates,
    caps,
    dry_run: Boolean(dryRun),
    error: error ? String(error.message ?? error) : null,
  };
}

// Rate-limits `skip` decisions to one per issue per `windowCycles` cycles, so
// an issue a guard rejects every cycle doesn't flood the log. Keep one limiter
// per tenant across cycles and call tick() once at the start of each cycle.
export function createSkipLimiter({ windowCycles = 10 } = {}) {
  let cycleNo = 0;
  const lastEmitted = new Map();
  return {
    tick() { cycleNo += 1; },
    allow(identifier, window = windowCycles) {
      const last = lastEmitted.get(identifier);
      if (last !== undefined && cycleNo - last < window) return false;
      lastEmitted.set(identifier, cycleNo);
      return true;
    },
  };
}
