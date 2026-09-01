// Auriga auto-router configuration.
// Project -> agent-lane map, agent metadata, and caps.
// All IDs verified live against workspace Pantheon (7feca4c9-...).
//
// AURIGA_CONFIG: optional path to a partial JSON override file (PANT-70). Any
// key present in the file replaces the corresponding export; absent keys keep
// their defaults. config-substrate.mjs handles substrate keys (AGENTS, lanes,
// etc.); this file handles policy keys (CAPS, HUMAN_NAMES, REVIEW_SQUAD_RULES).
//
// AGENTS/PROJECT_NAMES/PROJECT_IDS moved to ./config-substrate.mjs
// (p2-multica-backlog-adapter — the substrate/policy config split; see
// .pHive/epics/p2-adapter-interface/stories/p2-multica-backlog-adapter.yaml).
// RUNTIME_CAP/PROJECT_LANE/DEFAULT_LANE/HIVE_LANE/REVIEW_LANE/
// REVIEW_REPO_OWNER/REVIEW_SEARCH_REPOS moved there too, completing that
// split (p2-multica-spawn-adapter). Imported + re-exported here (not just
// re-exported) because this module still MUTATES AGENTS and RUNTIME_CAP
// below (adding the 'auriga-review' agent + its runtime-cap bucket) and
// reads PROJECT_NAMES elsewhere; re-exporting keeps every existing
// `cfg.AGENTS` / `cfg.PROJECT_NAMES` / `cfg.PROJECT_IDS` / `cfg.RUNTIME_CAP` /
// `cfg.PROJECT_LANE` / `cfg.DEFAULT_LANE` / `cfg.HIVE_LANE` / `cfg.REVIEW_LANE` /
// `cfg.REVIEW_REPO_OWNER` / `cfg.REVIEW_SEARCH_REPOS` call site
// (auriga-router.mjs, tests, scripts) working unchanged during the split.
import {
  AGENTS, PROJECT_NAMES, PROJECT_IDS,
  RUNTIME_CAP, PROJECT_LANE, DEFAULT_LANE, HIVE_LANE,
  REVIEW_LANE, REVIEW_REPO_OWNER, REVIEW_SEARCH_REPOS,
} from './config-substrate.mjs';
import { loadExternalConfig } from './config-loader.mjs';
const _ext = loadExternalConfig();
export {
  AGENTS, PROJECT_NAMES, PROJECT_IDS,
  RUNTIME_CAP, PROJECT_LANE, DEFAULT_LANE, HIVE_LANE,
  REVIEW_LANE, REVIEW_REPO_OWNER, REVIEW_SEARCH_REPOS,
};

// Known human names for the `waiting_on: <human>` priority-1 dispatch filter
// (see isHumanTodo in lib/core.mjs). Matched case-insensitively, substring OK
// (e.g. "Mathew" matches a waiting_on of "Mathew" or "waiting on Mathew").
// Add a name here when a new human-owned ticket needs to route to the human
// queue (scripts/export-human-queue.mjs) instead of an agent lane.
export const HUMAN_NAMES = _ext.HUMAN_NAMES ?? ['mathew', 'dostal'];

// Batch / cadence caps.
export const CAPS = _ext.CAPS ?? {
  perCyclePerAgent: 2, // never mass-flip
  perCycleTotal: 5,
  cycleMs: 75000,
  zombieStaleMs: 20 * 60 * 1000, // 20 min
  verifyDelayMs: 6000, // wait after assign before checking a run started
  perCycleReview: 1, // BACK-HALF: at most one review/ship dispatch per cycle (sparing on the Claude account)
  perCycleFalseDone: 3, // STATUS TRUTH: at most N wrongly-done->in_review demotions per cycle (never a mass flip)
  perCycleCascade: 5, // CASCADE: at most N completion->dependent enqueues per cycle (bounded self-drain, never a mass fire)
};

// ============================================================================
// BACK-HALF OF THE LOOP: review / ship lane (2026-07-31)
// ----------------------------------------------------------------------------
// The front half works: a planned story builds, opens a PR, and auto-advances
// in_progress -> in_review (detectRunCompletions). But nothing then REVIEWS,
// TESTS, and MERGES that PR — so a ticket stalls at in_review forever. This lane
// closes that gap: an in_review story with an open PR is dispatched to a
// dedicated Claude+plugin-hive REVIEW agent that runs /hive:review + /hive:test
// on the PR branch, then either merges to dev + sets the story done, or comments
// the required changes + sends the story back to todo (the loop-back).
//
// The review agent MUST be on the Claude runtime (1d5e9b93) because only Claude
// agents have plugin-hive (/hive:review, /hive:test) — codex/opencode do not.
// In the router's capacity model it gets its OWN runtime bucket ('claude-review',
// same pattern as minerva-dev's 'claude-planning') so review dispatch is accounted
// separately and does not fight the build lanes for the claude RUNTIME_CAP slots.
// It is deliberately capped tight (maxInflight 1 + perCycleReview 1) because it
// physically shares the one Claude account (account usage is the real ceiling).
AGENTS['auriga-review'] = {
  id: 'c5beb33c-2a6d-4f78-960a-73966f184506', // filled in from `multica agent create` (Claude runtime, plugin-hive)
  runtime: 'claude-review',  // own capacity bucket; physical Multica runtime is Claude (1d5e9b93)
  maxInflight: 1,            // one review/ship at a time — sparing on the Claude account
  repo: null,               // target_repo-driven, exactly like the build lane
};

RUNTIME_CAP['claude-review'] = 1;

// REVIEW_LANE/REVIEW_REPO_OWNER/REVIEW_SEARCH_REPOS themselves now live in
// ./config-substrate.mjs (imported + re-exported above) — see that file for
// their values and doc comments.

// ============================================================================
// REVIEW SQUAD RULES — scale-by-ticket-type (2026-07-31, PAN-6546).
// ----------------------------------------------------------------------------
// The EXPLICIT, INSPECTABLE rule the review lane uses to size the squad for a
// ticket. core.reviewSquadPlan(issue, cfg) reads this; the router logs the
// resulting plan and posts it onto the ticket, so what the squad will do is
// always visible up front. Edit the keyword lists / tier map here to change how
// tickets are sized — no code change needed.
//
// The four perspectives (Mathew's binding words): product (PO — does it satisfy
// the story's intent?), technical (correctness/conventions/security via
// /hive:review), qa (author + RUN tests + real build + Playwright/E2E — TRUE
// verification), ux (user-facing quality + accessibility via design-review).
//
// Sizing posture: the DEFAULT is the full four ("each and every ticket"). We
// only DROP a perspective on a CLEAR signal it is inapplicable — UX on a
// headless backend change, product+UX on a docs/chore change. Every drop is
// logged with its reason.
export const REVIEW_SQUAD_RULES = _ext.REVIEW_SQUAD_RULES ?? {
  // USER-FACING signals -> tier 'full' (product + technical + qa + ux, Playwright ON).
  ui: [
    'ui', 'ux', 'user-facing', 'frontend', 'front-end', 'page', 'screen', 'view',
    'component', 'dashboard', 'portal', 'css', 'tailwind', 'react', 'svelte', 'vue',
    'html', 'button', 'form', 'modal', 'layout', 'nav', 'menu', 'visual', 'design',
    'accessibility', 'a11y', 'responsive', 'animation', 'theme', 'styling', 'playwright',
  ],
  // HEADLESS backend signals -> tier 'backend' (product + technical + qa, NO ux).
  backend: [
    'api', 'endpoint', 'route', 'server', 'service', 'daemon', 'worker', 'schema',
    'model', 'database', 'migration', 'sql', 'query', 'integration', 'pipeline',
    'router', 'dispatch', 'auth', 'token', 'webhook', 'cron', 'queue', 'cli', 'sdk',
  ],
  // DOCS / CHORE / CONFIG signals -> tier 'light' (technical + qa-smoke only).
  light: [
    'docs', 'documentation', 'readme', 'comment', 'typo', 'rename', 'chore',
    'bump', 'version bump', 'lint', 'formatting', 'format', 'whitespace',
    'config', 'gitignore', 'license', 'changelog',
  ],
  // tier -> which perspectives run + whether QA must drive a real browser (Playwright).
  tiers: {
    full:     { product: true,  technical: true, qa: true, ux: true,  playwright: true },
    backend:  { product: true,  technical: true, qa: true, ux: false, playwright: false },
    light:    { product: false, technical: true, qa: true, ux: false, playwright: false },
    standard: { product: true,  technical: true, qa: true, ux: true,  playwright: true },
  },
};
