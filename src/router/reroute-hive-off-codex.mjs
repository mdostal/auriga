#!/usr/bin/env node
// One-shot remediation sweep (reusable): reassign hive-methodology stories that are
// currently mis-assigned to a NON-hive-capable lane (codex/opencode) onto the correct
// Claude+plugin-hive lane. Codex/opencode runtimes have no plugin-hive, so those lanes
// self-block on /hive:execute|review|test — a hive story parked on them can never build.
//
// Auriga's live routing (HIVE_LANE) already prevents NEW mis-routes; this sweep corrects
// the LEGACY backlog seeded before that guard / assigned by the planner. It only rewrites
// the ASSIGNEE (a story's status is untouched — a blocked story stays blocked, just on the
// right lane), so it never starts a run and is fully reversible from the emitted log.
//
// Usage:
//   node reroute-hive-off-codex.mjs            # dry-run: print what WOULD change
//   node reroute-hive-off-codex.mjs --apply    # execute the reassignments
//   node reroute-hive-off-codex.mjs --apply --status todo,blocked
//
// Every mutation is appended to /tmp/auriga-reroute-hive.jsonl as
//   {ts, identifier, from_assignee, to_agent, status, target_repo}
// so it can be audited / reverted (reassign back to from_assignee).

import fs from 'node:fs';
import * as cfg from './lib/config.mjs';
import * as core from './lib/core.mjs';
import * as mca from './lib/multica.mjs';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const si = args.indexOf('--status');
const STATUSES = new Set((si >= 0 && args[si + 1] ? args[si + 1] : 'todo,blocked').split(',').map((s) => s.trim().toLowerCase()));
const LOG = process.env.REROUTE_LOG || '/tmp/auriga-reroute-hive.jsonl';

// Hive-capable lane agent ids (may hold a hive story).
const capable = new Set();
for (const n of [...(cfg.HIVE_LANE || []), ...(cfg.REVIEW_LANE || [])]) {
  const a = cfg.AGENTS[n]; if (a) capable.add(a.id);
}

// Pick the correct hive lane for a story: the aligned lane when its target_repo
// matches a hive lane's repo (mnemosyne->mnemosyne-dev, votum->votum-dev), else the
// canonical build lane (auriga-build). The story's actual build repo is driven by its
// own target_repo, so auriga-build is a safe default.
function laneFor(issue) {
  const repo = core.normalizeRepoSlug(core.targetRepoValue(issue) || '');
  if (repo) {
    for (const n of cfg.HIVE_LANE) {
      const a = cfg.AGENTS[n];
      if (a && a.repo && core.normalizeRepoSlug(a.repo) === repo) return n;
    }
  }
  return cfg.HIVE_LANE[0] || 'auriga-build';
}

const scanIds = (() => {
  const all = mca.listAllProjectIds();
  return [...new Set([...(all.length ? all : cfg.PROJECT_IDS), ...cfg.PROJECT_IDS])];
})();

const issues = mca.listAllIssues(scanIds);
let scanned = 0, changed = 0;
const byLane = {};
for (const i of issues) {
  const st = (i.status || '').toLowerCase();
  if (!STATUSES.has(st)) continue;
  if (!i.assignee_id) continue;
  if (capable.has(i.assignee_id)) continue;      // already on a hive lane
  if (!core.isHiveStory(i)) continue;            // only hive-methodology stories
  if (core.isSmokeScratch(i.title)) continue;
  scanned++;
  const target = laneFor(i);
  byLane[target] = (byLane[target] || 0) + 1;
  const rec = {
    ts: new Date().toISOString(), identifier: i.identifier, from_assignee: i.assignee_id,
    to_agent: target, status: st, target_repo: core.targetRepoValue(i) || null,
  };
  console.log((APPLY ? 'REASSIGN ' : 'WOULD    ') + i.identifier + '  ' + st.padEnd(8) + '  -> ' + target + '   ' + (i.title || '').slice(0, 48));
  if (APPLY) {
    try {
      mca.assignIssue(i.identifier, target);
      fs.appendFileSync(LOG, JSON.stringify(rec) + '\n');
      changed++;
    } catch (e) {
      console.error('  FAILED ' + i.identifier + ': ' + e.message);
    }
  }
}
console.log('\n' + (APPLY ? 'reassigned' : 'would reassign') + ' ' + (APPLY ? changed : scanned) + ' hive-on-codex stories (statuses: ' + [...STATUSES].join(',') + ')');
console.log('by target lane:', JSON.stringify(byLane));
if (APPLY) console.log('audit log:', LOG);
