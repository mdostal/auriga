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
  'heimdall-dev-codex': {
    id: 'e60c0630-761c-4106-aa39-bb3803336e50',
    runtime: 'codex', // shares runtime a86c890c with auriga-dev
    maxInflight: 3,
    repo: 'mdostal/heimdall',
  },
  // PLANNING lane agent. Runs plugin-hive kickoff+plan headlessly (via
  // `minerva-plan`) on an assigned SEED ticket and files dependency-ordered
  // PLANNED stories back as sub-issues. Plans only — it never builds. Claude
  // runtime, so drained sparingly (maxInflight 1) like consus-dev.
  'minerva-dev': {
    id: '07208ea2-3d2f-455d-a07c-60ab56c26e5c',
    runtime: 'claude', // claude-sonnet-5 — spare the Claude weekly ceiling
    maxInflight: 1, // sparing: at most one planning run in flight
    repo: 'mdostal/minerva',
    role: 'planning',
  },
};

// Per-runtime in-flight ceiling. The Codex runtime is shared by two agents,
// so cap the whole runtime to avoid single-runtime contention collapse.
export const RUNTIME_CAP = {
  claude: 2,
  opencode: 3,
  codex: 4,
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
export const PROJECT_IDS = ['d78a9f5d-8792-45e8-89e0-bd7b916564ca', '8cb0298a-8a45-45c2-8d09-bc219e2d8a82', '282343e2-b741-4438-bc80-b93c34819a96']; // ALIGNED-ONLY overnight (Auriga/Heimdall/Consus); the 14 unaligned projects need agents+repos (Mathew AM decision) before their tickets do real work

// Project -> ordered candidate agent lanes.
// Aligned lanes (agent repo matches the project) are preferred and listed first.
// "Others" spread across the two Codex agents; Claude used sparingly (Consus only).
const CONSUS = '282343e2-b741-4438-bc80-b93c34819a96';
const HEIMDALL = '8cb0298a-8a45-45c2-8d09-bc219e2d8a82';
const AURIGA = 'd78a9f5d-8792-45e8-89e0-bd7b916564ca';
const MINERVA = '6327fdaf-789e-4290-ab41-1421957b55c6';

export const PROJECT_LANE = {
  [CONSUS]: ['consus-dev'], // aligned repo; Claude — sparing
  [HEIMDALL]: ['heimdall-dev', 'heimdall-dev-codex'], // aligned repo (Opencode + Codex)
  [AURIGA]: ['auriga-dev'], // aligned repo (Codex)
  [MINERVA]: ['auriga-dev'], // no dedicated agent; nearest Codex lane
};

// Fallback lane for every other project: spread across the two Codex agents.
export const DEFAULT_LANE = ['auriga-dev', 'heimdall-dev-codex'];

// Batch / cadence caps.
export const CAPS = {
  perCyclePerAgent: 2, // never mass-flip
  perCycleTotal: 5,
  cycleMs: 75000,
  zombieStaleMs: 20 * 60 * 1000, // 20 min
  verifyDelayMs: 6000, // wait after assign before checking a run started
};

// PLANNING LANE config. A raw/un-planned ticket is a SEED; the router routes it
// to `agent` (minerva-dev), which runs plugin-hive kickoff+plan and files the
// PLANNED stories back as sub-issues. Only those stories then reach a dev BUILD
// lane (where the dev agent runs plugin-hive /hive:execute + /hive:review +
// /hive:test). See lib/planning.mjs for the full convention + heuristics.
//
//   seedLabels    a top-level ticket carrying one of these names is a SEED.
//   plannedLabels a ticket carrying one of these is a planned epic/story marker.
//   seedFallback  when true, an UNMARKED childless top-level ticket is also
//                 treated as a seed. Default FALSE so the running dev board is
//                 never hijacked — only explicitly-marked seeds get planned.
//   maxPerCycle   at most this many seeds routed to planning per cycle (Claude
//                 runtime is sparing).
export const PLANNING = {
  agent: 'minerva-dev',
  seedLabels: ['idea', 'needs-plan', 'consus-idea'],
  plannedLabels: ['planned', 'epic', 'story'],
  seedFallback: false,
  maxPerCycle: 1,
};
