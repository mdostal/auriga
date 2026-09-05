// GitHub's own PullRequestState enum — see
// https://docs.github.com/en/graphql/reference/enums#pullrequeststate — plus
// the two real spellings a merge/close timestamp can arrive under. Named
// here, once, instead of re-typing raw string literals at every comparison
// site in core.mjs (this file's own reason for existing: GH issue #81 found
// a THIRD hand-copied, and this time simply WRONG-cased, version of this
// exact check — `prIsOpen` had it right, `detectFalseDone`'s merged-PR guard
// partially duplicated it, `detectVerifiedDone` lacked it entirely).
//
// SCOPE NOTE: this is a GitHub-shaped constants module because gh CLI is
// this repo's real, current PR-discovery source (see
// lib/adapters/pantheon-v2-l2/index.mjs's ghPrs()) — it is not a prediction
// or a pre-built hook for some other PR/MR source that doesn't exist yet
// (adapters/README.md's no-pre-emptive-integrations rule still applies). If
// a future integration needs a different shape, it gets its own constants
// module the same way this one does, and the call sites below swap which
// module they import — the point of extracting these is exactly to make
// that swap a one-file change instead of a grep-and-pray across core.mjs.
//
// Ownership note (operator, 2026-09-05): Auriga's core state-machine
// shouldn't ideally need to know GitHub's specific enum shape at all — it's
// doing this heuristic board-reconciliation work only because nothing else
// in the system does it yet. This module exists to make that boundary
// explicit and swappable, not to bless it as permanent.
export const GITHUB_PR_STATE = Object.freeze({
  OPEN: 'OPEN',
  CLOSED: 'CLOSED',
  MERGED: 'MERGED',
});

// Field-name spellings for a PR's merge/close timestamp, in priority order.
// gh CLI's own `--json` output uses camelCase (mergedAt/closedAt); some
// other tool/adapter shapes seen in this codebase's history used snake_case
// (merged_at/closed_at) — both are checked everywhere a PR's merge/close
// time matters, so both are named here instead of re-listed at each site.
export const PR_TIMESTAMP_FIELDS = Object.freeze({
  MERGED_AT: Object.freeze(['mergedAt', 'merged_at']),
  CLOSED_AT: Object.freeze(['closedAt', 'closed_at']),
});

// Returns the first present, non-null value among `fields` on `pr`, or null.
export function prTimestamp(pr = {}, fields = []) {
  for (const f of fields) {
    if (pr[f] != null) return pr[f];
  }
  return null;
}

// Case-normalizes `pr.state` against GITHUB_PR_STATE — real gh output is
// always uppercase, but this stays tolerant of lowercase/mixed-case input
// (older fixtures, a differently-cased future source) rather than assuming
// one exact casing.
function normalizedState(pr = {}) {
  return (pr.state || '').toUpperCase();
}

// Is this PR still open? Three-way: an explicit OPEN state wins; an explicit
// MERGED/CLOSED state loses; absent any state at all, fall back to "no
// merge/close timestamp of either spelling is present."
export function isPrOpen(pr = {}) {
  const st = normalizedState(pr);
  if (st === GITHUB_PR_STATE.OPEN) return true;
  if (st === GITHUB_PR_STATE.MERGED || st === GITHUB_PR_STATE.CLOSED) return false;
  return prTimestamp(pr, PR_TIMESTAMP_FIELDS.MERGED_AT) == null
    && prTimestamp(pr, PR_TIMESTAMP_FIELDS.CLOSED_AT) == null;
}

// Has this PR genuinely merged? An explicit MERGED state, or any spelling of
// a merge timestamp, counts — this is deliberately permissive (OR, not AND)
// so a source that only ever populates one of the two signals still works.
export function isPrMerged(pr = {}) {
  if (normalizedState(pr) === GITHUB_PR_STATE.MERGED) return true;
  return prTimestamp(pr, PR_TIMESTAMP_FIELDS.MERGED_AT) != null;
}
