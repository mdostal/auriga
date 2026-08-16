# Project CONTEXT

Auriga is the router god of Pantheon — today a live Node router that dispatches
Multica board tickets to agent lanes; the direction (see VISION.md) is a
standalone, adapter-based top-level orchestrator any project can consume.

## Terminology

- **Lane** — a named routing target (`HIVE_LANE`, `DEFAULT_LANE`, `PROJECT_LANE`) mapping to one or more agents in `src/router/lib/config.mjs`. Capability-aware routing forces hive-authored stories onto `HIVE_LANE`.
- **Hive story** — a story whose shape (label, or `methodology:` + `steps:` + hive-role `agent:`) marks it as planned by Minerva/plugin-hive; detected by `isHiveStory()` in `lib/core.mjs`. Must route to a Claude+plugin-hive lane — Codex/Opencode lanes have no plugin-hive install.
- **Review squad** — the back-half verification loop: when a story reaches `in_review` with an open PR, Auriga fires a 4-perspective squad (product/technical/qa/ux), sized by ticket-type tier (`full`/`backend`/`light`/`standard`). See `docs/review-squad.md`. Auriga classifies and dispatches; it never becomes the squad itself.
- **Zombie recovery** — detection and re-run/re-assignment of stale or failed `in_progress` issues, respecting the same `isHiveStory` capability rule as fresh dispatch.
- **Human-todo filter** — issues labeled `human-todo` or with `waiting_on: <name>` are excluded from the agent pool before any lane logic and exported to `.pHive/human-queue.yaml` for human triage.
- **Adapter interface** (target state, not yet built) — the boundary this kickoff exists to add: a backlog adapter (source of tasks — Multica, Linear, etc.) and a persona/spawn adapter (how to fan work out — e.g. Multica's squads/runners), so Auriga's core never imports a vendor-specific module directly. See `north_star` in `.pHive/project-profile.yaml`.
- **pantheon-v2 L2 adapter** (target state, stub only) — the ONLY sanctioned path from Auriga to Pantheon. Auriga must never call Minerva, Consus, or Pantheon directly.

## Key paths

- `src/router/auriga-router.mjs` — main CLI entrypoint / cycle loop (`--once`, `--dry-run`, `--max-assign`, `--no-zombie`).
- `src/router/lib/core.mjs` — pure, unit-tested decision logic (routing, capacity, state machine, review-squad sizing). No I/O.
- `src/router/lib/multica.mjs` — the one hardcoded I/O boundary (execFileSync wrapper around the `multica` CLI). This is what the adapter interface work needs to generalize.
- `src/router/lib/config.mjs` — hand-maintained agent UUIDs, lane maps, and capacity caps against one specific live Multica workspace.
- `src/router/test/` — unit + loop-level e2e tests (`node:test`), including `router-cycle.e2e.test.mjs` against a mocked Multica CLI (`test/support/mock-mca.mjs`).
- `src/router/agents/*.instructions.md` — agent instruction prompts for build/review lanes.
- `src/engine/` (on branch `feat/routing-engine`, not merged) — a TypeScript board-state consumer recovered from the legacy `pantheon-orchestrator`; a design source for the adapter work, not a running component.
- `.pHive/epics/p1-dispatch-throughput/` — prior epic converting dispatch throughput to done-throughput (capability routing, state machine, human filter, etc.) — largely describes what VISION.md §① calls "current, what actually runs today."

## Conventions

- Pure-core / thin-shell split: routing/capacity/state-machine decisions live in pure, mockable functions in `lib/core.mjs`; all I/O (Multica CLI calls, config) stays outside it.
- Never squash-merge unless deliberately killing off history — prefer real merge commits (`hive.config.yaml -> developer.pr_style: atomic-prs`).
- Root `package.json` exists solely so the generic CI gate (`ci.yml`) finds a Node `test` script at repo root; the real module lives in `src/router/` with its own `package.json`.

## Canonical references

- `README.md` — architecture diagram, quickstart, sibling-gods overview.
- `VISION.md` — three-rung trajectory (① current ② near-term ③ long-term adapter-based any-board routing) — the direct precursor to this kickoff's north_star.
- `docs/review-squad.md` — review squad design + live proof.
- `.pHive/project-profile.yaml -> north_star` — the standalone/adapter-interface goal this kickoff captured.
