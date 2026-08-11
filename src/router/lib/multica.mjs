// Thin wrapper around the multica CLI with the mandated clean env + profile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLI = process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
const PROFILE = process.env.MULTICA_PROFILE || 'dostal';

// Local profile runs must not inherit stale Multica env vars, but agent-task
// dry runs need the task-scoped mat_ token. Keep that token, drop everything
// else that could shadow the profile.
function cleanEnv() {
  const e = { ...process.env };
  const hasTaskToken = typeof e.MULTICA_TOKEN === 'string' && e.MULTICA_TOKEN.startsWith('mat_');
  if (!hasTaskToken) {
    delete e.MULTICA_TOKEN;
    delete e.MULTICA_PAT_TOKEN;
    delete e.MULTICA_WORKSPACE_ID;
  }
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

export function getIssue(identifier) {
  return run(['issue', 'get', identifier, '--output', 'json']);
}

function flattenIssueChildren(res) {
  if (Array.isArray(res)) return res;
  if (!res || typeof res !== 'object') return [];

  const children = [];
  if (Array.isArray(res.unstaged)) children.push(...res.unstaged);
  if (Array.isArray(res.stages)) {
    for (const stage of res.stages) {
      if (Array.isArray(stage)) {
        children.push(...stage);
      } else if (Array.isArray(stage.issues)) {
        children.push(...stage.issues);
      } else if (Array.isArray(stage.children)) {
        children.push(...stage.children);
      }
    }
  }
  return children;
}

export function issueChildren(identifier) {
  const res = run(['issue', 'children', identifier, '--output', 'json']);
  return flattenIssueChildren(res);
}

// All projects in the workspace (used by /api/gaps to diff against cfg.PROJECT_IDS).
export function listAllProjects() {
  const res = run(['project', 'list', '--output', 'json']);
  return Array.isArray(res) ? res : [];
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

export function createIssue({ title, description, projectId, status = 'todo' }) {
  const tmp = path.join(os.tmpdir(), `auriga-create-issue-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, description || '');
  try {
    return run([
      'issue',
      'create',
      '--title',
      title,
      '--description-file',
      tmp,
      '--project',
      projectId,
      '--status',
      status,
      '--output',
      'json',
    ]);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function setIssueMetadata(identifier, key, value) {
  return run(['issue', 'metadata', 'set', identifier, '--key', key, '--value', value, '--type', 'string'], { json: false });
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

// Cross-workspace issue listing — unlike listIssues/listAllIssues above (which
// are scoped to configured projects), this queries the whole workspace board.
export function listWorkspaceIssues({ status, limit = 50, offset = 0 } = {}) {
  const args = ['issue', 'list', '--output', 'json', '--limit', String(limit), '--offset', String(offset)];
  if (status) args.push('--status', status);
  return run(args) || {};
}

export function listAllWorkspaceIssues(status) {
  const all = [];
  const limit = 50;
  let offset = 0;
  const MAX_PAGES = 1000;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = listWorkspaceIssues({ status, limit, offset });
    const issues = (res && res.issues) || [];
    for (const i of issues) all.push(i);
    if (!res || !res.has_more || issues.length === 0) break;
    offset += limit;
  }
  return all;
}

let humanTodoLabelId;

function resolveHumanTodoLabelId() {
  if (humanTodoLabelId) return humanTodoLabelId;
  const labels = run(['label', 'list', '--output', 'json']) || [];
  const match = labels.find((l) => (l.name || '').toLowerCase() === 'human-todo');
  if (!match) throw new Error("label 'human-todo' not found in workspace");
  humanTodoLabelId = match.id;
  return humanTodoLabelId;
}

export function attachHumanTodoLabel(identifier) {
  const labelId = resolveHumanTodoLabelId();
  return run(['issue', 'label', 'add', identifier, labelId], { json: false });
}

export function postComment(identifier, body) {
  const tmp = path.join(os.tmpdir(), `auriga-comment-${identifier}-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, body);
  try {
    return run(['issue', 'comment', 'add', identifier, '--content-file', tmp], { json: false });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Post a comment onto a Multica issue. Best-effort: a comment failure must never
// abort a review dispatch.
export function issueComment(identifier, body) {
  try {
    return postComment(identifier, body);
  } catch (e) {
    process.stderr.write(`issueComment(${identifier}) failed: ${e.message}\n`);
    return null;
  }
}

// ---- PAN-7492: agent list helper ----

export function listAgents() {
  const res = run(['agent', 'list', '--output', 'json']);
  return Array.isArray(res) ? res : [];
}

export function listRuntimes() {
  const res = run(['runtime', 'list', '--output', 'json']);
  return Array.isArray(res) ? res : [];
}
