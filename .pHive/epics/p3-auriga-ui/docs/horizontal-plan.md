# Horizontal Planning Scan: UI for Auriga

**Input:** design-discussion.md (rescoped — clean read-only dashboard, no chat/LLM)

## 1. Layer Inventory

- **Read layer** — parses `.pHive/` state (epics, story YAMLs, post-run audit records)
  and recent git log into plain JSON-shaped data. Doesn't exist today.
- **Server/API layer** — `node:http` server exposing that data as JSON endpoints and
  serving the built frontend. Doesn't exist today.
- **Frontend layer** — Vite + Tailwind + shadcn/ui dashboard: epics list, story detail,
  activity/log view. Doesn't exist today.
- **Build/tooling layer** — `src/ui/`'s `package.json`, Vite config, Tailwind config,
  shadcn `components.json`. Doesn't exist today.

## 2. Per-Layer Requirements

```
## Layer: Read

FUNCTIONS NEEDED:
  - listEpics() — scan .pHive/epics/*/epic.yaml, return [{id, title, status per
    story rollup, story_count, docs_path}]
  - getEpic(id) — one epic's full detail: stories[] (id, title, status, complexity,
    depends_on), docs list (research-brief, design-discussion, etc.)
  - getStory(epicId, storyId) — one story's full YAML content (acceptance_criteria,
    cross_cutting, status, etc.)
  - listActivity() — recent git log (subject, hash, date) + post-run audit records
    from .pHive/audits/post-run/*.yaml, merged and sorted by time

DATA SOURCES:
  - .pHive/epics/*/epic.yaml, .pHive/epics/*/stories/*.yaml
  - .pHive/audits/post-run/*.yaml
  - `git log` (via execFileSync — same synchronous-CLI convention as the router's
    adapters, no new async pattern introduced)

---

## Layer: Server/API

ENDPOINTS NEEDED:
  - GET /api/epics — listEpics()
  - GET /api/epics/:id — getEpic(id)
  - GET /api/epics/:id/stories/:storyId — getStory(epicId, storyId)
  - GET /api/activity — listActivity()
  - Static file serving for the built src/ui/ frontend (dist/ output)

BEHAVIOR:
  - Read-only, no write endpoints of any kind (v1 is display-only)
  - Missing/malformed epic or story YAML degrades gracefully (skip + log, never 500
    the whole listing for one bad file)

---

## Layer: Frontend

VIEWS:
  - EpicsListView — table/cards: id, title, status, story count, link to detail
  - StoryDetailView — acceptance criteria, cross_cutting, status, dependencies
  - ActivityView — chronological feed: commits + audit records

COMPONENTS (shadcn/ui):
  - Table or Card (epics list)
  - Badge (status)
  - Tabs or simple routing between the three views
  - Basic layout shell (nav/header)

STATE:
  - Simple fetch-on-mount per view, no complex client state management needed for a
    read-only v1 (no Redux/Zustand — plain React state + fetch is enough)

---

## Layer: Build/Tooling

  - src/ui/package.json — Vite, React, Tailwind, shadcn CLI-managed components
  - vite.config — dev server + build, proxies /api to the Node server in dev mode
  - tailwind.config — scoped to src/ui/ only
  - components.json — shadcn config
  - Scaffold's default ESLint/Prettier, scoped to src/ui/ only
```

## 3. Cross-Layer Dependencies

```
DEPENDENCIES:

Server/API → Read layer (endpoints call the read functions directly)
Frontend → Server/API (fetches JSON from /api/* at runtime)
Frontend build output → Server/API (server serves the built dist/ as static files)
Build/Tooling → Frontend (Vite/Tailwind/shadcn are how the frontend gets built at all)
```

Simple, linear dependency chain — no cycles, no ambiguity about ordering. The read
layer can be built and tested in complete isolation (pure functions over `.pHive/`
files); the server layer needs it; the frontend needs the server's API contract to
exist (even if just documented) before it can meaningfully render real data.

## 4. Layer Map Diagram

```
HORIZONTAL LAYER MAP
─────────────────────────────────────────────────────────────

Frontend     │ EpicsListView   │ StoryDetailView │ ActivityView │
             │ (table/cards)   │ (criteria/deps) │ (feed)       │
─────────────┼─────────────────┼─────────────────┼──────────────┤
Server/API   │ GET /api/epics  │ GET .../stories/ │ GET /api/    │
             │ (+ /:id)        │ :storyId         │ activity     │
─────────────┼─────────────────┼─────────────────┼──────────────┤
Read         │ listEpics/      │ getStory         │ listActivity │
             │ getEpic         │                  │ (git+audits) │
─────────────┼─────────────────┼─────────────────┼──────────────┤
Build/Tooling│ Vite + Tailwind + shadcn/ui, scoped to src/ui/    │
─────────────────────────────────────────────────────────────
```

## 5. Scope Summary

```
HORIZONTAL SCOPE:
  Layers affected: 4 (read, server/API, frontend, build/tooling)
  Total items: ~4 read functions, 4 API endpoints, 3 frontend views, 1 tooling setup
  New vs modified: 100% new — no existing code modified
  Estimated total effort: medium

  LARGEST LAYER: Frontend (3 views + component setup)
  RISKIEST LAYER: Build/Tooling (first-ever adoption of a build pipeline in this
    repo — not risky in the "could break something" sense since it's fully isolated,
    but the least-precedented layer)
```
