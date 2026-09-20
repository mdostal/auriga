// Finds Multica issues that were incorrectly self-blocked by build agents as
// "unplanned top-level seeds" (status: blocked, metadata.blocked_reason
// mentions "unplanned top-level seed") and routes them back to Minerva's
// planning lane by reassigning to minerva-dev, clearing blocked_reason, and
// resetting status to todo.
//
// Usage:
//   node scripts/bulk-reroute-seeds.ts            # dry-run: query + print only
//   node scripts/bulk-reroute-seeds.ts --apply     # actually perform the reroute
//
// Standalone script (not part of src/router's package) — mirrors the thin
// CLI-wrapper pattern from src/router/lib/multica.mjs locally rather than
// importing it.

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const CLI: string = process.env.MULTICA_CLI || '/Users/dostal/.local/bin/multica';
const PROFILE: string = process.env.MULTICA_PROFILE || 'dostal';

const MINERVA_DEV_AGENT_ID = '07208ea2-3d2f-455d-a07c-60ab56c26e5c';
const PAGE_LIMIT = 100;

type IssueMetadata = Record<string, unknown>;

type Issue = {
  id: string;
  identifier: string;
  status: string;
  metadata?: IssueMetadata;
  parent_issue_id?: string | null;
  title: string;
  [key: string]: unknown;
};

type IssueListResponse = {
  has_more: boolean;
  issues: Issue[];
};

type RerouteError = {
  id: string;
  identifier: string;
  error: string;
};

// The three env vars must be UNSET (stale values 404). execFileSync inherits
// process.env, so we delete them from a cloned env instead of `env -u`.
function cleanEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.MULTICA_TOKEN;
  delete e.MULTICA_PAT_TOKEN;
  delete e.MULTICA_WORKSPACE_ID;
  return e;
}

function run(args: string[], { json = true }: { json?: boolean } = {}): any {
  const out = execFileSync(CLI, ['--profile', PROFILE, ...args], {
    env: cleanEnv(),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (!json) return out;
  return out.trim() ? JSON.parse(out) : null;
}

// Pure predicate — no network — kept standalone/exported so it's unit
// testable without hitting the CLI. Case-insensitive substring match on
// "unplanned top-level seed"; guards for missing/non-string blocked_reason.
export function isUnplannedTopLevelSeed(issue: Issue): boolean {
  const reason = issue?.metadata?.blocked_reason;
  if (typeof reason !== 'string') return false;
  return reason.toLowerCase().includes('unplanned top-level seed');
}

// Paginate through ALL blocked issues workspace-wide (no --project filter)
// and filter down to the ones matching the seed-block pattern. Error-tolerant
// per-page would abort the whole scan on a hard CLI failure — that's the
// correct behavior here since pagination is sequential and a failed page
// means we can't trust `has_more` to continue safely.
function findMatchingIssues(): Issue[] {
  const matched: Issue[] = [];
  let offset = 0;
  for (;;) {
    const res: IssueListResponse = run([
      'issue', 'list',
      '--status', 'blocked',
      '--output', 'json',
      '--limit', String(PAGE_LIMIT),
      '--offset', String(offset),
    ]);
    const issues = (res && res.issues) || [];
    for (const issue of issues) {
      if (isUnplannedTopLevelSeed(issue)) matched.push(issue);
    }
    if (!res || !res.has_more || issues.length === 0) break;
    offset += PAGE_LIMIT;
  }
  return matched;
}

// Applies the three recovery mutations to a single issue, in the mandated
// order: reassign -> clear metadata -> set status todo (status-last, since
// that's what fires the agent run and must happen only once everything else
// is already correct).
//
// `runFn` is injectable (defaults to the real `run`) purely so unit tests can
// stub the CLI-calling boundary and assert each call's `{ json }` option
// without shelling out to the real `multica` binary. `multica issue metadata
// delete` and `multica issue status` both default to TABLE output (not JSON)
// when `--output json` isn't passed, so they MUST be called with
// `{ json: false }` — otherwise `run()`'s unconditional `JSON.parse` throws
// on the table text and the remaining mutations in this function never run.
export function rerouteIssue(issue: Issue, runFn: typeof run = run): void {
  runFn(['issue', 'update', issue.id, '--assignee-id', MINERVA_DEV_AGENT_ID, '--output', 'json']);
  runFn(['issue', 'metadata', 'delete', issue.id, '--key', 'blocked_reason'], { json: false });
  runFn(['issue', 'status', issue.id, 'todo'], { json: false });
}

function main(): void {
  const apply = process.argv.includes('--apply');

  const matched = findMatchingIssues();

  console.log(`Found ${matched.length} blocked issue(s) matching "unplanned top-level seed":`);
  for (const issue of matched) {
    console.log(`  ${issue.identifier}  ${issue.title}`);
  }

  const errors: RerouteError[] = [];
  let rerouted = 0;

  if (!apply) {
    console.log('\nDry-run (no --apply passed) — no mutating calls were made.');
  } else {
    console.log('\n--apply passed — rerouting matched issues to minerva-dev...');
    for (const issue of matched) {
      try {
        rerouteIssue(issue);
        rerouted += 1;
        console.log(`  OK    ${issue.identifier} -> reassigned to minerva-dev, blocked_reason cleared, status=todo`);
      } catch (e: any) {
        const message = e && e.message ? e.message : String(e);
        errors.push({ id: issue.id, identifier: issue.identifier, error: message });
        console.log(`  ERROR ${issue.identifier}: ${message}`);
      }
    }
  }

  const summary = {
    matched: matched.length,
    rerouted: apply ? rerouted : 0,
    errors,
    identifiers: matched.map((i) => i.identifier),
  };

  console.log('\nSummary:');
  console.log(JSON.stringify(summary, null, 2));
}

// Only run when executed directly (`node scripts/bulk-reroute-seeds.ts`), not
// when imported (e.g. by the unit test importing isUnplannedTopLevelSeed) —
// otherwise importing this module for testing would fire real CLI calls.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
