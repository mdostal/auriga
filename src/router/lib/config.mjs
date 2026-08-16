// Auriga auto-router configuration.
// Project -> agent-lane map, agent metadata, and caps.
// All IDs verified live against workspace Pantheon (7feca4c9-...).
//
// AGENTS/PROJECT_NAMES/PROJECT_IDS moved to ./config-substrate.mjs
// (p2-multica-backlog-adapter — the substrate/policy config split; see
// .pHive/epics/p2-adapter-interface/stories/p2-multica-backlog-adapter.yaml).
// Imported + re-exported here (not just re-exported) because this module
// still MUTATES AGENTS below (adding the 'auriga-review' entry) and reads
// PROJECT_NAMES elsewhere; re-exporting keeps every existing `cfg.AGENTS` /
// `cfg.PROJECT_NAMES` / `cfg.PROJECT_IDS` call site (auriga-router.mjs,
// lib/core.mjs, tests) working unchanged during the split.
import { AGENTS, PROJECT_NAMES, PROJECT_IDS } from './config-substrate.mjs';
export { AGENTS, PROJECT_NAMES, PROJECT_IDS };

// Per-runtime in-flight ceiling. The Codex runtime is shared by two agents,
// so cap the whole runtime to avoid single-runtime contention collapse.
export const RUNTIME_CAP = {
  claude: 2,
  opencode: 3,
  codex: 4,
};

// Project -> ordered candidate agent lanes.
// Aligned lanes (agent repo matches the project) are preferred and listed first.
// "Others" spread across the two Codex agents; Claude used sparingly (Consus only).
const CONSUS = '282343e2-b741-4438-bc80-b93c34819a96';
const HEIMDALL = '8cb0298a-8a45-45c2-8d09-bc219e2d8a82';
const AURIGA = 'd78a9f5d-8792-45e8-89e0-bd7b916564ca';
const MINERVA = '6327fdaf-789e-4290-ab41-1421957b55c6';
const PANTHEON_CORE = 'd8ecfab4-79bd-4290-8127-290885f01f38';

export const PROJECT_LANE = {
  [CONSUS]: ['consus-dev'], // aligned repo; Claude — sparing
  [HEIMDALL]: ['heimdall-dev', 'heimdall-dev-codex'], // aligned repo (Opencode + Codex)
  [AURIGA]: ['auriga-dev'], // aligned repo (Codex)
  [MINERVA]: ['auriga-dev'], // no dedicated agent; nearest Codex lane
  // Pantheon Core is the dogfood seed drop (Consus ideabox) AND where Minerva now files the
  // decomposed child stories of those seeds (a seed dropped here yields stories here — see
  // Minerva's fileStoriesToMultica project resolution). Seeds themselves still route to
  // minerva-dev (the isSeed check in core.mjs runs FIRST); this lane applies only to the
  // NON-seed decomposed build-stories. They must never fall back to DEFAULT_LANE (codex/opencode
  // have no plugin-hive and self-block on /hive:execute) — route them to the claude+hive BUILD
  // lane. Minerva's stories are also hive-shaped, so isHiveStory routes most of them via
  // HIVE_LANE anyway; this entry closes the gap for any decomposed story that isn't hive-shaped.
  [PANTHEON_CORE]: ['auriga-build'],
};

// Fallback lane for every other project: spread across the two Codex agents.
// Applies ONLY to non-hive stories — see HIVE_LANE below for capability-aware override.
export const DEFAULT_LANE = ['auriga-dev', 'heimdall-dev-codex'];

// Capability-aware override: any story detected as hive-authored (isHiveStory in
// lib/core.mjs — build/implementation/classic-methodology tagged, e.g. a Minerva-planned
// story) routes HERE instead of PROJECT_LANE/DEFAULT_LANE, regardless of project. Codex and
// Opencode runtimes have no plugin-hive install and cannot run /hive:execute|review|test —
// routing a hive story there causes a silent self-block (PAN-6636, PAN-6640, PAN-6646).
export const HIVE_LANE = ['auriga-build', 'mnemosyne-dev', 'votum-dev'];

// KNOWN GAP re: PROJECT_LANE not covering all projects (8 named, 7 not real) —
// moved to ./config-substrate.mjs alongside PROJECT_IDS/PROJECT_NAMES, see the
// comment there for the full explanation.

// Known human names for the `waiting_on: <human>` priority-1 dispatch filter
// (see isHumanTodo in lib/core.mjs). Matched case-insensitively, substring OK
// (e.g. "Mathew" matches a waiting_on of "Mathew" or "waiting on Mathew").
// Add a name here when a new human-owned ticket needs to route to the human
// queue (scripts/export-human-queue.mjs) instead of an agent lane.
export const HUMAN_NAMES = ['mathew', 'dostal'];

// Batch / cadence caps.
export const CAPS = {
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

// The review/ship lane: in_review stories with an open PR route here.
export const REVIEW_LANE = ['auriga-review'];

// GitHub owner whose repos the review lane sweeps for open PRs. The router
// discovers ALL of this owner's repos live (mca.ghListRepos) each cycle so a new
// repo (logic-loops, house-finder, ...) is covered the moment it exists, instead
// of waiting to be hand-added to REVIEW_SEARCH_REPOS below. REVIEW_SEARCH_REPOS
// remains the static fallback used only when live discovery returns nothing.
export const REVIEW_REPO_OWNER = 'mdostal';

// Baseline repos the review lane searches for a story's open PR. Multica's
// issue<->PR linkage is empty in practice, so PR discovery goes through gh; the
// router also adds any explicit target_repo it finds on an in_review story, so
// this is just the default set of OUR private plugin repos.
export const REVIEW_SEARCH_REPOS = [
  'mdostal/auriga', 'mdostal/heimdall', 'mdostal/consus',
  'mdostal/pantheon-orchestrator', 'mdostal/mnemosyne', 'mdostal/votum',
  'mdostal/cron-maker',
];

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
export const REVIEW_SQUAD_RULES = {
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
