#!/usr/bin/env node
// One-time board pass: unblock the FLOWABLE blocked stories.
//
// Rule (Mathew's ask): a BLOCKED agent story whose dependencies are now satisfied
// AND that has a resolvable target_repo -> move to `todo` so the loop builds it.
// LEAVE blocked the genuinely-need-a-human-decision ones (no repo / ambiguous
// target) — those are decision-list items (memory-plan, janus adapt/rebuild,
// clients-repo, seed-flood triage), not per-ticket unblocks.
//
// Reversible: every flip is written to an audit log (scripts/bulk-unblock-audit.jsonl)
// carrying the FROM status, so it can be rolled back. Non-destructive: only status +
// unassign, never delete/cancel. Dry-run by DEFAULT; pass --apply to actually flip.
// Guards: skips any blocked story that already has an open/merged PR (already in
// flight — never re-dispatch it), and never touches a story with unmet deps.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cfg from '../lib/config.mjs';
import * as core from '../lib/core.mjs';
import * as mca from '../lib/multica.mjs';

const APPLY = process.argv.includes('--apply');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUDIT = path.join(__dirname, 'bulk-unblock-audit.jsonl');

function audit(rec) {
  try { fs.appendFileSync(AUDIT, JSON.stringify({ ts: new Date().toISOString(), ...rec }) + '\n'); } catch {}
}

const ids = mca.listAllProjectIds();
const issues = mca.listAllIssues(ids.length ? ids : cfg.PROJECT_IDS);
const statusById = new Map(issues.map((i) => [i.id, (i.status || '').toLowerCase()]));
const blocked = issues.filter((i) => (i.status || '').toLowerCase() === 'blocked' && !core.isSmokeScratch(i.title));

const unblock = [];
const leaveNoRepo = [];
const depsUnmet = [];
const alreadyInFlight = [];

for (const b of blocked) {
  const depsOk = core.allDepsSatisfied(b, statusById, issues);
  if (!depsOk) { depsUnmet.push(b); continue; }
  const repo = core.normalizeRepoSlug(core.targetRepoValue(b) || '');
  if (!repo) { leaveNoRepo.push(b); continue; }
  // Guard: if the story already has an open/merged PR, it is already in flight —
  // don't re-open it as a fresh todo. (gh, best-effort; a lookup error is non-fatal.)
  let hasPr = false;
  try { hasPr = mca.ghPrs(repo, 'all').some((pr) => core.prMatchesStory(pr, b)); } catch {}
  if (hasPr) { alreadyInFlight.push({ b, repo }); continue; }
  unblock.push({ b, repo });
}

console.log('=== BULK UNBLOCK ' + (APPLY ? '(APPLY)' : '(DRY-RUN)') + ' ===');
console.log('board:', issues.length, 'blocked:', blocked.length);
console.log('-> UNBLOCK (deps ok + resolvable repo + no PR):', unblock.length);
for (const { b, repo } of unblock) console.log('   UNBLOCK', b.identifier, core.storyKey(b) || '-', '[' + repo + ']', '|', (b.title || '').slice(0, 55));
console.log('-> LEAVE blocked — no/ambiguous repo (DECISION items):', leaveNoRepo.length);
for (const b of leaveNoRepo) console.log('   LEAVE  ', b.identifier, core.storyKey(b) || '-', '|', (b.title || '').slice(0, 60));
console.log('-> LEAVE blocked — deps still unmet:', depsUnmet.length);
console.log('-> SKIP — already has a PR (in flight):', alreadyInFlight.length);
for (const { b, repo } of alreadyInFlight) console.log('   SKIP   ', b.identifier, '[' + repo + ']');

if (!APPLY) { console.log('\n(dry-run — pass --apply to flip the UNBLOCK set to todo)'); process.exit(0); }

let done = 0;
for (const { b, repo } of unblock) {
  try {
    audit({ identifier: b.identifier, from: (b.status || 'blocked'), to: 'todo', repo, storyKey: core.storyKey(b) });
    mca.issueStatus(b.identifier, 'todo');
    try { mca.unassignIssue(b.identifier); } catch {}
    done++;
    console.log('APPLIED', b.identifier, '-> todo');
  } catch (e) {
    console.log('ERROR', b.identifier, e.message);
  }
}
console.log('\nunblocked ' + done + '/' + unblock.length + ' — audit: ' + AUDIT);
