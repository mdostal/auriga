#!/usr/bin/env node
// Bulk-reassign codex-self-blocked build stories to claude+plugin-hive lanes (p1-triage-bulk-reassign).
//
// Usage:
//   node scripts/bulk-reassign-codex-blocked.mjs            # dry run, prints the plan
//   node scripts/bulk-reassign-codex-blocked.mjs --apply     # executes it
//   node scripts/bulk-reassign-codex-blocked.mjs --apply --only <issue-id>   # single-issue proof run
//
// Proof-then-bulk: run with --only against ONE issue first, verify the reassigned
// lane actually reaches `done`, then re-run without --only for the rest.
import { execFileSync } from 'node:child_process';
import { planBulk } from './lib/bulk-reassign-core.mjs';

function runCli(args) {
  return execFileSync('multica', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function fetchBlockedIssues() {
  const issues = [];
  let offset = 0;
  const limit = 100;
  for (;;) {
    const out = runCli(['issue', 'list', '--status', 'blocked', '--output', 'json', '--limit', String(limit), '--offset', String(offset)]);
    const page = JSON.parse(out);
    issues.push(...page.issues);
    if (!page.has_more) break;
    offset += limit;
  }
  return issues;
}

function applyReassign(decision) {
  runCli(['issue', 'update', decision.issueId, '--assignee-id', decision.agentId]);
  runCli(['issue', 'status', decision.issueId, 'todo']);
  runCli(['issue', 'metadata', 'delete', decision.issueId, '--key', 'blocked_reason']);
}

function applyNeedsAgent(decision, currentReason) {
  if (currentReason === decision.reason) return; // idempotent: already tagged
  runCli(['issue', 'metadata', 'set', decision.issueId, '--key', 'blocked_reason', '--value', decision.reason]);
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const onlyIdx = args.indexOf('--only');
  const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

  const issues = fetchBlockedIssues();
  const byId = new Map(issues.map((i) => [i.id, i]));
  const { decisions, summary } = planBulk(only ? issues.filter((i) => i.id === only) : issues);

  console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', only, summary, decisions }, null, 2));

  if (!apply) {
    console.log('\nDry run only — no changes made. Re-run with --apply to execute.');
    return;
  }

  for (const decision of decisions) {
    if (decision.action === 'reassign') {
      applyReassign(decision);
      console.log(`reassigned ${decision.identifier} -> ${decision.lane}, status reset to todo`);
    } else if (decision.action === 'needs-agent') {
      const currentReason = byId.get(decision.issueId)?.metadata?.blocked_reason;
      applyNeedsAgent(decision, currentReason);
      console.log(`${decision.identifier} left blocked: ${decision.reason}`);
    }
  }
}

main();
