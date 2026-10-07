// Review-dispatch eligibility predicates — a leaf module (no imports) so both
// core.mjs (selectReviewDispatch) and capacity.mjs (computeReviewInflight) can
// share ONE definition of "tickets the review loop skips" without a circular
// import. Keeping these in lockstep is the whole point: any in_review ticket
// selectReviewDispatch skips but computeReviewInflight counts is a phantom
// review slot, and with a RUNTIME_CAP of 1 a single phantom freezes every
// review in the tenant (PANT-737 seeds, PANT-843 parked tickets).

// Ignore smoke/scratch/verification tickets by title.
export function isSmokeScratch(title = '') {
  return /\b(smoke|scratch)\b/i.test(title) || /verification-swarm/i.test(title);
}

export const HUMAN_TODO_LABEL = 'human-todo';

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

// blocked_reason values the ROUTER itself writes when it gives up and sets the
// issue `blocked` (zombie give-up, review give-up). They describe that blocked
// state only.
export const ROUTER_GIVE_UP_REASONS = Object.freeze(['zombie-give-up-max-attempts', 'review-give-up-max-attempts']);

// PANT-930 (GH #244): true when a router give-up reason outlived the `blocked`
// status it was written with. Once a human or agent moves the issue out of
// `blocked` (reworked -> in_review, reset -> todo) the give-up is over, but
// nothing deletes the key. Treating it as a live park skipped those issues
// forever (live: PANT-809/812/815/816 in_review, never reviewed).
export function isStaleRouterPark(issue = {}) {
  const r = issue && issue.metadata && issue.metadata.blocked_reason;
  if (typeof r !== 'string' || !ROUTER_GIVE_UP_REASONS.includes(r.trim())) return false;
  return String(issue.status || '').toLowerCase() !== 'blocked';
}

// True when an agent explicitly parked an issue for a human (metadata.blocked_reason set).
// These must never be auto-unblocked or cascade-redispatched — they're idempotent-dispatch guards.
// A router give-up reason only parks while the issue is still `blocked` (isStaleRouterPark);
// any other (agent/human-written) reason parks in every status.
export function isAgentParked(issue = {}) {
  const r = issue && issue.metadata && issue.metadata.blocked_reason;
  if (typeof r !== 'string' || r.trim() === '') return false;
  return !isStaleRouterPark(issue);
}

// isSeed limited to the explicit-label legs only — used in detect* functions where
// the childless+top-level heuristic is too broad (an in_progress story has no children
// in that set, so the heuristic would fire on every top-level ticket).
export function isSeedByLabel(issue) {
  const labelNames = (issue.labels || []).map((l) => (typeof l === 'string' ? l : l && l.name));
  if (labelNames.includes('not-a-seed')) return false;
  return labelNames.includes('idea') || labelNames.includes('needs-plan') || labelNames.includes('consus-idea');
}

// True when selectReviewDispatch never acts on this in_review ticket — and so
// computeReviewInflight must never count it against review capacity.
export function isReviewDispatchSkipped(issue, cfg) {
  if (isSmokeScratch(issue.title)) return true;
  if (isAgentParked(issue)) return true;
  if (isHumanTodo(issue, cfg)) return true; // human controls this review
  if (isSeedByLabel(issue)) return true; // PANT-625/PANT-737: seeds are planning-lane
  return false;
}
