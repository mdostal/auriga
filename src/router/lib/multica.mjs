// Thin wrapper around the multica CLI with the mandated clean env + profile.
import { execFileSync } from 'node:child_process';

const CLI = process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
const PROFILE = process.env.MULTICA_PROFILE || 'dostal';

// The three env vars must be UNSET (stale values 404). execFileSync inherits
// process.env, so we delete them from a cloned env instead of `env -u`.
function cleanEnv() {
  const e = { ...process.env };
  delete e.MULTICA_TOKEN;
  delete e.MULTICA_PAT_TOKEN;
  delete e.MULTICA_WORKSPACE_ID;
  return e;
}

function run(args, { json = true } = {}) {
  const out = execFileSync(CLI, ['--profile', PROFILE, ...args], {
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!json) return out;
  return out.trim() ? JSON.parse(out) : null;
}

// `multica issue list` caps at --limit (default 50) issues per call. Projects with
// more than a page of issues (Pantheon Core — the seed-flood project) were therefore
// only PARTIALLY scanned: every status pass silently missed the tail of the board
// (PAN-6952 and dozens of others were invisible, so they never advanced). Paginate
// with --offset until a short page is returned so we get EVERY issue in the project.
export function listIssues(projectId, pageSize = 200) {
  const all = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = run(['issue', 'list', '--project', projectId, '--output', 'json',
      '--limit', String(pageSize), '--offset', String(offset)]);
    const page = (res && res.issues) || [];
    for (const i of page) all.push(i);
    if (page.length < pageSize) break; // last (short) page
    if (offset > 100000) break;         // hard safety stop
  }
  return all;
}

// Every project id in the workspace. Used by the board-wide STATUS passes (unblock,
// parent-rollup, false-done, verified-done) which must see the whole board — the
// blocked/done lies live in projects the build DISPATCH set deliberately excludes.
// Returns [] on any error so the caller falls back to the static PROJECT_IDS.
export function listAllProjectIds() {
  try {
    const res = run(['project', 'list', '--output', 'json']);
    const ps = Array.isArray(res) ? res : (res && res.projects) || [];
    return ps.map((p) => p && p.id).filter(Boolean);
  } catch (e) {
    process.stderr.write('listAllProjectIds failed: ' + e.message + '\n');
    return [];
  }
}

export function listAllIssues(projectIds) {
  const all = [];
  for (const p of projectIds) {
    try {
      for (const i of listIssues(p)) all.push(i);
    } catch (e) {
      // one project failing must not abort the whole scan
      process.stderr.write(`listIssues(${p}) failed: ${e.message}\n`);
    }
  }
  return all;
}

export function issueRuns(identifier) {
  try {
    const res = run(['issue', 'runs', identifier, '--output', 'json']);
    return Array.isArray(res) ? res : [];
  } catch (e) {
    process.stderr.write(`issueRuns(${identifier}) failed: ${e.message}\n`);
    return [];
  }
}

export function assignIssue(identifier, agentName) {
  return run(['issue', 'assign', identifier, '--to', agentName, '--output', 'json']);
}

export function rerunIssue(identifier) {
  return run(['issue', 'rerun', identifier, '--output', 'json']);
}

export function issueStatus(identifier, status) {
  return run(['issue', 'status', identifier, status, '--output', 'json']);
}

export function issuePullRequests(identifier) {
  try {
    const res = run(['issue', 'pull-requests', identifier, '--output', 'json']);
    return (res && res.pull_requests) || [];
  } catch (e) {
    process.stderr.write(`issuePullRequests(${identifier}) failed: ${e.message}\n`);
    return [];
  }
}

const GH = process.env.GH_CLI || 'gh';

// Open PRs for a repo via gh, as [{number,title,headRefName,baseRefName,body,url,state}].
// Used by the review lane to discover a story's real open PR: Multica's issue<->PR
// linkage is empty in practice, and the feat/<id> branch convention is too narrow.
export function ghOpenPrs(repo) {
  try {
    const out = execFileSync(GH, [
      'pr', 'list', '--repo', repo, '--state', 'open',
      '--json', 'number,title,headRefName,baseRefName,body,url,state', '--limit', '100',
    ], { env: cleanEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const arr = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    process.stderr.write('ghOpenPrs(' + repo + ') failed: ' + e.message + '\n');
    return [];
  }
}

// Every repo slug for an owner via `gh repo list`, as ['owner/name', ...]. Lets the
// review lane sweep ALL of the owner's repos for open PRs — not just a hardcoded
// subset (logic-loops PR#1 sat forever because its repo was not in the static list).
// Returns [] on any error so the caller falls back to REVIEW_SEARCH_REPOS.
export function ghListRepos(owner, limit = 300) {
  try {
    const out = execFileSync(GH, [
      'repo', 'list', owner, '--no-archived', '--limit', String(limit), '--json', 'nameWithOwner',
    ], { env: cleanEnv(), encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const arr = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(arr) ? arr.map((r) => r && r.nameWithOwner).filter(Boolean) : [];
  } catch (e) {
    process.stderr.write('ghListRepos(' + owner + ') failed: ' + e.message + '\n');
    return [];
  }
}

// Remove an issue's current assignee. Used by the blocked->todo auto-unblock pass
// so a freshly-unblocked story re-enters build routing as an UNASSIGNED candidate
// (selectAssignments only considers unassigned todos), instead of keeping its
// stale plan-time assignee which would exclude it from the candidate pool.
export function unassignIssue(identifier) {
  return run(['issue', 'assign', identifier, '--unassign', '--output', 'json']);
}

// All PRs (any state) for a repo, as [{number,title,headRefName,baseRefName,body,url,state,mergedAt}].
// Used by the blocked->todo unblock guard: a story that already has an OPEN or
// MERGED PR referencing it has progressed past build (in review / shipped) and
// must NOT be re-dispatched — even though a stale/failed run from earlier churn
// would (wrongly) make a runs-based guard skip it.
export function ghPrs(repo, state = 'all') {
  try {
    const out = execFileSync(GH, [
      'pr', 'list', '--repo', repo, '--state', state,
      '--json', 'number,title,headRefName,baseRefName,body,url,state,mergedAt', '--limit', '100',
    ], { env: cleanEnv(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    const arr = out.trim() ? JSON.parse(out) : [];
    return Array.isArray(arr) ? arr : [];
  } catch (e) {
    process.stderr.write('ghPrs(' + repo + ') failed: ' + e.message + '\n');
    return [];
  }
}

// Post a comment onto a Multica issue (used to publish the review-squad plan onto
// the ticket at dispatch time so it is visible on the board + read by the squad
// agent). Best-effort: a comment failure must never abort a review dispatch.
export function issueComment(identifier, body) {
  try {
    return run(['issue', 'comment', identifier, '--body', body, '--output', 'json']);
  } catch (e) {
    process.stderr.write(`issueComment(${identifier}) failed: ${e.message}\n`);
    return null;
  }
}
