# Research Brief: Adapter-Interface Extraction

**Epic:** p2-adapter-interface
**Requirement:** Extract a generic adapter interface (backlog adapter + persona/spawn
adapter + a stubbed pantheon-v2 L2 adapter) so Auriga can run fully standalone, with
Pantheon becoming the first consumer via the adapter boundary rather than a direct
integration.

## 1. What actually runs today

`src/router/` is the only running code (Node 22+/24+, ESM, zero runtime deps). Entry
point: `auriga-router.mjs` (464 lines) — a scan/route/verify cycle loop, exported as
`cycle()` for testability, invoked by `main()` only when run directly.

`cycle()` accepts an options bag (`mca`, `cfg`, `core`, `log`, `sleep`, `dryRun`,
`noZombie`, `maxAssign`, `now`) — every dependency defaults to a live singleton but is
injectable, which is precisely how `test/router-cycle.e2e.test.mjs` already drives a
full cycle against a **mock Multica layer** (`test/support/mock-mca.mjs`). This
injectable-dependencies pattern is the existing seam an adapter interface would slot
into — `mca` is already a de facto adapter parameter, just typed as "the Multica
module" rather than an interface.

## 2. The three hardcoded external-system couplings (not one)

Prior framing (VISION.md, kickoff discovery) named only the Multica coupling. Deeper
read of `src/router/lib/` surfaces three separate direct couplings, all of which the
adapter-interface work needs to account for:

1. **`lib/multica.mjs` (179 lines)** — `execFileSync` wrapper around the `multica`
   CLI. Functions: `listIssues` (paginated), `listAllProjectIds`, `listAllIssues`,
   `issueRuns`, `assignIssue`, `rerunIssue`, `issueStatus`, `issuePullRequests`,
   `unassignIssue`, `issueComment`. This is the **backlog** surface — issue
   CRUD/status/comment/PR-linkage.
2. **`lib/multica.mjs` (same file) also shells to `gh`** — `ghOpenPrs`, `ghListRepos`,
   `ghPrs`. Used by the review lane because "Multica's issue<->PR linkage is empty in
   practice" (comment, line ~140). This is a SEPARATE external system (GitHub) reached
   through the same module as the backlog adapter — a second coupling hiding inside
   what looks like one file.
3. **`lib/vulcan-hook.mjs` (45 lines)** — `execFileSync` to a hardcoded
   `~/Documents/work/dostal/code/vulcan/bin/vulcan.mjs` binary path
   (`process.env.VULCAN_BIN` overridable) for repo provisioning
   (`ensureTargetRepo`). Documented as "wiring (single guarded line)" not yet wired
   into `auriga-router.mjs`'s dispatch loop per the file's own header comment — this
   is a fourth touchpoint that exists but is dormant.

`lib/config.mjs` (258 lines) is NOT itself an external-system caller, but it hardcodes
substrate-specific facts that any adapter interface must externalize:
- `AGENTS` — 9 agents with real Multica agent UUIDs, `runtime`, `maxInflight`, `repo`.
- `PROJECT_NAMES` / `PROJECT_IDS` — 17 real Multica project UUIDs (only 4 "aligned"
  and actively scanned; 13 explicitly unaligned/dormant, one epic-documented gap
  where 7 named "unmapped projects" don't correspond to any real project ID at all —
  see the `KNOWN GAP` comment block).
- `PROJECT_LANE` / `DEFAULT_LANE` / `HIVE_LANE` / `REVIEW_LANE` — lane maps keyed to
  the above UUIDs.
- `HUMAN_NAMES` — hardcoded human-todo filter list (`['mathew', 'dostal']`).
- `REVIEW_SQUAD_RULES` — keyword→tier mapping for the review squad sizing (this part
  IS substrate-agnostic logic and could stay in core, it just currently lives
  alongside substrate-specific config in the same file).
- `CAPS` — batch/cadence numbers (not substrate-specific, but currently undifferentiated
  from the substrate-specific config above in the same export surface).

## 3. Pure-core / thin-shell boundary already exists — and is the right seam

`lib/core.mjs` (1,127 lines) is genuinely pure and already substrate-agnostic: it
operates on plain issue/run/PR-shaped objects and a config object, never importing
`multica.mjs` or calling `execFileSync` directly. Verified functions: `isHiveStory`,
`isHumanTodo`, `selectAssignments`, `detectRunCompletions`, `detectVerifiedDone`,
`reviewSquadPlan`, `squadPlanSummary`, plus cascade/zombie/false-done passes (per
`test/cascade.test.mjs`, `test/descdeps.test.mjs`, `test/slugkey.test.mjs`,
`test/squad.test.mjs`). This means the HARD part of "adapter interface" work — making
routing/capacity/state-machine decisions substrate-agnostic — is **already done**. What
remains is generalizing the I/O boundary (`lib/multica.mjs`, `lib/vulcan-hook.mjs`) and
the substrate-specific config (`lib/config.mjs`'s UUID-keyed maps), not rewriting
decision logic.

## 4. `src/engine/` (VISION.md's "routing engine") — verified: interface layer was never recovered

Correction to VISION.md's branch reference: `origin/feat/routing-engine` does not exist
on the remote. The actual content lives in commit `f4847ee` ("Recover Auriga routing
engine into mdostal/auriga (#45)"), present on `origin/dev` and
`origin/feat/PAN-8245`. Inspected via `git show <ref>:<path>` without checking out (kept
`feat/p2-adapter-interface` clean).

**Inventory:** `src/engine/` — 51 TypeScript files, ~10.9k lines.
`auriga/adapters/{multica,db}/`, `auriga/consumer/`, `auriga/escalation/`,
`auriga/lock/` (`MulticaLock`), `auriga/observability/` (counters, death-detection,
instrumented wrappers), `auriga/watcher/` (verification-swarm, verdict-synthesis,
verifier-pool), `auriga/run.ts` (composition root), plus 5 unapplied `.patch` files.

**Critical finding: the interface layer was never recovered.** Every file imports
types from `contracts/tracker-adapter.ts`, `contracts/lock.ts`, `contracts/db-adapter.ts`,
etc. — **none of these files exist anywhere in this repo's git history, on any branch.**
`src/engine/` is entirely *implementations* of an interface that no longer exists. The
`TrackerAdapter` shape has to be reverse-engineered from usage:

```ts
// inferred from adapters/multica/index.ts usage — not present in the repo
type TaskStatus = "pending" | "in_progress" | "review" | "done" | "blocked";
interface TaskRecord { id: string; status: TaskStatus; title: string; }
interface TrackerAdapter {
  claimTask(taskId: string): Promise<LockResult>;   // {claimed, lockId, expiresAt}
  updateStatus(taskId: string, status: TaskStatus): Promise<void>;
  getTask(taskId: string): Promise<TaskRecord>;
}
```

This is **narrower** than what p2 needs — no `create`, `comment`, `list`/query, or PR
concept. Not a ready-made superset to extend.

**What's genuinely reusable:**
- `MulticaTrackerAdapter`'s empirical status-enum mapping comments (Multica's
  `todo|in_progress|in_review|done|blocked|backlog|cancelled` ↔ the old contract's 5
  values) and its documented PUT-is-partial-merge / no-CAS / no-native-lease findings —
  real prior art about Multica's actual API behavior, not guesses.
- `SqliteDBAdapter` — trivial 2-method `{read,write}` KV cache, directly liftable if a
  local cache layer is ever needed.
- `MulticaLock`'s client-side claim/lease/sweep pattern — relevant only if this epic
  needs cross-instance leasing (not currently a stated requirement — Auriga runs single-
  instance per the north_star scale answer).

**What's dead weight for this epic:** escalation (sustained-decline detector,
verdict-disagreement records), observability counters, and the verifier-pool/swarm-
dispatch machinery are P1/P2 orchestration concerns specific to the old
pantheon-orchestrator's board-state-machine epic — unrelated to a generic adapter
interface, would just add noise if ported.

**Wiring: confirmed fully dormant.** No `tsconfig.json` anywhere in the repo (the `.ts`
files can't even be typechecked). Root `package.json`'s only script is
`node --test src/router/test/*.test.mjs`; `.github/workflows/ci.yml` just runs
`npm test`. Nothing references `src/engine/`. Matches VISION.md's "design source, not a
running component" — durable custody only.

**Conclusion for design discussion:** design the `BacklogAdapter` interface fresh; mine
`adapters/multica/index.ts`'s status-mapping and PUT-semantics comments as input, do not
port the interface layer (it doesn't exist) or the escalation/observability/verifier
machinery (out of scope).

## 5. Existing test seam for adapter work

`test/support/mock-mca.mjs` + `test/router-cycle.e2e.test.mjs` prove the pattern: a
mock object matching (some subset of) `lib/multica.mjs`'s function surface, injected
via `cycle()`'s options bag, already produces a working loop-level e2e test with zero
live Multica. A formal `BacklogAdapter` interface would likely just need to name and
freeze the shape `mock-mca.mjs` already informally implements.

## 6. What "standalone" currently blocks on

- No adapter interface — `auriga-router.mjs` imports `lib/multica.mjs` directly (not
  through an injected `mca` parameter at the call site inside `main()` — `cycle()`
  defaults `mca` to the live singleton import).
- No config schema separating "substrate facts" (UUIDs, lane maps) from "policy"
  (caps, review squad rules, human names) — one flat `config.mjs` module.
- No UI of any kind — headless CLI/daemon only.
- `gh` and `vulcan` couplings are undocumented as adapter surfaces in VISION.md (which
  only names Multica) — the design discussion needs to decide whether "backlog
  adapter" absorbs the GitHub PR-linkage calls too, or whether that's a second adapter
  kind (a "VCS adapter").

## Open items for design discussion

- Decide adapter boundary count: is GitHub (`gh` PR lookups) part of the backlog
  adapter, or a separate VCS adapter? Same question for Vulcan (repo provisioning).
- Decide where `REVIEW_SQUAD_RULES` and `CAPS` (substrate-agnostic policy) live once
  `config.mjs` splits — likely stay in a policy config, separate from adapter config.
- The "persona/spawn adapter" (routing decisions → actually dispatching an
  agent/squad/runner) has no existing pure-core equivalent to `lib/core.mjs`'s routing
  logic to build from — `assignIssue`/`rerunIssue` in `multica.mjs` ARE the dispatch
  call today, conflated with the backlog CRUD calls in the same file. This needs its
  own interface, separate from the backlog adapter.
