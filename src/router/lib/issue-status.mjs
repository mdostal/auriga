// Issue (ticket/story) lifecycle status values used throughout this router.
//
// UNLIKE github-pr-state.mjs's GITHUB_PR_STATE (a verified copy of GitHub's
// own public, documented PullRequestState enum), this module is NOT a
// verified copy of Multica's own API documentation — this codebase has no
// live access to confirm that against Multica's docs from here. These are
// the values this router has empirically relied on and observed to date,
// extracted to name them once instead of repeating raw literals at every
// comparison site — the same "no hardcoded strings" principle, applied
// honestly to a vocabulary that isn't a verified external enum the way
// GitHub's is.
//
// This extraction also closed a real, found-while-doing-it duplication: the
// exact same "is this issue terminal" check (done OR cancelled OR canceled)
// was hand-copied THREE times across core.mjs (depsSatisfied,
// descDepsSatisfied, detectParentDone) before this module existed.
export const ISSUE_STATUS = Object.freeze({
  TODO: 'todo',
  BLOCKED: 'blocked',
  IN_PROGRESS: 'in_progress',
  IN_REVIEW: 'in_review',
  CHANGES_REQUESTED: 'changes_requested',
  DONE: 'done',
  CANCELLED: 'cancelled',
  CANCELED: 'canceled', // both spellings seen live; kept distinct, never silently merged
  SHIPPED: 'shipped',
  COMPLETE: 'complete',
  PENDING: 'pending',
  RUNNING: 'running',
});

// "in progress" (space-separated) is a second real spelling seen live
// alongside IN_PROGRESS (snake_case) — this router's own pre-existing
// defensive handling (ACTIVE_ISSUE_STATUSES), kept exactly, not silently
// merged into one spelling.
export const ISSUE_STATUS_ALT_SPELLINGS = Object.freeze({
  IN_PROGRESS_SPACED: 'in progress',
});

/**
 * Is this a terminal issue status — the story is finished, whether it
 * shipped or was abandoned? done OR cancelled OR canceled OR shipped OR complete.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalIssueStatus(status) {
  return status === ISSUE_STATUS.DONE
    || status === ISSUE_STATUS.CANCELLED
    || status === ISSUE_STATUS.CANCELED
    || status === ISSUE_STATUS.SHIPPED
    || status === ISSUE_STATUS.COMPLETE;
}

// Normalize a free-text status for comparison: "Needs Decision" / needs_decision
// -> needs-decision.
export const normStatus = (v) => (typeof v === 'string' ? v.trim().toLowerCase().replace(/[\s_]+/g, '-') : '');

export const NEEDS_DECISION = 'needs-decision';

// PANT-844: assigned-idle recovery is for genuine `todo` work only. A custom
// workflow column (e.g. "Backlog" mapped onto the todo category) must not slip
// through, so status_category must agree and status_name must not name a
// parked column. status_name is free text ("To Do"), so only known parked
// names are rejected rather than requiring an exact `todo`.
//
// PANT-931 / PANT-1173 (auriga#246, #237): Pantheon folds Multica `backlog` into
// `todo`; the pantheon-v2-l2 adapter surfaces the real status (core-api's
// `nativeStatus`) as status_name, so this one check is what makes backlog a park.
// Every pass that reasons about "todo" work (routing, assigned-idle reruns,
// archived-agent unassigns, the assignedQueued / todoUnassigned counts) uses it.
const PARKED_STATUS_NAMES = new Set(['backlog', 'blocked', NEEDS_DECISION]);
export function isPlainTodo(issue = {}) {
  if (normStatus(issue.status) !== ISSUE_STATUS.TODO) return false;
  if (issue.status_category && normStatus(issue.status_category) !== ISSUE_STATUS.TODO) return false;
  if (PARKED_STATUS_NAMES.has(normStatus(issue.status_name))) return false;
  return true;
}
