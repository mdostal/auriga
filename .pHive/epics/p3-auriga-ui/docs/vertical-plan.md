# Vertical Planning — Slice Plan: UI for Auriga

**Input:** horizontal-plan.md + design-discussion.md (rescoped)

## 1. Slicing Strategy

```
STRATEGY:
  Total horizontal items: ~12 across 4 layers
  Planned slices: 4
  First slice goal: prove the read layer + a minimal API work against THIS repo's
    real .pHive/ data, curl-testable, before any frontend exists
  Final slice goal: the full read-only v1 dashboard, Playwright-verified against
    real data, hardened against missing/malformed files

  Slicing rationale: the dependency chain is linear (read → API → frontend), so
  slices follow it directly — no interesting reordering options here, unlike the
  adapter epic's slice 5. The build/tooling setup is folded into slice 2 (it has no
  standalone value on its own — nobody wants "an empty Vite project" as a milestone).
```

## 2. Vertical Slice Plan

```
## Slice 1: Read layer + minimal API, no frontend yet

WHAT WORKS AFTER THIS SLICE:
  `curl localhost:PORT/api/epics` (and the other 3 endpoints) returns real JSON
  built from this repo's actual .pHive/ state — p1-dispatch-throughput,
  p2-adapter-interface, and this epic itself, once it exists. No frontend, no
  browser, no build tooling yet.

LAYERS TOUCHED:
  Read: listEpics, getEpic, getStory, listActivity
  Server/API: all 4 GET endpoints, no static file serving yet

NOT YET:
  Frontend, build tooling, static file serving

VERIFIED BY:
  node:test: read functions against this repo's real .pHive/ fixtures (not mocks —
    the actual epic/story YAMLs on disk) plus a synthetic malformed-YAML case to
    prove graceful degradation
  node:test: API endpoints return correct shapes/status codes

COMMIT REPRESENTS: A working, curl-testable read API over Auriga's real state

---

## Slice 2: Frontend scaffold + epics list, wired to the real API

BUILDS ON: Slice 1

WHAT WORKS AFTER THIS SLICE:
  Opening the dashboard in a browser shows a real list of this repo's epics (status,
  story counts) fetched from the Slice 1 API — the first actual visual proof this is
  working, not a mockup.

LAYERS TOUCHED:
  Build/Tooling: src/ui/ package.json, Vite, Tailwind, shadcn init + first components
  Server/API: static file serving for the built frontend added
  Frontend: EpicsListView only

NOT YET:
  Story detail view, activity view

VERIFIED BY:
  Playwright: navigate to the dashboard, assert the epics list renders real epic IDs
    from this repo (e.g. "p2-adapter-interface" actually appears on the page)

COMMIT REPRESENTS: The dashboard exists and shows real data for the first time

---

## Slice 3: Story detail + activity views — v1 feature-complete

BUILDS ON: Slice 2

WHAT WORKS AFTER THIS SLICE:
  Clicking an epic shows its real stories with real acceptance criteria and status;
  a separate activity view shows the real git/audit-record log. This is the full v1
  dashboard as scoped in design-discussion.md §1.

LAYERS TOUCHED:
  Frontend: StoryDetailView, ActivityView, basic nav between the three views

NOT YET:
  Any write/interaction capability (out of scope for v1 entirely, not just this slice)

VERIFIED BY:
  Playwright: click through from epics list → a real story's detail page, assert
    real acceptance criteria text appears
  Playwright: activity view shows a real, recent commit from this repo's own git log

COMMIT REPRESENTS: v1's full read-only feature set is complete and demoable

---

## Slice 4: Hardening — malformed/missing data, empty states, polish

BUILDS ON: Slice 3

WHAT WORKS AFTER THIS SLICE:
  The dashboard doesn't break on edge cases: an epic with zero stories, a story
  missing optional fields, `.pHive/` being freshly initialized with nothing in it
  yet. This is what makes v1 actually trustworthy to open day-to-day, not just a demo.

LAYERS TOUCHED:
  Read + Frontend: error/empty-state handling added across all four views' worth of
    data paths

NOT YET:
  (nothing deferred beyond this epic's already-stated boundary — chat/LLM/interaction)

VERIFIED BY:
  node:test + Playwright: empty-.pHive/ and malformed-YAML scenarios render a sane
    empty/error state instead of a blank page or crash

COMMIT REPRESENTS: v1 is genuinely done, not just demo-shaped
```

## 3. Overlay Diagram

```
VERTICAL SLICE OVERLAY
───────────────────────────────────────────────────────────────

              │ Slice 1     │ Slice 2      │ Slice 3      │ Slice 4    │
              │ (Read+API)  │ (Scaffold+   │ (Full v1)    │ (Harden)   │
              │             │  epics list) │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼────────────┤
Read          │ full        │              │              │ error/empty│
              │             │              │              │ handling   │
──────────────┼─────────────┼──────────────┼──────────────┼────────────┤
Server/API    │ 4 endpoints │ static files │              │            │
──────────────┼─────────────┼──────────────┼──────────────┼────────────┤
Frontend      │             │ EpicsList    │ StoryDetail  │ error/empty│
              │             │              │ + Activity   │ states     │
──────────────┼─────────────┼──────────────┼──────────────┼────────────┤
Build/Tooling │             │ full setup   │              │            │
───────────────────────────────────────────────────────────────

Each column is a commit-worthy, working state.
```

## 4. Deferred Items

```
DEFERRED (explicitly out of THIS epic, not "later slices"):
  - Any chat/LLM/self-building capability — belongs to Janus, not Auriga
  - Any interaction/action capability (dispatch, edit, trigger anything) — v1 is
    display-only by explicit decision; a future epic if/when it's actually wanted
  - Mobile layout — desktop browser only for v1

RATIONALE: all three are real, explicit scope boundaries from design-discussion.md,
not things this slice plan ran out of room for.
```

## 5. Risk by Slice

```
RISK PER SLICE:
  Slice 1: Low — pure read functions + thin HTTP layer, no UI, easy to test in
    isolation against real files already on disk.
  Slice 2: Low-medium — first-ever build-tooling adoption in this repo; the actual
    risk is unfamiliarity/setup friction (Vite+Tailwind+shadcn config), not logic risk.
  Slice 3: Low — mostly more of the same pattern from Slice 2, no new architecture.
  Slice 4: Low — hardening pass, no new capability, just edge-case coverage.
```

## 6. Moldability Notes

- Slices 1-3 are strictly sequential (linear dependency chain, per horizontal-plan.md
  §3) — no reordering opportunity here.
- Slice 4 could be trimmed if time is tight (ship v1 as a working demo, harden as a
  fast-follow) — but given this is meant to be an everyday-use dashboard, not a demo,
  keeping it in this epic is the right call unless you say otherwise.
- If Slice 2's build-tooling setup turns out friskier than expected (Tailwind v4's
  known CLI auto-detection issues, per research), that's a signal to pin an older,
  more stable Tailwind/shadcn version rather than fight bleeding-edge tooling — not a
  reason to abandon the slice boundary.
