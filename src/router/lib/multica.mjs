// Thin wrapper around the multica CLI with the mandated clean env + profile.
import { execFileSync } from 'node:child_process';

const CLI = process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
const PROFILE = process.env.MULTICA_PROFILE || 'dostal';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Stale Multica env vars can 404. Preserve daemon-provided task tokens and
// UUID workspace IDs, but drop non-task tokens and malformed workspace values.
function cleanEnv() {
  const e = { ...process.env };
  if (!e.MULTICA_TOKEN?.startsWith('mat_')) delete e.MULTICA_TOKEN;
  delete e.MULTICA_PAT_TOKEN;
  if (!UUID_RE.test(e.MULTICA_WORKSPACE_ID || '')) delete e.MULTICA_WORKSPACE_ID;
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

export function setIssueStatus(identifier, status) {
  return run(['issue', 'status', identifier, status, '--output', 'json']);
}

export function setIssueMetadata(identifier, key, value, type = 'string') {
  return run(['issue', 'metadata', 'set', identifier, '--key', key, '--value', value, '--type', type, '--output', 'json']);
}

export function rerunIssue(identifier) {
  return run(['issue', 'rerun', identifier, '--output', 'json']);
}
