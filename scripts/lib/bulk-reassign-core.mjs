// Pure decision logic for scripts/bulk-reassign-codex-blocked.mjs (p1-triage-bulk-reassign).
// No live calls here — everything is deterministic and unit-tested with fixture issues.

// Runtime `codex` agent IDs whose runtime has no callable /hive:execute|review|test —
// stories that self-block for that reason are the reassignment target.
export const CODEX_AGENT_IDS = new Set([
  '18d3ce15-3167-46ce-92bd-04e989f5e71d', // auriga-dev
  'e60c0630-761c-4106-aa39-bb3803336e50', // heimdall-dev-codex
]);

// Aligned claude+plugin-hive build lanes, keyed by the repo each is scoped to.
// Mirrors AGENTS in src/router/lib/config.mjs on the (not yet merged, PAN-6658)
// feat/pan-6658-router-capability-routing branch — duplicated here rather than
// imported so this script doesn't depend on unmerged code. Reconcile/import
// from config.mjs once that branch lands on main.
export const REPO_LANE_AGENTS = {
  'mdostal/auriga': { lane: 'auriga-build', agentId: 'f8678f39-633f-45ef-9b1d-2ac63425877c' },
  'mdostal/mnemosyne': { lane: 'mnemosyne-dev', agentId: '4dca0020-27c8-4695-b7c7-a56fc2df2f08' },
  'mdostal/votum': { lane: 'votum-dev', agentId: '94e096ea-d2c1-4084-898c-4174e3285d0d' },
};

// Does this blocked_reason describe a codex-runtime self-block on plugin-hive
// unavailability (as opposed to an unrelated block: dependency wait, human-todo,
// repo not provisioned, routing mismatch already flagged, etc.)?
export function mentionsHiveUnavailable(reason = '') {
  const r = reason.toLowerCase();
  const hive = r.includes('plugin-hive') || r.includes('hive:execute') || (r.includes('hive') && r.includes('execute'));
  const unavailable = [
    'unavailable', 'not configured', 'absent', 'no callable', 'no hive command',
    'not present', 'no plugin-hive tool', 'cannot run this story directly',
  ].some((k) => r.includes(k));
  return hive && unavailable;
}

// A codex-self-block candidate: assigned to a codex-runtime agent AND blocked
// for plugin-hive-unavailable reasons.
export function isCodexSelfBlocked(issue, codexAgentIds = CODEX_AGENT_IDS) {
  if (issue.status !== 'blocked') return false;
  if (!codexAgentIds.has(issue.assignee_id)) return false;
  return mentionsHiveUnavailable(issue.metadata?.blocked_reason || '');
}

// Every `mdostal/<repo>` mention across title + description — the story's own
// spec, which is the only reliable signal of its real implementation target.
//
// Deliberately EXCLUDES blocked_reason: that text lists repos a prior agent
// *tried and failed* to check out (often several, including its own default
// repo), not necessarily the story's actual target. Resolving off blocked_reason
// produced a false positive in testing — PAN-6499 (a Vault panel UI story whose
// real target is mdostal/clients) was reassigned to auriga-build only because
// its blocked_reason happened to also name-drop "mdostal/auriga repos not
// configured for checkout" alongside the real target.
export function extractRepoMentions(issue) {
  const text = `${issue.title || ''} ${issue.description || ''}`.toLowerCase();
  const found = text.match(/mdostal\/[a-z0-9_-]+/g) || [];
  return [...new Set(found)];
}

// Resolve the single unambiguous aligned hive lane for an issue, or null when
// no aligned lane exists for its target repo(s) yet (needs-agent case) or the
// mentions are ambiguous across more than one *aligned* repo.
export function resolveHiveLane(issue, repoLaneAgents = REPO_LANE_AGENTS) {
  const mentions = extractRepoMentions(issue);
  const aligned = mentions.filter((repo) => repoLaneAgents[repo]);
  if (aligned.length !== 1) return null;
  return repoLaneAgents[aligned[0]];
}

// Decide what to do with one blocked issue. Returns null for non-candidates
// (not a codex self-block) so callers can filter with .filter(Boolean).
export function planReassignment(issue, opts = {}) {
  const { codexAgentIds = CODEX_AGENT_IDS, repoLaneAgents = REPO_LANE_AGENTS } = opts;
  if (!isCodexSelfBlocked(issue, codexAgentIds)) return null;

  const lane = resolveHiveLane(issue, repoLaneAgents);
  if (lane) {
    return {
      issueId: issue.id,
      identifier: issue.identifier,
      action: 'reassign',
      lane: lane.lane,
      agentId: lane.agentId,
    };
  }

  const mentions = extractRepoMentions(issue);
  const repoNote = mentions.length ? mentions.join(', ') : 'no target repo identified';
  return {
    issueId: issue.id,
    identifier: issue.identifier,
    action: 'needs-agent',
    reason: `needs-agent: no claude+hive lane provisioned for ${repoNote}`,
  };
}

// Plan the full batch. Returns { decisions, summary } — decisions excludes
// non-candidates; summary counts by action so a dry-run can be reported without
// re-deriving counts from the array every time.
export function planBulk(issues, opts = {}) {
  const decisions = issues.map((i) => planReassignment(i, opts)).filter(Boolean);
  const summary = decisions.reduce(
    (acc, d) => {
      acc[d.action] = (acc[d.action] || 0) + 1;
      return acc;
    },
    { reassign: 0, 'needs-agent': 0 },
  );
  return { decisions, summary };
}
