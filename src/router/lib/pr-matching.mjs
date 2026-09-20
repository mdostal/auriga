// GitHub PR<->story matching + target-repo parsing — extracted from
// core.mjs (t011 decomposition). Depends only on github-pr-state.mjs
// (isPrOpen) and story-identity.mjs (storyKey), both leaf modules — no
// dependency on any of core.mjs's own dispatch/decision logic.

import { isPrOpen } from './github-pr-state.mjs';
import { storyKey } from './story-identity.mjs';

// A `target_repo:` line in the description is the build-lane's own signal, so its
// presence is a reliable "this story produced code in a repo" marker.
const TARGET_REPO_RE = /(^|\n)\s*target_repo:\s*\S+/i;
export function hasTargetRepo(issue = {}) {
  return TARGET_REPO_RE.test(issue.description || '');
}

// Broad PR<->ticket matcher. The old convention (branch feat/<TICKET-ID> only) was
// too narrow: build lanes name branches like feat/pan-6667-descriptive (lowercased +
// suffixed) and rarely start a title with the id. Match the ticket id (case-
// insensitive) ANYWHERE in the PR's head branch, title, or body.
export function prReferencesIssue(pr = {}, identifier = '') {
  if (!identifier) return false;
  const id = String(identifier).toLowerCase();
  const hay = [pr.headRefName, pr.head_ref, pr.branch, pr.title, pr.body]
    .filter((s) => typeof s === 'string')
    .join('\n')
    .toLowerCase();
  return hay.includes(id);
}

// Broader PR<->STORY matcher: matches on the ticket identifier (prReferencesIssue)
// OR on the story's short epic-scoped key (storyKey) appearing in the PR's head
// branch / title / body. The key match tolerates a trailing "-" (feat/m-01-service)
// but rejects a trailing digit so "m-01" never matches "m-010". This is what lets
// slug-branched PRs (mnemosyne#1 feat/m-01-service) match their PAN ticket, which
// the narrow id-only matcher missed.
export function prMatchesStory(pr = {}, issue = {}) {
  if (prReferencesIssue(pr, issue.identifier)) return true;
  const key = storyKey(issue);
  if (!key) return false;
  const hay = [pr.headRefName, pr.head_ref, pr.branch, pr.title, pr.body]
    .filter((s) => typeof s === 'string').join('\n').toLowerCase();
  const re = new RegExp('(?<![a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
  return re.test(hay);
}

// STRICT identity matcher: the ticket id or the story's short key appears in the PR's
// HEAD BRANCH or TITLE only — never the body. A body can merely *mention* a ticket
// ("builds on PAN-6659") without being that ticket's PR; using the body to decide a
// status change (e.g. demoting a legitimately-merged done story) is a false-positive
// trap. Branch/title is the PR's own identity, so this is safe for status mutations.
export function prIdentityMatchesStory(pr = {}, issue = {}) {
  const idHay = [pr.headRefName, pr.head_ref, pr.branch, pr.title]
    .filter((s) => typeof s === 'string').join('\n').toLowerCase();
  const id = String(issue.identifier || '').toLowerCase();
  if (id && idHay.includes(id)) return true;
  const key = storyKey(issue);
  if (!key) return false;
  const re = new RegExp('(?<![a-z0-9])' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![0-9])', 'i');
  return re.test(idHay);
}

// owner/repo slug parsed from a PR's html url (github.com/owner/repo/pull/N), or null.
export function repoFromPrUrl(pr = {}) {
  const u = pr.url || pr.html_url || '';
  const m = String(u).match(/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\//i);
  return m ? m[1] : null;
}

// Is a PR open (not merged/closed)? See github-pr-state.mjs's isPrOpen —
// kept exported here under this name too (not just re-exported from core.mjs)
// because auriga-router.mjs accesses it as coreImpl.prIsOpen.
export const prIsOpen = isPrOpen;

// Does this ticket have at least one OPEN PR referencing it? `prs` is the array of
// candidate PRs the router gathered (gh pr list across the story's resolvable repos).
export function hasOpenPrForIssue(identifier, prs = []) {
  return (prs || []).some((pr) => prIsOpen(pr) && prReferencesIssue(pr, identifier));
}

// Normalize a target_repo value (bare slug, https/ssh git URL, github.com/owner/repo,
// with or without a trailing .git) to an owner/repo slug, or null if it is not a bare
// GitHub slug (e.g. a local filesystem path with extra segments).
export function normalizeRepoSlug(value = '') {
  if (!value || typeof value !== 'string') return null;
  const v = value.trim()
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/^github\.com\//i, '')
    .replace(/\.git$/i, '');
  const m = v.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!m) return null;
  return m[1] + '/' + m[2];
}

// The story's declared target_repo: metadata.target_repo (preferred) or a
// `target_repo: <value>` line in the description. Raw value (not normalized).
export function targetRepoValue(issue = {}) {
  const meta = issue && issue.metadata && issue.metadata.target_repo;
  if (typeof meta === 'string' && meta.trim()) return meta.trim();
  const m = (issue.description || '').match(/(^|\n)\s*target_repo:\s*(\S+)/i);
  return m ? m[2] : null;
}
