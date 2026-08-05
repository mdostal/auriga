// Thin wrapper around the multica CLI with the mandated clean env + profile.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

export function listIssues(projectId) {
  const res = run(['issue', 'list', '--project', projectId, '--output', 'json']);
  return (res && res.issues) || [];
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

// Cross-workspace issue listing — unlike listIssues/listAllIssues above (which
// are scoped to the router's deliberately-narrow cfg.PROJECT_IDS "aligned"
// projects), this queries the whole workspace board across every project.
// Used by scripts/bulk-extract-human-todos.mjs, which must sweep the full
// board, not just the 3 aligned projects the live router dispatches into.
export function listWorkspaceIssues({ status, limit = 50, offset = 0 } = {}) {
  const args = ['issue', 'list', '--output', 'json', '--limit', String(limit), '--offset', String(offset)];
  if (status) args.push('--status', status);
  return run(args) || {};
}

// Page through the whole workspace (optionally filtered by status) until
// has_more is false (or a page comes back empty), returning the concatenated
// issues array. Guards against a pathological infinite loop with a hard cap.
export function listAllWorkspaceIssues(status) {
  const all = [];
  const limit = 50;
  let offset = 0;
  const MAX_PAGES = 1000; // safety valve — 50k issues; a real workspace won't hit this
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = listWorkspaceIssues({ status, limit, offset });
    const issues = (res && res.issues) || [];
    for (const i of issues) all.push(i);
    if (!res || !res.has_more || issues.length === 0) break;
    offset += limit;
  }
  return all;
}

let humanTodoLabelId; // memoized — resolved once per process

// `multica issue label add <issue-id> <label-id>` takes the label's workspace
// UUID as a positional arg, not a name, so resolve+cache it via `label list`
// rather than hardcoding an ID that could drift across workspaces.
function resolveHumanTodoLabelId() {
  if (humanTodoLabelId) return humanTodoLabelId;
  const labels = run(['label', 'list', '--output', 'json']) || [];
  const match = labels.find((l) => (l.name || '').toLowerCase() === 'human-todo');
  if (!match) throw new Error("label 'human-todo' not found in workspace — create it with `multica label create` first");
  humanTodoLabelId = match.id;
  return humanTodoLabelId;
}

// Positively exclude an issue from any future agent dispatch scan by tagging
// it with the human-todo label, regardless of which project's router config
// has landed (isHumanTodo in lib/core.mjs checks for exactly this label).
export function attachHumanTodoLabel(identifier) {
  const labelId = resolveHumanTodoLabelId();
  return run(['issue', 'label', 'add', identifier, labelId], { json: false });
}

// Post a comment via a temp file + --content-file, never inline --content:
// inline content lets the shell mangle backticks/`$()`/quotes in the body
// before the CLI ever sees them (same rule build/review agents follow for
// issue comments). Used by scripts/bulk-extract-human-todos.mjs to notify
// the human operator with a real Multica mention (not just console/file
// output, which a human has to remember to go look at).
export function postComment(identifier, body) {
  const tmp = path.join(os.tmpdir(), `auriga-comment-${identifier}-${process.pid}-${Math.random().toString(36).slice(2)}.md`);
  fs.writeFileSync(tmp, body);
  try {
    return run(['issue', 'comment', 'add', identifier, '--content-file', tmp], { json: false });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
