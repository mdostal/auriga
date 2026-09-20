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
 * shipped or was abandoned? done OR cancelled OR canceled.
 * @param {string} status
 * @returns {boolean}
 */
export function isTerminalIssueStatus(status) {
  return status === ISSUE_STATUS.DONE
    || status === ISSUE_STATUS.CANCELLED
    || status === ISSUE_STATUS.CANCELED;
}
