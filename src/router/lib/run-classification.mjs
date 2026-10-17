// Run (task/job) execution classification — extracted from core.mjs (t011
// decomposition) as a fully self-contained leaf module: zero dependencies
// on any other core.mjs function. A run is one execution attempt on an
// issue, a separate concern from the issue's own lifecycle status (see
// issue-status.mjs).

// Run (task/job) statuses — a separate vocabulary from ISSUE_STATUS
// (issue-status.mjs). Not yet extracted to a shared constants module — no
// comparison-site duplication of these specific values has been found
// (unlike issue status and PR state), so there's nothing to de-drift yet;
// see the no-pre-emptive-integrations principle.
const ACTIVE_RUN_STATUSES = new Set([
  'running', 'in_progress', 'in progress', 'queued', 'pending', 'dispatched', 'started', 'assigned',
]);
const FAILED_RUN_STATUSES = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled', 'timeout']);

// Classify a single run object.
export function classifyRun(run, now = Date.now()) {
  const status = (run.status || '').toLowerCase();
  const failed = FAILED_RUN_STATUSES.has(status) || (run.error != null && run.error !== '');
  const hasCompleted = !!run.completed_at || status === 'completed' || status === 'done' || status === 'succeeded';
  const active = !failed && !hasCompleted && (ACTIVE_RUN_STATUSES.has(status) || (!run.completed_at && status === ''));
  const ts = run.completed_at || run.started_at || run.dispatched_at || run.created_at;
  const ageMs = ts ? now - new Date(ts).getTime() : Infinity;
  return { active, failed, done: hasCompleted && !failed, ageMs, status };
}

// Run statuses that mean "waiting for a runtime slot", not "executing".
const QUEUED_RUN_STATUSES = new Set(['queued', 'pending']);

// Is this run still waiting in the queue — queued/pending and never picked
// up (no started_at / dispatched_at)? Such a run is behind a saturated
// runtime, not hung: re-enqueueing it only cancels it and loses its place
// (auriga#261, PANT-1154).
export function isQueuedNotStarted(run, now = Date.now()) {
  if (!run || run.started_at || run.dispatched_at) return false;
  const c = classifyRun(run, now);
  return c.active && QUEUED_RUN_STATUSES.has(c.status);
}

// Given an issue's runs (array), is any run currently active AND fresh?
// A run stuck in "running" longer than staleMs is treated as a silent hang
// (not active) so it can be recovered. A run still waiting in the queue
// (isQueuedNotStarted) is measured against queuedStaleMs instead, which
// defaults to staleMs so callers that don't opt in keep the old behavior.
export function hasActiveRun(runs = [], now = Date.now(), staleMs = Infinity, queuedStaleMs = staleMs) {
  return runs.some((r) => {
    const c = classifyRun(r, now);
    if (!c.active) return false;
    return c.ageMs < (isQueuedNotStarted(r, now) ? queuedStaleMs : staleMs);
  });
}

// Latest run by created_at/dispatched_at.
export function latestRun(runs = []) {
  if (!runs.length) return null;
  return [...runs].sort((a, b) => {
    const ta = new Date(a.created_at || a.dispatched_at || 0).getTime();
    const tb = new Date(b.created_at || b.dispatched_at || 0).getTime();
    return tb - ta;
  })[0];
}

// ---- provider quota / limit failures (PANT-1025, GH #254) -----------------
// A run that fails because the provider account is out of quota ("You've hit
// your session limit", usage limit, 429, out_of_credit) says nothing about the
// ticket: re-dispatching it before the limit resets fails the same way. These
// failures are TRANSIENT — they never count toward reviewMaxAttempts or
// zombieMaxAttempts, and the issue waits out the reset instead of re-firing
// every cycle (live: PANT-1019 burned 5 review runs in 7 minutes, then gave up).
const QUOTA_ERROR_RE = /session limit|usage limit|rate[ _-]?limit|quota|out[ _-]of[ _-]credits?|credit balance|too many requests|\b429\b/i;

// The run's error text, or '' when it has none. Multica's JSON may carry a
// literal null; an object error is reduced to its message.
export function runErrorText(run = {}) {
  const e = run.error;
  if (e == null) return '';
  if (typeof e === 'string') return e.trim();
  if (typeof e.message === 'string') return e.message.trim();
  return String(e);
}

// Did this run fail on a provider quota/limit rather than on the work itself?
export function isQuotaFailure(run, now = Date.now()) {
  if (!run || !classifyRun(run, now).failed) return false;
  return QUOTA_ERROR_RE.test(runErrorText(run)) || QUOTA_ERROR_RE.test(String(run.failure_reason || ''));
}

// Runs that count toward an attempt cap: everything except quota failures.
export function countedRuns(runs = [], now = Date.now()) {
  return runs.filter((r) => !isQuotaFailure(r, now));
}

function runTsMs(run) {
  const ts = run.completed_at || run.started_at || run.dispatched_at || run.created_at;
  const ms = ts ? new Date(ts).getTime() : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// When the provider said the limit resets, as epoch ms, or null. Only the UTC
// form Claude prints is parsed ("resets 9:20pm (UTC)"): the first such clock
// time after the failure. Any other wording falls back to the cooldown.
export function quotaResetAtMs(run) {
  const m = /resets\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*\(UTC\)/i.exec(runErrorText(run));
  const failedAt = runTsMs(run);
  if (!m || failedAt == null) return null;
  let hour = Number(m[1]) % 12;
  if (m[3].toLowerCase() === 'pm') hour += 12;
  const reset = new Date(failedAt);
  reset.setUTCHours(hour, Number(m[2] || 0), 0, 0);
  if (reset.getTime() <= failedAt) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset.getTime();
}

// Until when (epoch ms) the issue must not be re-dispatched because its latest
// run hit a provider limit, or 0 when it may be dispatched now. Waits for the
// stated reset when the error gives one, else cooldownMs after the failure.
export function quotaHoldUntilMs(runs = [], now = Date.now(), cooldownMs = 15 * 60 * 1000) {
  const lr = latestRun(runs);
  if (!lr || !isQuotaFailure(lr, now)) return 0;
  const failedAt = runTsMs(lr);
  if (failedAt == null) return 0;
  const until = quotaResetAtMs(lr) ?? failedAt + cooldownMs;
  return until > now ? until : 0;
}

// Output tokens the run produced, or null when the record has no usage.
function outputTokens(run) {
  let usage = run.usage;
  if (typeof usage === 'string') { try { usage = JSON.parse(usage); } catch { return null; } }
  if (!Array.isArray(usage) || !usage.length) return null;
  return usage.reduce((n, u) => n + (Number(u && u.output_tokens) || 0), 0);
}

// What the run records say about why the given runs failed, for a give-up
// comment. { kind: 'hang' } only when every run looks like a startup hang (no
// error text, no output); otherwise { kind: 'error', error, count } quoting the
// newest real error, or { kind: 'unknown' } when there is nothing to quote.
export function diagnoseFailedRuns(runs = []) {
  if (!runs.length) return { kind: 'unknown' };
  const newestFirst = [...runs].sort((a, b) => (runTsMs(b) ?? 0) - (runTsMs(a) ?? 0));
  const withError = newestFirst.filter((r) => runErrorText(r));
  if (withError.length) {
    const error = runErrorText(withError[0]);
    return { kind: 'error', error, count: withError.filter((r) => runErrorText(r) === error).length, total: runs.length };
  }
  const hang = newestFirst.every((r) => !r.result && !outputTokens(r));
  return hang ? { kind: 'hang', total: runs.length } : { kind: 'unknown', total: runs.length };
}
