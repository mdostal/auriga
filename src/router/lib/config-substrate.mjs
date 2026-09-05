// SUBSTRATE half of the lib/config.mjs split (begun in p2-multica-backlog-adapter,
// completed by p2-multica-spawn-adapter). "Substrate" = which real-world
// agents/projects exist and their raw ids, as distinct from "policy" (routing
// rules, caps, review sizing), which stays in lib/config.mjs. See that file's
// re-export of these same three names for why both modules currently expose
// them (backward-compat window for any consumer still importing from
// lib/config.mjs directly).
//
// AGENTS/PROJECT_NAMES/PROJECT_IDS moved here VERBATIM from lib/config.mjs —
// byte-identical values, including the KNOWN GAP comment below. This is
// explicitly a move, not a fix: see design_decisions in
// .pHive/epics/p2-adapter-interface/stories/p2-multica-backlog-adapter.yaml.
//
// PROJECT_NAMES/PROJECT_IDS/PROJECT_LANE are now DERIVED (p6-registry-core),
// not hardcoded — see the registry-derivation block below, after AGENTS.
//
// AURIGA_CONFIG: optional path to a partial JSON override file (PANT-70).
// Any key present in the file replaces the corresponding export; absent keys
// keep their defaults. Unreadable or malformed files exit non-zero (fail-closed
// — a bad config must never silently fall back to the full default project list).
import { loadRealRegistryConfig } from './project-registry.mjs';
import { loadExternalConfig } from './config-loader.mjs';
const _ext = loadExternalConfig();

// Project -> agent-lane map, agent metadata, and caps.
//
// IDs re-verified live 2026-09-04 (GitHub issue #79) against the CORRECT,
// current workspace f32af269-... via a real cross-session GET
// /api/backlog/agents/<name> pull against the live core-api. The previous
// claim here ("All IDs verified live against workspace Pantheon
// 7feca4c9-...") was itself the bug: 7feca4c9 is the OLD, stale workspace
// PR #66/#71 already moved every PROJECT id away from — these AGENT ids had
// simply never gotten the same treatment. Concretely, this silently broke
// selectReviewDispatch's "already under review, don't re-dispatch" check
// (the real assignee_id the live board wrote never matched the stale
// auriga-review id here, so PANT-4 re-dispatched every single cycle
// forever — see #79) and, by the same mechanism, computeInflight/
// computeReviewInflight's assignee_id->lane-name lookups router-wide.
export const AGENTS = _ext.AGENTS ?? {
  'consus-dev': {
    id: 'f77456c3-ec31-4490-8f38-099624ce9384',
    runtime: 'claude', // claude-sonnet-5 — spare the Claude weekly ceiling
    maxInflight: 1, // sparing: at most one Consus/Claude ticket in flight
    repo: 'mdostal/consus',
  },
  // UNRESOLVED (#80): GET /api/backlog/agents/heimdall-dev 404s against the
  // corrected workspace f32af269 — either this lane's agent genuinely
  // doesn't exist there yet, or Multica calls it something else now. Left
  // UNCHANGED (not blanked/guessed) pending that investigation — an absent
  // id here fails the exact same way a wrong one does (never matches a real
  // assignee_id), so leaving the old value causes no additional harm while
  // it's open, and chooseAgentForProject already falls back to
  // heimdall-dev-codex when this lane has no capacity/match.
  'heimdall-dev': {
    id: 'e56643ab-ec07-4347-a284-221c2f03a62d',
    runtime: 'opencode',
    maxInflight: 3,
    repo: 'mdostal/heimdall',
  },
  'auriga-dev': {
    id: '7eeeaaf0-0353-439a-9b51-29c29d54ad93',
    runtime: 'codex', // shares runtime a86c890c with heimdall-dev-codex
    maxInflight: 3,
    repo: 'mdostal/pantheon-orchestrator',
  },
  'heimdall-dev-codex': {
    id: '5d349b30-8860-4306-a7a2-4219f015e446',
    runtime: 'codex', // shares runtime a86c890c with auriga-dev
    maxInflight: 3,
    repo: 'mdostal/heimdall',
  },
  // Claude+plugin-hive build lanes (runtime 1d5e9b93, shared with consus-dev).
  // These are the ONLY lanes that can run /hive:execute|review|test — hive-tagged
  // stories (see isHiveStory in lib/core.mjs) must land here, never on codex/opencode.
  'auriga-build': {
    id: '84c1c48c-1425-49d9-8dc4-e841f2034654',
    runtime: 'claude',
    maxInflight: 2, // sparing, mirrors consus-dev
    repo: 'mdostal/auriga',
  },
  'mnemosyne-dev': {
    id: 'b5ab2148-de69-4c8a-af63-0b1495cfd57b',
    runtime: 'claude',
    maxInflight: 2,
    repo: 'mdostal/mnemosyne',
  },
  'votum-dev': {
    id: '8f4bb79f-6087-4fd7-82b0-c222cd1e70df',
    runtime: 'claude',
    maxInflight: 2,
    repo: 'mdostal/votum',
  },
  // NOTE: minerva-dev is intentionally NOT a hive-execute build lane — its
  // live agent instructions are Minerva's *planning* lane only
  // (bin/minerva-plan), not /hive:execute. Do not add it to HIVE_LANE below.
  // Planning lane (not a build agent): un-planned "seed" issues route here
  // instead of a build lane so they get an epic + dependency-tracked stories
  // before any build agent ever sees them (see PAN-6646).
  'minerva-dev': {
    id: 'e51a115c-6181-4f59-bb01-b4c77206c6fd',
    runtime: 'claude-planning', // own runtime bucket; not shared with consus-dev's `claude`
    maxInflight: 3, // mirrors the real agent's max_concurrent_tasks
    repo: null, // planning lane; no fixed target repo — plans land on whichever project the seed belongs to
  },
  // Review lane (moved here from lib/config.mjs, GH #79): that file used to
  // ADD this entry via `AGENTS['auriga-review'] = {...}` AFTER this object
  // was already built — an unconditional `=`, not `??=` or a merge, that
  // would silently stomp any future tenant-scoped AGENTS override for this
  // one agent even after fixing the id below (found live by a cross-session
  // peer while diagnosing #79). Defining it here instead means it is just
  // another entry in the one real AGENTS default, overridable via `_ext.AGENTS`
  // the exact same (uniform, whole-object) way as every other agent above —
  // no special-cased mutation, no stomp risk.
  'auriga-review': {
    id: '7545f9ad-41da-4bd9-9674-f0dc223236b9',
    runtime: 'claude-review', // own capacity bucket; physical Multica runtime is Claude (1d5e9b93)
    maxInflight: 1, // one review/ship at a time — sparing on the Claude account
    repo: null, // target_repo-driven, exactly like the build lane
  },
};

// Project UUID -> title, all dispatch-eligible project ids (order-sensitive —
// selection scans in this order), and project UUID -> ordered candidate agent
// lanes are now DERIVED from the committed registry file (src/router/projects.json,
// p6-registry-core) instead of hardcoded object literals — this is that
// reconciliation mechanism the KNOWN GAP below used to say was still needed.
// See lib/project-registry.mjs for the read/derive logic and that file's own
// header comment for the injected-dependency testability pattern.
//
// GRACEFUL DEGRADE (grill finding H2, p6-registry-core): this read happens at
// ES MODULE IMPORT TIME — a genuinely new pattern in this codebase. A missing
// or malformed projects.json must NEVER throw and crash this import (an
// unrelated existing test, test/spawn-adapter.test.mjs, imports PROJECT_LANE
// etc. from this exact module) — loadRealRegistryConfig() below already
// catches that internally, logs a loud stderr warning, and degrades to empty
// PROJECT_NAMES/PROJECT_IDS/PROJECT_LANE (see project-registry.mjs). Test-only
// path override: AURIGA_PROJECTS_REGISTRY_PATH (see project-registry.mjs),
// unset in production.
const registryConfig = loadRealRegistryConfig();

// Project UUID -> title (for logs/lane names). Cosmetic only — every real read
// site (core.mjs) has a safe raw-UUID fallback (`cfg.PROJECT_NAMES[id] || id`).
export const PROJECT_NAMES = _ext.PROJECT_NAMES ?? registryConfig.PROJECT_NAMES;

// All project IDs the router scans — the REAL, order-sensitive dispatch-
// eligibility gate (core.mjs's selectAssignments/detectCascadeDispatch filter
// to this exact set; a project missing from it is silently excluded from real
// dispatch, no log line fires). Sourced from projects.json's `dispatch_order`
// (aligned lanes first — Auriga/Heimdall — PLUS Pantheon Core, the Consus
// ideabox seed-drop project; Consus itself scanned LAST so it's drained
// sparingly). See projects.json's own header comment for the full rationale.
// ORDER IS LOAD-BEARING: selectAssignments sorts by PROJECT_IDS.indexOf for dispatch priority.
export const PROJECT_IDS = _ext.PROJECT_IDS ?? registryConfig.PROJECT_IDS;

// KNOWN GAP (found during implementation of p1-router-capability-routing;
// PARTIALLY reconciled by p6-registry-core, which turned the hand-edit into a
// real, operator-driven registry — the underlying gap itself is unchanged):
// the epic's plan named 8 "unmapped projects" needing PROJECT_LANE entries —
// Tools, flayr, lct, il, ps, hf, analytics, tree — but only "Tools"
// (aeb1033d-4ab9-4da6-b798-8dc569e75cc9) exists as a real Multica project; the
// other 7 names don't correspond to any project ID in this workspace (they
// read like seed/repo names *within* Tools, per its own description). Tools
// is also not in PROJECT_IDS today (deliberately — see the ALIGNED-ONLY
// comment above, "14 unaligned projects need agents+repos, Mathew AM
// decision"). Fabricating routing entries for non-existent projects would be
// wrong, and expanding PROJECT_IDS is a separate, already-gated decision
// (now: a separate `auriga project add` invocation, once p6-project-cli
// lands). This same 7-unmapped-names gap carries through PROJECT_LANE below,
// which also does not (and must not) have entries for those 7.

// ============================================================================
// LANE MAPS + RUNTIME_CAP (moved here VERBATIM from lib/config.mjs by
// p2-multica-spawn-adapter, completing the substrate/policy split begun in
// p2-multica-backlog-adapter — see that story's design_decisions). Byte-
// identical values to what lib/config.mjs exported before this move,
// including the KNOWN GAP above. lib/config.mjs re-exports these same names
// (backward-compat window for any consumer still importing from
// lib/config.mjs directly — see that file's header comment).

// Per-runtime in-flight ceiling. The Codex runtime is shared by two agents,
// so cap the whole runtime to avoid single-runtime contention collapse.
export const RUNTIME_CAP = _ext.RUNTIME_CAP ?? {
  claude: 2,
  opencode: 3,
  codex: 4,
};

// Project -> ordered candidate agent lanes. DERIVED (p6-registry-core) from
// projects.json's per-project `lane` field — see registryConfig above and
// project-registry.mjs's deriveProjectLane(). Aligned lanes (agent repo
// matches the project) are preferred and listed first. "Others" spread across
// the two Codex agents; Claude used sparingly (Consus only). Unchanged
// semantics from the former hardcoded literal, including:
//   - Minerva: no dedicated agent; nearest Codex lane (auriga-dev) — present
//     here despite being ABSENT from PROJECT_IDS above (dispatch-ineligible
//     but routing-policy-load-bearing; see projects.json's Minerva entry).
//   - Pantheon Core: the dogfood seed drop (Consus ideabox) AND where Minerva
//     now files the decomposed child stories of those seeds (a seed dropped
//     here yields stories here — see Minerva's fileStoriesToMultica project
//     resolution). Seeds themselves still route to minerva-dev (the isSeed
//     check in core.mjs runs FIRST); this lane applies only to the NON-seed
//     decomposed build-stories. They must never fall back to DEFAULT_LANE
//     (codex/opencode have no plugin-hive and self-block on /hive:execute) —
//     route them to the claude+hive BUILD lane. Minerva's stories are also
//     hive-shaped, so isHiveStory routes most of them via HIVE_LANE anyway;
//     this entry closes the gap for any decomposed story that isn't hive-shaped.
// A project absent from this map (no `lane` in its registry entry, or
// unregistered entirely) falls back to DEFAULT_LANE below — unconditional,
// unchanged fallback (core.mjs's chooseAgentForProject:
// `cfg.PROJECT_LANE[projectId] || cfg.DEFAULT_LANE`).
export const PROJECT_LANE = _ext.PROJECT_LANE ?? registryConfig.PROJECT_LANE;

// Fallback lane for every other project: spread across the two Codex agents.
// Applies ONLY to non-hive stories — see HIVE_LANE below for capability-aware override.
export const DEFAULT_LANE = _ext.DEFAULT_LANE ?? ['auriga-dev', 'heimdall-dev-codex'];

// Capability-aware override: any story detected as hive-authored (isHiveStory in
// lib/core.mjs — build/implementation/classic-methodology tagged, e.g. a Minerva-planned
// story) routes HERE instead of PROJECT_LANE/DEFAULT_LANE, regardless of project. Codex and
// Opencode runtimes have no plugin-hive install and cannot run /hive:execute|review|test —
// routing a hive story there causes a silent self-block (PAN-6636, PAN-6640, PAN-6646).
export const HIVE_LANE = _ext.HIVE_LANE ?? ['auriga-build', 'mnemosyne-dev', 'votum-dev'];

// The review/ship lane: in_review stories with an open PR route here. The
// review agent itself ('auriga-review') is added to AGENTS, and its runtime
// bucket ('claude-review') capped in RUNTIME_CAP above, by lib/config.mjs
// (mutation happens there — see that file's BACK-HALF OF THE LOOP comment —
// because it happens AFTER this module's AGENTS/RUNTIME_CAP are imported and
// re-exported there, exactly like the AGENTS split in p2-multica-backlog-adapter).
export const REVIEW_LANE = _ext.REVIEW_LANE ?? ['auriga-review'];

// GitHub owner whose repos the review lane sweeps for open PRs. The router
// discovers ALL of this owner's repos live (mca.ghListRepos) each cycle so a new
// repo (logic-loops, house-finder, ...) is covered the moment it exists, instead
// of waiting to be hand-added to REVIEW_SEARCH_REPOS below. REVIEW_SEARCH_REPOS
// remains the static fallback used only when live discovery returns nothing.
export const REVIEW_REPO_OWNER = _ext.REVIEW_REPO_OWNER ?? 'mdostal';

// Baseline repos the review lane searches for a story's open PR. Multica's
// issue<->PR linkage is empty in practice, so PR discovery goes through gh; the
// router also adds any explicit target_repo it finds on an in_review story, so
// this is just the default set of OUR private plugin repos.
export const REVIEW_SEARCH_REPOS = _ext.REVIEW_SEARCH_REPOS ?? [
  'mdostal/auriga', 'mdostal/heimdall', 'mdostal/consus',
  'mdostal/pantheon-orchestrator', 'mdostal/mnemosyne', 'mdostal/votum',
  'mdostal/cron-maker',
];
