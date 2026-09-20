// Auriga auto-router configuration.
// Project -> agent-lane map, agent metadata, and caps.
// All IDs verified live against workspace Pantheon (7feca4c9-...).

export const AGENTS = {
  'consus-dev': {
    id: '66b8f66d-27a6-4fe2-b677-ee69b04ff794',
    runtime: 'claude', // claude-sonnet-5 — spare the Claude weekly ceiling
    maxInflight: 1, // sparing: at most one Consus/Claude ticket in flight
    repo: 'mdostal/consus',
  },
  'heimdall-dev': {
    id: 'e56643ab-ec07-4347-a284-221c2f03a62d',
    runtime: 'opencode',
    maxInflight: 3,
    repo: 'mdostal/heimdall',
  },
  'auriga-dev': {
    id: '18d3ce15-3167-46ce-92bd-04e989f5e71d',
    runtime: 'codex', // shares runtime a86c890c with heimdall-dev-codex
    maxInflight: 3,
    repo: 'mdostal/pantheon-orchestrator',
  },
  'auriga-build-codex': {
    id: '8538dabc-078e-44db-8707-fef4cd26615b',
    runtime: 'codex',
    maxInflight: 5,
    repo: 'mdostal/auriga',
  },
  'auriga-build-grok': {
    id: 'c4c688a4-04d9-458d-8e16-6e8df89b2807',
    runtime: 'grok', // own capacity bucket (physical Multica runtime is opencode/xai/grok-4.3)
    maxInflight: 2,
    repo: 'mdostal/auriga',
  },
  'heimdall-dev-codex': {
    id: 'e60c0630-761c-4106-aa39-bb3803336e50',
    runtime: 'codex', // shares runtime a86c890c with auriga-dev
    maxInflight: 3,
    repo: 'mdostal/heimdall',
  },
  // Claude+plugin-hive build lanes (runtime 1d5e9b93, shared with consus-dev).
  // These are the ONLY lanes that can run /hive:execute|review|test — hive-tagged
  // stories (see isHiveStory in lib/core.mjs) must land here, never on codex/opencode.
  'auriga-build': {
    id: 'f8678f39-633f-45ef-9b1d-2ac63425877c',
    runtime: 'claude',
    maxInflight: 2, // sparing, mirrors consus-dev
    repo: 'mdostal/auriga',
  },
  'mnemosyne-dev': {
    id: '4dca0020-27c8-4695-b7c7-a56fc2df2f08',
    runtime: 'claude',
    maxInflight: 2,
    repo: 'mdostal/mnemosyne',
  },
  'votum-dev': {
    id: '94e096ea-d2c1-4084-898c-4174e3285d0d',
    runtime: 'claude',
    maxInflight: 2,
    repo: 'mdostal/votum',
  },
  // NOTE: minerva-dev (07208ea2-...) is intentionally NOT a hive-execute build lane —
  // its live agent instructions are Minerva's *planning* lane only (bin/minerva-plan),
  // not /hive:execute. Do not add it to HIVE_LANE below.
  // Planning lane (not a build agent): un-planned "seed" issues route here
  // instead of a build lane so they get an epic + dependency-tracked stories
  // before any build agent ever sees them (see PAN-6646).
  'minerva-dev': {
    id: '07208ea2-3d2f-455d-a07c-60ab56c26e5c',
    runtime: 'claude-planning', // own runtime bucket; not shared with consus-dev's `claude`
    maxInflight: 3, // mirrors the real agent's max_concurrent_tasks
    repo: null, // planning lane; no fixed target repo — plans land on whichever project the seed belongs to
  },
};

// Per-runtime in-flight ceiling. The Codex runtime is shared by two agents,
// so cap the whole runtime to avoid single-runtime contention collapse.
export const RUNTIME_CAP = {
  claude: 2,
  opencode: 3,
  codex: 4,
  grok: 2,
};

// Project UUID -> title (for logs/lane names).
// ORDER MATTERS: selection scans in this order. Aligned Codex/Opencode lanes
// first (real, meaningful completions), Consus (Claude) LAST so it is drained
// sparingly only after cheaper lanes are saturated.
export const PROJECT_NAMES = {
  'd78a9f5d-8792-45e8-89e0-bd7b916564ca': 'Auriga',        // -> auriga-dev (Codex, aligned repo)
  '8cb0298a-8a45-45c2-8d09-bc219e2d8a82': 'Heimdall',      // -> heimdall-dev(Opencode)+codex (aligned repo)
  '6327fdaf-789e-4290-ab41-1421957b55c6': 'Minerva',       // -> auriga-dev (Codex)
  'd8ecfab4-79bd-4290-8127-290885f01f38': 'Pantheon Core',
  '4f3f2ae9-cb56-4ef7-b731-50f61d79dddb': 'Janus',
  '0f2eeb08-b0d4-49c3-be10-05301b5e0b32': 'Portunus',
  '1759cd74-1723-4dfb-82cf-8b2696bf080b': 'Argus',
  '4fcccf2f-cf19-46e1-a5f0-8303984e423a': 'Vesta',
  '441b73b8-ee09-41fd-b8d2-1e18baa1d8cf': 'Votum',
  'fcdf7fdf-9b87-4c4a-9a4c-e86471a0b2d9': 'Hellsing',
  '66963847-df7e-46e8-b51a-82eebdf82208': 'Stimula',
  'a0b04ced-5ad6-4249-bb1a-115b88c532d7': 'CADEX',
  '6483d6e1-83eb-4c7d-822a-c2844087ff7f': 'Clients Dashboard',
  '6d6a69b1-c279-4664-8da7-79cb067c28eb': 'Personal Dashboard',
  '7dcbb8d1-e53e-4ac4-bfa5-2016c223bd32': 'House Hunting',
  '1001f225-9c42-4b00-b50a-d16cd06fe181': 'Gig Radar',
  '282343e2-b741-4438-bc80-b93c34819a96': 'Consus',        // -> consus-dev (Claude) LAST, sparing
};

// All project IDs the router scans.
export const PROJECT_IDS = ['d78a9f5d-8792-45e8-89e0-bd7b916564ca', '8cb0298a-8a45-45c2-8d09-bc219e2d8a82', '282343e2-b741-4438-bc80-b93c34819a96', 'a0b04ced-5ad6-4249-bb1a-115b88c532d7', 'd8ecfab4-79bd-4290-8127-290885f01f38', 'aeb1033d-4ab9-4da6-b798-8dc569e75cc9', '1001f225-9c42-4b00-b50a-d16cd06fe181']; // Aligned lanes (Auriga/Heimdall/Consus) PLUS Pantheon Core (d8ecfab4): the Consus ideabox drops [idea] seeds here and they must be scanned so the router routes them to the Minerva planning lane (dogfood front-half loop, PAN-6646). Pantheon Core now closes the FULL loop: seeds -> minerva-dev planning, AND the decomposed non-seed child stories Minerva files back INTO this same project -> auriga-build (see PROJECT_LANE[PANTHEON_CORE]). The other unaligned projects still need agents+repos before their tickets do real work

// Project -> ordered candidate agent lanes.
// Aligned lanes (agent repo matches the project) are preferred and listed first.
// "Others" spread across the two Codex agents; Claude used sparingly (Consus only).
const CONSUS = '282343e2-b741-4438-bc80-b93c34819a96';
const HEIMDALL = '8cb0298a-8a45-45c2-8d09-bc219e2d8a82';
const AURIGA = 'd78a9f5d-8792-45e8-89e0-bd7b916564ca';
const MINERVA = '6327fdaf-789e-4290-ab41-1421957b55c6';
const PANTHEON_CORE = 'd8ecfab4-79bd-4290-8127-290885f01f38';
const CADEX = 'a0b04ced-5ad6-4249-bb1a-115b88c532d7';

export const PROJECT_LANE = {
  [CONSUS]: ['consus-dev'], // aligned repo; Claude — sparing
  [HEIMDALL]: ['heimdall-dev', 'heimdall-dev-codex'], // aligned repo (Opencode + Codex)
  [AURIGA]: ['auriga-dev', 'auriga-build-codex', 'auriga-build-grok'], // aligned repo (Codex/Grok builds)
  [MINERVA]: ['auriga-dev', 'auriga-build-codex', 'auriga-build-grok'], // nearest lanes
  // Pantheon Core is the dogfood seed drop (Consus ideabox) AND where Minerva now files the
  // decomposed child stories of those seeds (a seed dropped here yields stories here — see
  // Minerva's fileStoriesToMultica project resolution). Seeds themselves still route to
  // minerva-dev (the isSeed check in core.mjs runs FIRST); this lane applies only to the
  // NON-seed decomposed build-stories. They must never fall back to DEFAULT_LANE (codex/opencode
  // have no plugin-hive and self-block on /hive:execute) — route them to the claude+hive BUILD
  // lane. Minerva's stories are also hive-shaped, so isHiveStory routes most of them via
  // HIVE_LANE anyway; this entry closes the gap for any decomposed story that isn't hive-shaped.
  [PANTHEON_CORE]: ['auriga-build'],
  // CADEX build stories (Minerva-decomposed, hive-shaped) -> claude+hive build lane; never DEFAULT_LANE (codex self-blocks on /hive:execute).
  [CADEX]: ['auriga-build', 'mnemosyne-dev', 'votum-dev'], // full hive lane — CADEX-first, use idle capacity
};

// Fallback lane for every other project: spread across the Codex agents + Grok.
// Applies ONLY to non-hive stories — see HIVE_LANE below for capability-aware override.
export const DEFAULT_LANE = ['auriga-dev', 'heimdall-dev-codex', 'auriga-build-codex', 'auriga-build-grok'];

// Capability-aware override: any story detected as hive-authored (isHiveStory in
// lib/core.mjs — build/implementation/classic-methodology tagged, e.g. a Minerva-planned
// story) routes HERE instead of PROJECT_LANE/DEFAULT_LANE, regardless of project. Codex and
// Opencode runtimes have no plugin-hive install and cannot run /hive:execute|review|test —
// routing a hive story there causes a silent self-block (PAN-6636, PAN-6640, PAN-6646).
export const HIVE_LANE = ['auriga-build', 'mnemosyne-dev', 'votum-dev'];

// KNOWN GAP (found during implementation of p1-router-capability-routing, not fixed here):
// the epic's plan named 8 "unmapped projects" needing PROJECT_LANE entries — Tools, flayr,
// lct, il, ps, hf, analytics, tree — but only "Tools" (aeb1033d-4ab9-4da6-b798-8dc569e75cc9)
// exists as a real Multica project; the other 7 names don't correspond to any project ID in
// this workspace (they read like seed/repo names *within* Tools, per its own description).
// Tools is also not in PROJECT_IDS today (deliberately — see the ALIGNED-ONLY comment above,
// "14 unaligned projects need agents+repos, Mathew AM decision"). Fabricating routing entries
// for non-existent projects would be wrong, and expanding PROJECT_IDS is a separate, already-
// gated decision. Needs reconciliation with Minerva/operator before this part of the epic can
// be completed.

// Tree path -> attached agent lane names or IDs. When an issue carries
// `tree_path`, the router checks the exact path and each ancestor path before
// falling back to PROJECT_LANE / DEFAULT_LANE.
export const TREE_AGENT_ATTACHMENTS = {};

// Back-half verification scans include Pantheon Core without broadening the
// front-half todo dispatch pool. Minerva-planned Pantheon stories can sit in
// in_review here while the aligned-only build router remains conservative.
export const REVIEW_PROJECT_IDS = [...new Set([...PROJECT_IDS, PANTHEON_CORE])];

// Registered Multica squad. Squad assignment routes to its leader,
// auriga-review (c5beb33c-2a6d-4f78-960a-73966f184506), which owns the
// /hive:review + /hive:test + merge/loop-back decision.
export const VERIFY_SQUAD = {
  id: '93d90a37-63e7-4307-9ae3-09db0c0b9bd2',
  name: 'verify-team-squad',
  leaderAgentId: 'c5beb33c-2a6d-4f78-960a-73966f184506',
  maxInflight: 1,
};

// Known human names for the `waiting_on: <human>` priority-1 dispatch filter
// (see isHumanTodo in lib/core.mjs). Matched case-insensitively, substring OK
// (e.g. "Mathew" matches a waiting_on of "Mathew" or "waiting on Mathew").
// Add a name here when a new human-owned ticket needs to route to the human
// queue (scripts/export-human-queue.mjs) instead of an agent lane.
export const HUMAN_NAMES = ['mathew', 'dostal'];

// Workspace member to @mention when a human-todo needs the operator's
// attention (see scripts/bulk-extract-human-todos.mjs notifyOperator).
// Resolved via `multica workspace member list --output json` (user_id field);
// this workspace currently has exactly one human member.
export const HUMAN_OPERATOR_MEMBER_ID = '6506b1e5-08da-452c-81d9-d32e2ca31950'; // dostalmathew, owner

// ---- Model selection routing (src/router/lib/model-selection.mjs) ----

// Task type -> preferred model name (must match a name in the model
// registry, see src/auriga/model-registry.ts). "default" is used for any
// task type not listed here.
export const MODEL_PREFERENCES = {
  'code-generation': 'codex',
  reasoning: 'claude-opus',
  'long-context': 'gemini-2.0',
  vision: 'claude-opus',
  'fast-response': 'claude-sonnet',
  default: 'claude-sonnet',
};

// Model name -> ordered (linear, not parallel best-of-N) list of fallback
// models to try when the preferred model's health check fails.
export const MODEL_FALLBACK_CHAINS = {
  codex: ['claude-sonnet', 'gemini-2.0', 'claude-opus'],
  'claude-opus': ['claude-sonnet', 'gemini-2.0', 'codex'],
  'gemini-2.0': ['claude-sonnet', 'codex', 'claude-opus'],
  'claude-sonnet': ['gemini-2.0', 'codex', 'claude-opus'],
};

// Batch / cadence caps.
export const CAPS = {
  perCyclePerAgent: 4,
  perCycleTotal: 15,
  cycleMs: 75000,
  zombieStaleMs: 20 * 60 * 1000, // 20 min
  assignedIdleStaleMs: 10 * 60 * 1000, // PAN-7492: assigned todo older than this is re-dispatched
  assignedIdlePerCycle: 5, // total recoveries per cycle; per-agent count is capacity-bound (PAN-8244), not a flat 1
  verifyDelayMs: 6000, // wait after assign before checking a run started
  perCycleReview: 1, // BACK-HALF: at most one review/ship dispatch per cycle (sparing on the Claude account)
  perCycleFalseDone: 3, // STATUS TRUTH: at most N wrongly-done->in_review demotions per cycle (never a mass flip)
  perCycleCascade: 5, // CASCADE: at most N completion->dependent enqueues per cycle (bounded self-drain, never a mass fire)
  redispatchCooldownMs: 15 * 60 * 1000, // IDEMPOTENT DISPATCH: never cascade-re-dispatch a story whose last run finished < 15 min ago. A just-completed run (even one that set the story back to blocked) is "already attempted"; re-firing it cancels the fresh run = the 2-min cancel-thrash (PAN-7771).
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
