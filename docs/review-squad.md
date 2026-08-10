# Review Squad — the back-half of the loop (PAN-6546)

Auriga is the thin top orchestration loop (the "super-queen" ROLE) that routes. When a
story lands in `in_review` with an open PR, Auriga fires a **review SQUAD** — a real
multi-perspective review that TRULY verifies — then the squad either ships (merge to
`dev` + story `done`) or sends it back with concrete per-perspective feedback. Auriga
does NOT become the squad; it classifies + fires one dispatch carrying a plan.

## The four perspectives

| Perspective | What it judges | How it verifies |
|-------------|----------------|-----------------|
| **product (PO)** | Does the diff satisfy THIS story's intent / acceptance? | reads ticket intent vs delivered diff (persona: tpm/analyst) |
| **technical** | correctness, conventions, security, maintainability | `/hive:review` (`--security` for auth/secret/data) on the real diff |
| **qa** | TRUE verification, never a diff read | checks out the branch, runs the REAL build + tests, **Playwright/E2E** for user-facing/behavioral changes (`/hive:test`) |
| **ux** | user-facing surface quality + accessibility | `/hive:design-review` / visual-qa against the running UI |

Each perspective returns its own verdict (PASS / CHANGES / N-A). The squad merges ONLY
when every **enabled** perspective is PASS and QA actually ran; any CHANGES → loop back
with per-perspective feedback. It never force-merges a failing PR.

## Scale by ticket type (do NOT run the full team on everything)

`core.reviewSquadPlan(issue, cfg)` sizes the squad from `config.REVIEW_SQUAD_RULES`
(explicit, inspectable keyword + tier map). The DEFAULT posture is the full four
("each and every ticket"); a perspective is dropped ONLY on a clear signal it is
inapplicable, and the reason is logged.

| tier | trigger | perspectives | Playwright |
|------|---------|--------------|-----------|
| `full` | user-facing/UI signals (react, page, dashboard, css, component, …) | product + technical + qa + **ux** | ON |
| `backend` | headless api/service/data signals (endpoint, service, schema, router, …) | product + technical + qa (UX dropped — nothing to look at) | off |
| `light` | docs/chore/config signals (readme, typo, chore, config, …) | technical + qa-smoke (product + UX dropped) | off |
| `standard` | no decisive signal | the full four (safe default) | ON |

The router logs the plan (`tier`/`perspectives`/`playwright`) on dispatch and POSTS it
onto the ticket (`REVIEW SQUAD PLAN — squad[tier]: …`) so what the squad will do is
visible up front and read by the squad agent.

## Where it lives

- `src/router/lib/core.mjs` — `reviewSquadPlan` + `squadPlanSummary` (pure, unit-tested).
- `src/router/lib/config.mjs` — `REVIEW_SQUAD_RULES` (the inspectable rule).
- `src/router/lib/multica.mjs` — `issueComment` (publish the plan onto the ticket).
- `src/router/auriga-router.mjs` — review dispatch: compute plan → log → comment → fire.
- `src/router/agents/auriga-review.instructions.md` — the SQUAD lead: reads the plan,
  runs each enabled perspective, aggregates, ships or loops back.
- `src/router/test/squad.test.mjs` — 9 classifier tests (suite: 85/85 green).

## Live proof (2026-07-31)

Classifier run against the real live board (30 `in_review` tickets) produced correct
tiers, e.g. `PAN-6955` (Consus web UI) → `full` + Playwright; `PAN-5584` (config) →
`light`; `PAN-6999` (router/dispatch) → `backend` (UX dropped).

Full squad run against a real open PR — **mdostal/mnemosyne#1** (`feat/m-01-service`, a
headless memory service, base `main`), sized `backend`:

- **product: PASS** — delivers the minimal running service (health/scopes/recall/remember).
- **technical: CHANGES** — PR targets `main`; review/ship only merges into `dev` (mnemosyne
  has a `dev` branch). Retarget required. (Code itself clean: zero deps, `execFile` not
  shell → no injection, request-size guard.)
- **qa: PASS (real verification)** — checked out the branch, `npm install`, ran the real
  `node test/smoke.mjs`: 5/5 checks green incl. a live remember→recall **round-trip against
  Qdrant**. No Playwright (headless backend).
- **ux: N-A** — no user surface.

Outcome: **SENT BACK** with concrete per-perspective feedback (one required change:
base `main`→`dev`), NOT force-merged. Posted to the PR:
https://github.com/mdostal/mnemosyne/pull/1#issuecomment-5148612439
