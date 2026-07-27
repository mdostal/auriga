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
  // PLANNED stories back as sub-issues. Plans only — it never builds.
  // PARALLEL PLANNING (2026-07-27): maxInflight raised 1->3 so multiple queued
  // seeds plan CONCURRENTLY instead of serially behind one plan. This is safe on
  // the single claude runtime because the daemon runs each task in its OWN git
  // worktree + workdir (branch agent/minerva-dev/<task-id>) and minerva-dev's
  // daemon-side max_concurrent_tasks is already 4 (global daemon cap 10). Bounded
  // by RUNTIME_CAP.claude below and PLANNING.maxPerCycle — account usage is the
  // real ceiling, so 3 concurrent plans is the deliberate cap (not more).
  'minerva-dev': {
    id: '07208ea2-3d2f-455d-a07c-60ab56c26e5c',
    runtime: 'claude', // claude-sonnet-5 — spare the Claude weekly ceiling
    maxInflight: 3, // parallel planning: up to 3 concurrent plans (see block comment)
    repo: 'mdostal/minerva',
    role: 'planning',
  },
  // ALIGNED build lane for Mnemosyne (memory god). Claude runtime; clones
  // mdostal/mnemosyne from the Mnemosyne project resource. Runs plugin-hive
  // /hive:execute + review + test on PLANNED stories, pushes feat/* branches.
  'mnemosyne-dev': {
    id: '4dca0020-27c8-4695-b7c7-a56fc2df2f08',
    runtime: 'claude', // claude-sonnet-5 — aligned repo
    maxInflight: 2,
    repo: 'mdostal/mnemosyne',
  },
  // ALIGNED build lane for Votum (decision-approval / quorum god).
  'votum-dev': {
    id: '94e096ea-d2c1-4084-898c-4174e3285d0d',
    runtime: 'claude', // claude-sonnet-5 — aligned repo
    maxInflight: 2,
    repo: 'mdostal/votum',
  },
};

// Per-runtime in-flight ceiling. The Codex runtime is shared by two agents,
// so cap the whole runtime to avoid single-runtime contention collapse.
export const RUNTIME_CAP = {
  claude: 4, // was 3; +1 for the PARALLEL PLANNING lane: up to 3 concurrent minerva-dev plans + 1 headroom slot for an aligned build (consus/mnemosyne/votum). Global daemon cap is 10 so there is daemon room to spare; kept deliberately modest (only +1) because account usage — not CPU — is the real ceiling. Planning runs FIRST each cycle so it wins slots when seeds are queued; when the planning queue is idle the whole cap flows to builds. If Mathew wants guaranteed 3-wide planning ALONGSIDE builds, raise to 5. Back off if real ERR-level 429/quota/overloaded appears in the daemon log.
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
  'aeb1033d-4ab9-4da6-b798-8dc569e75cc9': 'Tools',         // seeds only -> planning lane (minerva-dev); planned stories build once aligned agents exist
  'fcdf7fdf-9b87-4c4a-9a4c-e86471a0b2d9': 'Hellsing',
  '66963847-df7e-46e8-b51a-82eebdf82208': 'Stimula',
  'a0b04ced-5ad6-4249-bb1a-115b88c532d7': 'CADEX',
  '6483d6e1-83eb-4c7d-822a-c2844087ff7f': 'Clients Dashboard',
  '6d6a69b1-c279-4664-8da7-79cb067c28eb': 'Personal Dashboard',
  '7dcbb8d1-e53e-4ac4-bfa5-2016c223bd32': 'House Hunting',
  '1001f225-9c42-4b00-b50a-d16cd06fe181': 'Gig Radar',
  '282343e2-b741-4438-bc80-b93c34819a96': 'Consus',        // -> consus-dev (Claude) LAST, sparing
  '915ec7de-f13c-4bf3-b666-1f2d7d25ce16': 'Mnemosyne',     // -> mnemosyne-dev (Claude, aligned repo)
  '441b73b8-ee09-41fd-b8d2-1e18baa1d8cf': 'Votum',         // -> votum-dev (Claude, aligned repo)
};

// All project IDs the router scans.
export const PROJECT_IDS = ['d78a9f5d-8792-45e8-89e0-bd7b916564ca', '8cb0298a-8a45-45c2-8d09-bc219e2d8a82', '282343e2-b741-4438-bc80-b93c34819a96', '915ec7de-f13c-4bf3-b666-1f2d7d25ce16', '441b73b8-ee09-41fd-b8d2-1e18baa1d8cf', 'aeb1033d-4ab9-4da6-b798-8dc569e75cc9']; // ALIGNED-ONLY overnight (Auriga/Heimdall/Consus); the 14 unaligned projects need agents+repos (Mathew AM decision) before their tickets do real work

// Project -> ordered candidate agent lanes.
// Aligned lanes (agent repo matches the project) are preferred and listed first.
// "Others" spread across the two Codex agents; Claude used sparingly (Consus only).
const CONSUS = '282343e2-b741-4438-bc80-b93c34819a96';
const HEIMDALL = '8cb0298a-8a45-45c2-8d09-bc219e2d8a82';
const AURIGA = 'd78a9f5d-8792-45e8-89e0-bd7b916564ca';
const MINERVA = '6327fdaf-789e-4290-ab41-1421957b55c6';
const MNEMOSYNE = '915ec7de-f13c-4bf3-b666-1f2d7d25ce16';
const VOTUM = '441b73b8-ee09-41fd-b8d2-1e18baa1d8cf';

export const PROJECT_LANE = {
  [CONSUS]: ['consus-dev'], // aligned repo; Claude — sparing
  [HEIMDALL]: ['heimdall-dev', 'heimdall-dev-codex'], // aligned repo (Opencode + Codex)
  [AURIGA]: ['auriga-dev'], // aligned repo (Codex)
  [MINERVA]: ['auriga-dev'], // no dedicated agent; nearest Codex lane
  [MNEMOSYNE]: ['mnemosyne-dev'], // aligned repo mdostal/mnemosyne (Claude)
  [VOTUM]: ['votum-dev'], // aligned repo mdostal/votum (Claude)
};

// Fallback lane for every other project: spread across the two Codex agents.
export const DEFAULT_LANE = ['auriga-dev', 'heimdall-dev-codex'];

// Batch / cadence caps.
export const CAPS = {
  perCyclePerAgent: 2, // never mass-flip
  perCycleTotal: 5,
  cycleMs: 75000,
  zombieStaleMs: 45 * 60 * 1000, // 45 min. RAISED from 20 min (2026-07-27): a real plugin-hive
  // kickoff+plan on the PLANNING lane (minerva-dev) legitimately runs ~20-30 min, so the old 20-min
  // threshold classified a still-running plan as "run-stale" and reran it right as it completed —
  // killing the task before minerva-plan could file its stories, an infinite rerun loop that never
  // reached filing. 45 min clears a real plan with headroom. (Build lanes recover more slowly as a
  // side effect; acceptable. A cleaner follow-up is a planning-lane-specific threshold.)
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
//   maxPerCycle   at most this many seeds routed to planning per cycle. Raised
//                 1->3 (2026-07-27) for PARALLEL PLANNING: queued seeds now plan
//                 CONCURRENTLY (up to 3) instead of serially behind one plan.
//                 Bounded by minerva-dev.maxInflight (3) and RUNTIME_CAP.claude (4).
export const PLANNING = {
  agent: 'minerva-dev',
  seedLabels: ['idea', 'needs-plan', 'consus-idea'],
  plannedLabels: ['planned', 'epic', 'story'],
  seedFallback: false,
  maxPerCycle: 3,
};
