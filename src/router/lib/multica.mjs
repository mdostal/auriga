// Thin wrapper around the multica CLI with the mandated clean env + profile.
import { execFileSync } from 'node:child_process';

const CLI = process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
const PROFILE = process.env.MULTICA_PROFILE || 'dostal';

// multica `issue list` defaults to 50 and caps at 100 issues per page. The
// router must page through ALL of them (see listIssues) or projects with >50
// issues silently hide their todos behind blocked/in_review items that sort
// first.
const PAGE_LIMIT = 100;

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

// List EVERY issue in a project by paging through the CLI. `issue list` returns
// at most 100 rows per call and signals more via `has_more`; without this loop
// the router only ever saw the first (default-50) page. Projects like Tools
// have 100+ issues whose todo/seed items sort AFTER the blocked/in_review bulk,
// so a single first page reported todoUnassigned ~= 0 and the router routed
// nothing. Paging fixes the board fetch for todo routing AND for the
// inflight/in_progress/zombie accounting that also reads every issue's status.
export function listIssues(projectId) {
  const all = [];
  let offset = 0;
  for (let page = 0; page < 100; page++) {
    const res = run(['issue', 'list', '--project', projectId,
      '--limit', String(PAGE_LIMIT), '--offset', String(offset),
      '--output', 'json']);
    const issues = (res && res.issues) || [];
    for (const i of issues) all.push(i);
    if (!res || !res.has_more || issues.length === 0) break;
    offset += PAGE_LIMIT;
  }
  return all;
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

// Workspace label id -> name map (labels are workspace entities; an issue may
// reference them by id). Used by the planning lane to match seed/planned labels
// by NAME regardless of how the issue JSON encodes its labels.
export function listLabels() {
  const res = run(['label', 'list', '--output', 'json']);
  const arr = Array.isArray(res) ? res : (res && res.labels) || [];
  const map = {};
  for (const l of arr) if (l && l.id) map[l.id] = l.name;
  return map;
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
