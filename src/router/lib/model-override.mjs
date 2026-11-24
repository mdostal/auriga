// PANT-1327 (heimdall#142 slice 4, Auriga side): what Heimdall's route verdict
// means for ONE dispatch. Pure: no I/O, no clock reads (callers pass `now`).
//
// Heimdall decides and reports; Auriga dispatches (heimdall#132). Heimdall's
// POST /route answer (relayed by Pantheon's /api/route/select) carries:
//   verdict          'route' | 'queue' | 'no_route'
//   resets_at        for a queue: the earliest reset Heimdall knows of, else null
//   chosen_lane      the lane the verdict is for
//   model            the model to dispatch with on chosen_lane
//   preferred_model  the lane's preferred model (equals `model` unless swapped)
//   model_swap       non-null when `model` is a swap: { preferred_model, model, cause, ... }
//
// Rules this module enforces:
//   - A per-task override only when Heimdall named a swap: `model_swap` is set,
//     or `model` differs from `preferred_model`. Pantheon fills `model` from the
//     lane declaration on every answer, so a bare `model` is the preference,
//     not an override, and dispatch stays unchanged.
//   - Only for the lane the agent actually runs on. A verdict for another lane
//     names another account's model; applying it here would pick a model
//     Heimdall did not name for this lane.
//   - Never a model Heimdall did not name, never a downgrade of Auriga's own:
//     the only model ever returned is the verdict's own `model`.
//   - A `queue` with a future `resets_at` holds the task until then. A queue
//     without a reset time is not held here (nothing to hold until); the
//     dispatch goes ahead exactly as before this change.

export const DEFAULT_MODEL_OVERRIDE = Object.freeze({
  enabled: true,
  // Issue metadata keys the hold is kept in, so it survives the router's
  // fresh-process `--once` cycles and is visible on the ticket.
  holdUntilKey: 'heimdall_queue_until',
  holdReasonKey: 'heimdall_queue_reason',
});

export function modelOverrideConfig(cfg) {
  return { ...DEFAULT_MODEL_OVERRIDE, ...(cfg && cfg.MODEL_OVERRIDE ? cfg.MODEL_OVERRIDE : {}) };
}

function str(v) {
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

function parseMs(v) {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}

// The limit or reason behind a swap, as one short line for the log. Heimdall's
// `cause` is either a string or an object (kind/reason/resets_at); only those
// descriptive fields are read, so nothing else in the payload is ever logged.
export function describeSwapCause(route) {
  const swap = route && route.model_swap;
  const cause = swap && swap.cause;
  if (typeof cause === 'string') return cause;
  if (cause && typeof cause === 'object') {
    const parts = [cause.kind, cause.limit, cause.reason].map(str).filter(Boolean);
    const resets = str(cause.resets_at) || str(cause.preferred_available_at);
    if (resets) parts.push(`resets ${resets}`);
    if (parts.length) return parts.join(': ');
  }
  return str(route && route.rationale) || 'heimdall model swap';
}

// Decide what to do with one route verdict.
//   route: the selectRoute() answer (may be null/undefined: Heimdall unreachable)
//   ctx:   { executedLane, preferredModel?, now }
// Returns one of:
//   { kind: 'default' }                                   dispatch as before
//   { kind: 'override', model, preferredModel, lane, reason }
//   { kind: 'hold', until, reason }                       don't dispatch until `until` (ISO)
export function planDispatchFromRoute(route, { executedLane = null, preferredModel = null, now = Date.now() } = {}) {
  if (!route || typeof route !== 'object') return { kind: 'default' };

  if (route.verdict === 'queue') {
    const untilMs = parseMs(route.resets_at);
    if (untilMs === null || untilMs <= now) return { kind: 'default' };
    const levels = Array.isArray(route.allowed_levels) && route.allowed_levels.length ? ` at ${route.allowed_levels.join('/')}` : '';
    return {
      kind: 'hold',
      until: new Date(untilMs).toISOString(),
      reason: `heimdall queue: no model available${levels} until ${new Date(untilMs).toISOString()}`,
    };
  }

  if (route.verdict && route.verdict !== 'route') return { kind: 'default' };
  const lane = str(route.chosen_lane) || str(route.lane_id);
  if (!lane || !executedLane || lane !== executedLane) return { kind: 'default' };

  const model = str(route.model);
  if (!model) return { kind: 'default' };
  const swap = route.model_swap && typeof route.model_swap === 'object' ? route.model_swap : null;
  const lanePreferred = str(route.preferred_model) || str(swap && swap.preferred_model);
  const swapped = swap !== null || (lanePreferred !== null && lanePreferred !== model);
  if (!swapped) return { kind: 'default' };
  // The swap must name the same model as the verdict; a mismatch is a
  // malformed answer, and guessing between the two would be picking a model.
  if (swap && str(swap.model) && str(swap.model) !== model) return { kind: 'default' };

  const preferred = str(preferredModel) || lanePreferred;
  if (preferred && preferred === model) return { kind: 'default' };
  return { kind: 'override', model, preferredModel: preferred, lane, reason: describeSwapCause(route) };
}

// When does the hold recorded on this issue end? null when there is none or
// it has passed. Read from issue metadata (see DEFAULT_MODEL_OVERRIDE).
export function heimdallHoldUntilMs(issue, now = Date.now(), cfg = null) {
  const { enabled, holdUntilKey } = modelOverrideConfig(cfg);
  if (!enabled || !issue || !issue.metadata) return null;
  const untilMs = parseMs(issue.metadata[holdUntilKey]);
  return untilMs !== null && untilMs > now ? untilMs : null;
}

// Metadata that records a hold, or clears it ('' is the board's clear).
export function holdMetadata(plan, cfg = null) {
  const { holdUntilKey, holdReasonKey } = modelOverrideConfig(cfg);
  if (plan && plan.kind === 'hold') return { [holdUntilKey]: plan.until, [holdReasonKey]: plan.reason };
  return { [holdUntilKey]: '', [holdReasonKey]: '' };
}
