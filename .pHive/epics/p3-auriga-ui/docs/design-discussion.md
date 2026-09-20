# Design Discussion: UI for Auriga (rescoped)

**Note:** this replaces an earlier draft that was built on a misattributed vision (a
v0.dev-style, self-building UI-creation tool — that content was actually written for
**Janus**, Pantheon's UI-creation portal, and got recorded under Auriga by mistake). The
grill pass against that earlier draft (`grill-record.md`) is still a useful record of
real issues it caught (terminology, verification rigor, adapter-boundary questions) —
several of its lessons still apply below even though the chat/LLM/self-building content
it was reacting to has been removed entirely. See [[project-auriga-ui-scope]] (memory)
for the corrected, standing brief.

## 1. What Are We Doing?

A **clean, simple operator dashboard for Auriga. Nothing more.** You want to be able to
see what Auriga is, what it's doing, and what it's done — the epics/stories/status and
the real audit trail (research briefs, design discussions, commits, test results) this
whole project has been producing on disk in `.pHive/`. That's it. No chat panel, no LLM
integration, no self-building/scaffolding capability — that ambition belongs to Janus,
not here.

"Done" for this epic: a local web page you can open that shows real epic/story data and
the real log of what's happened, backed by a small local server, built on a real
frontend foundation (shadcn/ui + Vite + Tailwind — confirmed, independent of any
self-building rationale) so it isn't throwaway work if the UI ever needs to grow later.
v1 is deliberately **read-only** — "just seeing." What interaction/action looks like is
an explicit later decision, made once you've actually used the read side for a while.

## 2. What I Found

- **`.pHive/` is already a real, structured data source** — epics (docs + story YAMLs
  with `status:`), post-run audit records, cycle state. All flat YAML/Markdown on disk.
  A dashboard's job is rendering what already exists, not inventing new state.
- **Zero UI/frontend tooling exists anywhere in this repo** — confirmed via direct
  inspection, both `package.json`s are dependency-free. This is Auriga's first
  departure from its zero-build-tooling convention (`.pHive/CONTEXT.md`) — an explicit,
  isolated one: a separate `src/ui/` package, the router's zero-dep backend untouched.
- **shadcn/ui requires a real build pipeline** — it's not an npm package, its CLI copies
  component source into your repo and requires Tailwind CSS + React + a bundler (Vite is
  the natural fit, has first-class support). No way around this if we want it, which
  you've confirmed we do.
- **This project's standing verification policy**: no live external dependency in
  tests (Multica or otherwise), and CI (`ci.yml`, still real, still runs, still calls
  itself "THE gate") is never waited on or blocked on — local validation plus
  admin-merge is the actual gating mechanism, same as the last two PRs.
- **Playwright MCP tooling is available in this session** and can drive real, automated
  browser checks against the dashboard — not just "open it and eyeball it."

## 3. My Proposed Approach

1. **A local Node HTTP server** (`src/server/` — new top-level module, sibling to
   `src/router/`, router's zero-dep purity untouched). Built on `node:http`, no new
   runtime dependency for the server half. Serves a small JSON read API over `.pHive/`
   state (epics, stories, audit records, recent git log) plus the built frontend
   assets. Runs standalone/local-only, independent of the supervised router process —
   you start it when you want to look at the dashboard, it doesn't need to run
   continuously alongside `cycle()`'s loop.
2. **A frontend package** (`src/ui/`, its own `package.json`) — Vite + Tailwind + a
   handful of shadcn/ui components. Isolated: nobody who doesn't care about the
   dashboard ever needs to `npm install` anything for it. Its scaffold's default
   ESLint/Prettier config is accepted, scoped only to this package — a deliberate,
   separate departure from the rest of the repo's zero-lint convention, not a repo-wide
   change.
3. **Dashboard v1 (read-only)**:
   - Epics list — status, story counts, links to their docs
   - Story detail — acceptance criteria, `cross_cutting`, status
   - Activity/log view — real git commits + post-run audit records, the actual "what
     did you do" answer from real data
4. **No chat panel, no LLM adapter, no external API integration of any kind in this
   epic.** The earlier draft's `llmAdapter`/chat-panel design is fully removed, not
   deferred-with-a-stub — there's no "later phase" of this specific epic that needs it;
   if Auriga ever wants an interaction/action layer, that's a separate, later,
   explicitly-scoped ask (§1), and it goes through `backlogAdapter`/`spawnAdapter` if
   and when it needs to act, per `adapter-boundary-integrity` — not a bespoke new
   integration.
5. **Data access**: the dashboard reads `.pHive/` files directly for its own
   Hive-planning state (this repo's own research briefs/story YAMLs/audit records) —
   this is Auriga's own local planning data, a different thing from `backlogAdapter`'s
   subject (an external board Auriga routes tickets on). No adapter needed for reading
   this project's own dev-process artifacts.

## 4. What Could Go Wrong

- **Low — scope creep back toward chat/LLM/self-building.** Explicitly and fully
  removed in this rescoped draft, not just deferred. If this resurfaces, it's a new,
  separate, explicitly-scoped ask — not something this epic quietly grows into.
- **Low — adopting a build pipeline is a first-time complexity increase**, mitigated by
  full isolation in `src/ui/` (own `package.json`, own lint config, zero impact on the
  router).
- **Low — new nested `package.json`s (`src/server/`, `src/ui/`) are invisible to
  `ci.yml`'s root-only test step.** Not a functional risk given this project doesn't
  gate on CI; each package's tests run via its own `test` script, invoked directly.

That's a short list on purpose — cutting the chat/LLM/adapter/self-building scope out
removed most of the earlier draft's real risk surface along with it.

## 5. Dependencies and Constraints

- First real runtime dependencies in this repo's history (Vite, Tailwind, a handful of
  shadcn components) — isolated entirely to `src/ui/`'s own `package.json`.
- No live/mocked-CLI Multica dependency (standing project policy) — this epic doesn't
  touch Multica at all regardless.
- `hive.config.yaml -> developer.pr_style: atomic-prs` — same real-merge-commit
  convention as the last epic.
- CI (`ci.yml`) still exists and still runs, but per your explicit direction is never
  waited on or blocked on; local `npm test` in each package plus Playwright-driven
  browser checks (§7) are what actually gate merge, same admin-merge pattern as the
  last two PRs.

## 6. Open Questions

None blocking. The three that mattered (build tooling, server process model, v1
interaction scope) are all resolved by your last two messages — adopt shadcn/Vite now,
run the server standalone/local-only, keep v1 strictly read-only/display. One small
confirm:

1. Any preference on the dashboard's visual style/density beyond "clean," or should I
   let the ui-designer persona propose something during H/V planning and you react to
   it then rather than specify it up front?

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test for the server's read API; Playwright (available in this
    environment) for real browser verification of the dashboard
  Platforms: browser (desktop) — no mobile target for v1
  Automated:
    - Unit tests for src/server/'s HTTP API — reads .pHive/ state correctly,
      correct JSON shapes, handles missing/malformed epic data gracefully
    - Playwright test: launch the server, navigate to the dashboard, assert it
      renders REAL epic/story data read from this repo's own .pHive/ state (not a
      fixture) — including this epic's own story once written, closing the loop
  Manual: none required — the two automated layers above cover the full v1 surface
  Not verifying: anything chat/LLM/interaction-related — doesn't exist in this epic
```

## 8. Scale Assessment

**Size indicators:**
- Files affected: two new, bounded subsystems — `src/server/` (a small read API) and
  `src/ui/` (a dashboard with 3 views). Not a bounded file count in the "5 files" sense,
  but each subsystem is well-understood and doesn't fan out further.
- Subsystems: HTTP server (new, small), frontend build pipeline + dashboard (new).
  Two, not four — dropping the LLM/adapter layer removed half of the earlier draft's
  subsystem count.
- Migration required: no.
- Cross-team coordination: no.
- Unknowns: 1 (visual style preference), non-blocking.

```
SCALE ASSESSMENT:
  Files affected: 2 new subsystems (server read-API, frontend dashboard)
  Subsystems: HTTP server (new), frontend build pipeline (new) — down from 4 in the
    misattributed draft
  Migration required: no
  Cross-team coordination: no
  Unknowns: 1, non-blocking

  RECOMMENDATION: Medium scope — H/V planning (to slice server-API-first vs.
  frontend-first correctly), then straight to stories. Does NOT need a structured
  outline — this is well-understood, bounded, two-layer work now that the
  chat/LLM/adapter/self-building scope is gone. A real downgrade from the Large
  assessment the misattributed draft carried, which is the right outcome: most of that
  complexity left with the content that didn't belong to this epic.
```
