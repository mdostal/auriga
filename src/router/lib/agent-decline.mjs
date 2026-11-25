// PANT-1459 (pantheon-v2#598): recognise an assigned agent that keeps declining
// its ticket, and tickets a founder has claimed for themselves.
//
// The assigned_idle pass re-runs any assigned `todo` once it has been idle past
// assignedIdleStaleMs. A ticket the agent has already turned down stays `todo`
// after every run, so it re-qualified every stale boundary (live: FFE-880, a
// founder-claimed epic, re-ran 35 times in 24 h on flayr-build-claude-api-2;
// each 25 s run posted "Routed to me again. Nothing has changed since my
// comment at ..."). Pure logic only: runs and issues in, a verdict out.

import { classifyRun, isQuotaFailure } from './run-classification.mjs';

// The run's final output text, or ''. Multica returns `result` as an object
// ({ output }) or, from some adapters, a bare string.
export function runOutputText(run = {}) {
  const r = run && run.result;
  if (r == null) return '';
  if (typeof r === 'string') return r;
  if (typeof r.output === 'string') return r.output;
  return '';
}

// Normalise curly apostrophes so "don’t" matches "don't".
function norm(text) {
  return String(text || '').replace(/[‘’ʼ]/g, "'");
}

// Phrases an agent uses when it turns a ticket down or reports that a re-run
// changed nothing. Matched against the run's final output.
const DECLINE_RE = new RegExp([
  'routed to me again',
  'nothing (?:has )?changed since',
  "(?:i'm |i am |i will |i'll )?(?:not|won't|will not|shouldn't|should not) (?:be )?(?:pick(?:ing)?|tak(?:e|ing)) (?:this|it|the ticket|the issue) up",
  "(?:not|won't|will not|shouldn't|should not) (?:be )?(?:start(?:ing)?|work(?:ing)?) on (?:this|it)",
  'declin(?:e|ed|ing) (?:this|the|to)',
  "(?:don't|do not) pick (?:this|it) up",
  'claimed by (?:the )?(?:founder|operator|a human|someone else)',
  'leaving (?:this|it) (?:alone|untouched|for the (?:founder|operator|owner))',
].join('|'), 'i');

// A completed run that declined the ticket.
export function isDeclinedRun(run, now = Date.now()) {
  if (!run || !classifyRun(run, now).done) return false;
  return DECLINE_RE.test(norm(runOutputText(run)));
}

// Signs that a run delivered something: a PR link, a pushed branch or commit.
const PROGRESS_RE = /github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|\b(?:opened|created|updated|pushed to) (?:a |the )?(?:pr|pull request)\b|\bpushed\b|\bcommit(?:ted)? `?[0-9a-f]{7,40}\b/i;

export function runShowsProgress(run) {
  return PROGRESS_RE.test(runOutputText(run));
}

function runCreatedMs(r) {
  const ms = new Date(r.created_at || r.dispatched_at || r.started_at || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

// Metadata key the router writes when it parks a ticket here. Runs created
// before it are ignored, so a human who moves the ticket back to `todo` gets a
// fresh count instead of an instant re-park.
export const DECLINE_PARKED_AT_KEY = 'assigned_idle_parked_at';
export const DECLINE_PARK_REASON = 'assigned-idle-agent-declined';
export const NO_PROGRESS_PARK_REASON = 'assigned-idle-no-progress';
export const DEFAULT_NO_PROGRESS_RUNS = 3;

// Should the assigned_idle pass stop re-running this ticket? Looks only at the
// current assignee's own runs, newest first, ignoring provider-limit failures
// (they say nothing about the ticket) and runs from before the last park.
// Returns { reason, runs } or null:
//   - assigned-idle-agent-declined: the latest completed run declined it;
//   - assigned-idle-no-progress: the last N completed runs (CAPS.
//     assignedIdleNoProgressRuns, default 3; 0 turns it off) delivered no PR,
//     push or commit, and the ticket is still `todo`, so no status changed.
export function assignedIdleGiveUp(issue = {}, runs = [], cfg = {}, now = Date.now()) {
  const parkedAt = new Date(issue.metadata?.[DECLINE_PARKED_AT_KEY] || 0).getTime() || 0;
  const own = runs
    .filter((r) => !issue.assignee_id || !r.agent_id || r.agent_id === issue.assignee_id)
    .filter((r) => runCreatedMs(r) > parkedAt)
    .filter((r) => !isQuotaFailure(r, now))
    .sort((a, b) => runCreatedMs(b) - runCreatedMs(a));
  const completed = own.filter((r) => classifyRun(r, now).done);
  if (!completed.length) return null;

  // A run that failed on the work after the last completed one is a different
  // problem (zombie / failure handling owns it); only judge completed output.
  if (isDeclinedRun(completed[0], now)) {
    return { reason: DECLINE_PARK_REASON, runs: 1 };
  }

  const n = cfg.CAPS?.assignedIdleNoProgressRuns ?? DEFAULT_NO_PROGRESS_RUNS;
  if (!(n > 0) || completed.length < n) return null;
  const lastN = completed.slice(0, n);
  if (lastN.some(runShowsProgress)) return null;
  return { reason: NO_PROGRESS_PARK_REASON, runs: n };
}

// ---- founder-claimed tickets ----------------------------------------------
// A founder can claim a ticket in its description ("Claimed by <name>, don't
// pick this up"). The dragon autopilot keys this on `founder_claim_markers`;
// Auriga reads the same list as FOUNDER_CLAIM_MARKERS (or founder_claim_markers)
// and also matches "claimed by <name>" for every HUMAN_NAMES entry.
export function founderClaimMarkers(cfg = {}) {
  const explicit = cfg.FOUNDER_CLAIM_MARKERS ?? cfg.founder_claim_markers ?? [];
  const list = Array.isArray(explicit) ? explicit : [explicit];
  const derived = (cfg.HUMAN_NAMES || []).map((n) => `claimed by ${n}`);
  return [...list, ...derived]
    .filter((m) => typeof m === 'string' && m.trim())
    .map((m) => norm(m).trim().toLowerCase());
}

export function isFounderClaimed(issue = {}, cfg = {}) {
  const desc = norm(issue.description).toLowerCase();
  if (!desc) return false;
  return founderClaimMarkers(cfg).some((m) => desc.includes(m));
}
