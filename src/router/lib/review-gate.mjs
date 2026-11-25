// Review gate (PANT-1383). A leaf module (imports only issue-status) holding
// the pure pieces of "may this issue go to the review squad at all?".
//
// Live 2026-11-16: parent epic FFE-1598 (no PR, three child stories still
// open) went in_progress -> in_review three times in six minutes. Each time a
// builder run on it finished, detectRunCompletions promoted it, and each
// promotion dispatched a full review squad that had nothing to review. The
// rule now:
//   - an issue with open (non-terminal) child issues is never sent to review;
//   - an issue with no linked PR/branch is never sent to review;
//   - an issue that comes back to review with the same head commit it had last
//     time is stopped, not reviewed again.
// A held issue keeps its status (it waits). PANT-1457: the router records the
// hold in metadata and its log, never as a comment: Multica counts any comment
// as a trigger and queued a second run for the assignee on every notice.
// core.mjs owns reviewHoldReason (it needs ownPrUrl); this file has the parts
// that core.mjs's own detectors need without an import cycle.

import { isTerminalIssueStatus } from './issue-status.mjs';

// Metadata keys the router writes.
//   review_hold            – the current hold tag; doubles as the "already commented" marker.
//   review_promoted_head   – head key when the router last promoted in_progress -> in_review.
//   review_dispatched_head – head key when the router last dispatched a fresh review.
export const REVIEW_HOLD_KEY = 'review_hold';
export const REVIEW_PROMOTED_HEAD_KEY = 'review_promoted_head';
export const REVIEW_DISPATCHED_HEAD_KEY = 'review_dispatched_head';
//   review_hold_note       – PANT-1457: the human-readable reason for the hold.
export const REVIEW_HOLD_NOTE_KEY = 'review_hold_note';

export const REVIEW_HOLD = Object.freeze({
  OPEN_CHILDREN: 'open-children',
  NO_LINKED_PR: 'no-linked-pr',
  REVIEW_LOOP: 'review-loop',
});

// The issue's child issues that are not done/cancelled. Only children on the
// scanned board are visible, which is the same view detectParentDone uses.
export function openChildren(issue, allIssues = []) {
  if (!issue || !issue.id) return [];
  return allIssues.filter((c) => c && c.parent_issue_id === issue.id
    && !isTerminalIssueStatus(String(c.status || '').toLowerCase()));
}

// True while a review hold the router wrote is still on the issue.
export function isReviewHeld(issue = {}) {
  const v = issue && issue.metadata && issue.metadata[REVIEW_HOLD_KEY];
  return typeof v === 'string' && v.trim() !== '';
}

// The PR fields that change when a new commit lands. Multica's linked-PR rows
// are gh-shaped (headRefOid) but other spellings are accepted. updatedAt is
// the last resort: it also moves on a push, so a missing sha field can only
// make the loop guard more lenient, never stop a PR that did get a commit.
function prHead(pr = {}) {
  return pr.headRefOid || pr.head_sha || pr.headSha || (pr.head && pr.head.sha)
    || pr.updatedAt || pr.updated_at || '';
}

// Stable fingerprint of "what would be reviewed": every linked PR's url plus
// its head. Same key twice means no new commit between the two promotions.
export function reviewHeadKey(issue = {}, prs = []) {
  const parts = (prs || [])
    .map((p) => `${String(p.url || p.html_url || p.number || '').toLowerCase()}@${prHead(p)}`)
    .sort();
  if (parts.length) return parts.join('|');
  const own = issue && issue.metadata && issue.metadata.pr_url;
  return typeof own === 'string' && own.trim() ? `${own.trim().toLowerCase()}@` : 'none';
}

// The hold tag stored in metadata.review_hold. One comment per distinct tag:
// open-children / no-linked-pr comment once however long the hold lasts; a
// review loop comments once per head key.
export function reviewHoldTag(hold) {
  if (!hold) return '';
  return hold.reason === REVIEW_HOLD.REVIEW_LOOP ? `${hold.reason}@${hold.headKey}` : hold.reason;
}

export function reviewHoldComment(hold, { stage = 'review' } = {}) {
  const what = stage === 'promotion'
    ? 'Auriga did not move this issue to `in_review` and did not dispatch the review squad'
    : 'Auriga is not dispatching the review squad for this issue';
  if (hold.reason === REVIEW_HOLD.OPEN_CHILDREN) {
    const ids = (hold.children || []).map((c) => c.identifier).filter(Boolean);
    return `${what}: it still has ${ids.length || 'some'} open child issue(s)${ids.length ? ` (${ids.join(', ')})` : ''}.\n\n`
      + 'A parent is closed by its children, not reviewed. It stays where it is and rolls up to `done` once every child is done or cancelled.';
  }
  if (hold.reason === REVIEW_HOLD.NO_LINKED_PR) {
    return `${what}: no pull request or branch is linked to it, so there is nothing to review.\n\n`
      + 'Link the PR (open it with the ticket id in the branch/title, or set `pr_url` in the metadata) and it will go to review on the next cycle.';
  }
  return `${what}: it came back to review with no new commit since the last time Auriga sent it there (head \`${hold.headKey}\`).\n\n`
    + 'Reviewing the same commit again changes nothing, so Auriga stopped here. Push a new commit to re-enter review, '
    + `or clear the \`${hold.metaKey || REVIEW_PROMOTED_HEAD_KEY}\` metadata key to force one more review.`;
}

// PANT-1457: GitHub pull-request URLs written anywhere in free text (an issue
// description, a comment). FFE-1032 had PR #4661 posted in a comment while its
// branch carried no ticket id, so the PR linkage came back empty and the gate
// held it as "no linked PR". Returns normalized, de-duplicated urls
// (https://github.com/<owner>/<repo>/pull/<n>) in first-seen order.
const PR_URL_RE = /https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/gi;
export function prUrlsInText(...texts) {
  const seen = new Set();
  const out = [];
  for (const t of texts.flat()) {
    if (typeof t !== 'string' || !t) continue;
    for (const m of t.matchAll(PR_URL_RE)) {
      const url = `https://github.com/${m[1].toLowerCase()}/${m[2].toLowerCase().replace(/\.git$/, '')}/pull/${m[3]}`;
      if (!seen.has(url)) { seen.add(url); out.push(url); }
    }
  }
  return out;
}

// PR rows for urls found in text. No head sha is known for them, so reviewHeadKey
// gives "<url>@", the same shape a bare metadata.pr_url already produces.
export function mentionedPrRows(urls = []) {
  return urls.map((url) => ({ url, _source: 'mention' }));
}
