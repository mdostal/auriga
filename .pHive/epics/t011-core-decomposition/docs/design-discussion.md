# Design discussion: t011-core-decomposition

## Goal

Fourth of four originally-agreed workstreams from the 2026-09-05
codebase-wide cleanup discussion, deferred at the time as needing its own
dedicated pass: decompose `core.mjs` (1189 lines, ~48 exported functions
covering roughly 7 unrelated concerns) into smaller, cohesive modules.

## Approach

Mapped the real dependency graph among core.mjs's functions before touching
anything, to find genuinely self-contained leaf groups vs. the tightly
interdependent dispatch/state-machine core that should NOT be split
(splitting mutually-recursive decision logic across files for a line-count
target would reduce readability, not improve it — a real judgment call, not
a mechanical exercise).

Extracted 5 fully self-contained modules, each with a strictly
one-directional dependency chain (no cycles):

1. **`run-classification.mjs`** — classifyRun/hasActiveRun/latestRun. Zero
   cross-deps.
2. **`story-identity.mjs`** — storyKey/slugKey/descStoryDeps/descStoryId.
   Zero cross-deps.
3. **`pr-matching.mjs`** — prReferencesIssue/prMatchesStory/
   prIdentityMatchesStory/repoFromPrUrl/prIsOpen/hasOpenPrForIssue/
   normalizeRepoSlug/targetRepoValue/hasTargetRepo. Depends on
   story-identity.mjs (storyKey) + github-pr-state.mjs (isPrOpen), both
   already-external leaf modules.
4. **`capacity.mjs`** — computeInflight/computeAssignedQueued/
   computeRuntimeInflight/agentHasCapacity/computeReviewInflight/
   chooseReviewAgent. Depends only on issue-status.mjs.
5. **`review-squad.mjs`** — DEFAULT_SQUAD_RULES/reviewSquadPlan/
   squadPlanSummary. Depends on pr-matching.mjs (targetRepoValue).

**Safety mechanism: `core.mjs` stays a stable re-export facade.** Every
extracted function is imported back into `core.mjs` and re-exported under
its exact original name. This means:
- `auriga-router.mjs`'s ~25 `coreImpl.X` call sites: zero changes needed.
- Every existing test file's `import { X } from '../lib/core.mjs'` or
  `import * as core from '../lib/core.mjs'`: zero changes needed.
- Behavior is byte-identical; this is a pure file-organization change with
  no decision-logic modification anywhere.

`core.mjs` itself keeps the genuinely interdependent dispatch/state-machine
core: `selectAssignments`, `detectZombies`, `detectUnblocks`,
`detectCascadeDispatch`, `detectRunCompletions`, `detectVerifiedDone`,
`detectFalseDone`, `detectParentDone`, `selectReviewDispatch`,
`chooseAgentForProject`, `isSeed`, `depsSatisfied`/`descDepsSatisfied`/
`allDepsSatisfied`, `isHumanTodo`/`humanTodoReason`/`isHiveStory`/
`isSmokeScratch`, `isHiveCapableAssignee`, `reviewEligible`, `ownPrUrl`/
`samePrUrl`, `resolveDepSibling`/`dependsOnAny` — these genuinely
cross-reference each other and represent the router's real "pure decision
logic" core, correctly kept together rather than artificially split.

## Verification

Extracted one module at a time, running the full test suite after each
move before proceeding to the next — caught nothing broken along the way
(each move was behavior-preserving by construction). Added 5 new dedicated
test files (one per extracted module) exercising each module's own public
API directly, independent of core.mjs's re-export — not exhaustive
duplication of core.test.mjs's existing extensive coverage of these same
functions (which continues to pass unmodified, proving the re-export chain
itself is intact), but real, additional confidence that each module is
correct standalone. Full `npm run test:all` green throughout (398 router
tests, up from 361; 52 server; 8 e2e/hardening).

## Result

`core.mjs`: 1189 → 763 lines (36% reduction). 5 new cohesive,
independently-tested modules (46-132 lines each). Zero behavior change,
zero call-site changes anywhere in the codebase.

## Scale

Medium — a real, careful refactor touching one large file and its full
test suite, but every step was verified incrementally and the safety
mechanism (facade re-export) made the blast radius of any single mistake
small and immediately test-visible.
