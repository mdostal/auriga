# Auriga — Vision

Auriga is the **router** of [Pantheon](https://github.com/mdostal/pantheon-v2): it senses board
state and dispatches each ticket to the lane and agent best able to do it. This doc is the
trajectory — three rungs from where it is today to where it's going. Contributors: pick a rung.

Platform-wide, Pantheon is built to be **swappable at every layer** — you can toggle any
language, model, plugin, or god on/off and compare the metrics at every step. Auriga is where that
philosophy is sharpest: it *is* the thing choosing between lanes and runtimes, so every routing rule
should be measurable and every target lane should be replaceable.

---

## ① Current — what actually runs today

The **auto-router** in [`src/router/`](src/router/) is live on the hive. It is plain Node (24+),
zero runtime dependencies, and runs as a single supervised process guarded by a `/tmp` pidfile lock
(or `flock -n 9` on a real lock file — see the supervisor's own history for why a bare pidfile
wasn't enough).

What works, honestly:

- **Capability-aware routing** — `isHiveStory()` detects plugin-hive/Minerva-planned stories (by
  label, or by the `methodology:` + `steps:` + hive-role `agent:` shape Minerva emits) and forces
  them onto `HIVE_LANE` (Claude + plugin-hive), because Codex/Opencode lanes have no plugin-hive
  install and would silently self-block. Everything else honors `PROJECT_LANE`, falling back to
  `DEFAULT_LANE`.
- **Pure-code state-machine transitions** — `in_progress → in_review` when the latest run is done
  and not failed; `in_review → done` **only** when a linked PR has actually merged — run status
  alone is never trusted as completion. Both scans re-derive candidates from live board state each
  cycle, so they're idempotent by construction.
- **Un-planned "seed" hand-off to Minerva** — a childless, top-level, unplanned ticket routes to
  the `minerva-dev` planning lane instead of a build lane (never falls back to
  `chooseAgentForProject` if the planning lane has no capacity — it skips the issue that cycle
  instead). This is the router's one existing "this isn't mine to build, hand it to whoever's job
  it actually is" pattern — the direct precedent for the hand-up/hand-down orchestration work in
  §③ below.
- **Capacity discipline** — per-agent `maxInflight`, per-runtime `RUNTIME_CAP` (a shared runtime is
  capped as one pool, to avoid single-runtime contention collapse), and small per-cycle batch caps
  (`perCycleTotal` / `perCyclePerAgent`) so the router never mass-flips the board.
- **Human-todo filter (priority-1)** — issues labeled `human-todo` or `waiting_on: <human name>` are
  excluded from the agent pool before any lane logic and exported to `.pHive/human-queue.yaml` via
  `scripts/export-human-queue.mjs` for a human to triage.
- **Zombie recovery, bounded** — stale/failed `in_progress` issues are detected and re-run (or
  re-assigned), respecting `isHive` so recovery honors the same capability rule, and gives up
  cleanly (logs + comments) past a configured retry cap instead of looping forever.
- **Safety** — only ever assigns / re-runs; never deletes or cancels. `--dry-run` computes and logs
  every decision without touching the board. 400+ router unit/integration tests cover the pure
  decision logic against mocked board state, plus a lint gate (`oxlint --deny-warnings`) enforced
  as the first step of `npm run test:all`.

**Where it lives / runs now:** a single supervised Node process per tenant, scanning an
aligned-only set of Multica projects on a ~75s cycle, talking to Pantheon's own `core-api` (never
Multica directly — see the adapter section below). Pidfiles and JSONL logs land in `/tmp`;
`AURIGA_INSTANCE_ID`/`AURIGA_TENANT_ID` stamp every log line so multiple concurrent instances stay
separable.

**Landed since the adapter interface (all shipped, not stubs):**

- **Adapter interface** (epic `p2-adapter-interface`) — `src/router/lib/adapters/` holds the
  `backlogAdapter` / `spawnAdapter` contracts, a real Multica-backed implementation, an in-memory
  stub for tests, and `pantheon-v2-l2` — **no longer a stub**: it's a real HTTP adapter to
  Pantheon's own `core-api` (cut over PR #65+), the only sanctioned path from Auriga to Pantheon.
  Auriga's container holds zero Multica credentials and has no direct network path to Multica.
- **Operator dashboard** (epic `p3-auriga-ui`) — a Vite/React read-only UI (epics list, story
  detail with dependency view, activity log) served by a local HTTP API over `.pHive/` planning
  state.
- **Public showcase + Star Atlas restyle** (epic `p4-auriga-branding`).
- **Operator-side MCP server + agent CLI** (epic `p5-agent-mcp-integration`) — `auriga agent
  init`/`agent status`, and a read-only MCP server (list board, get story detail, list
  blocked/in-flight) so an operator's own agent session can query Auriga's board directly.
  Deliberately read-only — write capability was scoped out pending its own safety design.
  Known follow-up, not yet picked up: `auriga_get_story`'s PR-lookup path is slow (~75s) on a
  board with a large PR count.
- **Real project registry** (epic `p6-project-registry`) — `auriga project scan`/`add`/`remove`/
  `list` replaces the router's old hand-edited project list with a real operator-facing CLI.
- **MemoryAdapter + orchestrator topology registry** (epic `t010-memory-and-topology`) — a third
  adapter interface (`recall`/`remember`, Mnemosyne-backed, direct-for-now since no Pantheon memory
  proxy exists yet) plus `src/router/orchestrator-topology.json`: a plain parent/children tree node
  an operator sets up by hand (`auriga orchestrator set-parent`/`add-child`/...).
- **`core.mjs` decomposed** (epic `t011-core-decomposition`) — the pure decision core split from
  one 1189-line file into five focused, independently-tested modules
  (`run-classification.mjs`/`story-identity.mjs`/`pr-matching.mjs`/`capacity.mjs`/
  `review-squad.mjs`), with `core.mjs` itself re-exporting everything so no call site changed.
- **Orchestrator hand-up** (epic `t015-orchestrator-hand-up`) — real logic on top of `t010`'s
  topology registry: a `hand-up`-labeled ticket this instance can't route locally is created on its
  registered parent's board (a genuinely new `createIssue` adapter capability — confirmed live
  against `core-api`'s real `POST /api/backlog/issues`), then closed/commented/unassigned locally.
  No configured parent falls through to the existing human-todo path unchanged. Recursive by
  construction — see §③. Hand-down (`t016`) is queued next, reusing the same primitive.

**What is genuinely not built yet:**

- Hand-**down** (parent→child) on top of the orchestrator topology — see `t016` in §③.
- Dynamic lane/agent discovery — `config-substrate.mjs`'s `AGENTS`/`PROJECT_LANE` are still
  hand-maintained against a specific workspace, not discovered live.
- Decision-record metrics — no per-assignment structured log (lane/runtime/rationale) exists yet
  for A/B-ing routing policy.
- A second real board adapter (Linear/Jira/GitHub Issues) — the adapter *interface* generalizes
  cleanly, but only Multica/Pantheon has an implementation.
- The earlier `feat/routing-engine` TypeScript board-state consumer (adapters, escalation,
  cross-instance lease locks, a verifier pool) mentioned in older versions of this doc — that
  branch no longer exists. Treat it as abandoned, not pending; any of its ideas worth reviving
  (lease locks, a verifier pool) would be a fresh design, not a resurrection of that branch.

---

## ② Goals — near-term next steps

- **Orchestrator hand-down (`t016`)** (see §③) — the concrete next slice now that hand-up (`t015`)
  has shipped: a `PROJECT_LANE`-style routing-table extension so a project can resolve to a specific
  CHILD board instead of a local agent, reusing `t015`'s cross-board `createIssue` primitive
  unchanged.
- **Methodology-aware `DEFAULT_LANE`.** Today `DEFAULT_LANE` is a flat spread across Codex agents;
  make the fallback itself capability/methodology-aware so a non-`PROJECT_LANE` story still lands on
  a runtime that can actually execute its declared methodology.
- **Dynamic lane/agent discovery.** Stop hand-maintaining agent UUIDs; discover lanes and their
  capabilities from the substrate.
- **Metrics at every decision.** Emit a decision record per routing choice (lane, runtime, why) so
  routing policy can be A/B'd — the platform-wide toggle-and-compare model, applied to the router
  itself.

---

## ③ Long-term vision — route across ANY board, and across ANY level of a tree of Aurigas

Today Auriga routes one Multica/Pantheon board. Two directions extend that, and they compose:

**Route across any ticket system.** The router's decision core is already pure and
substrate-agnostic: it operates on plain issue/run/PR shapes, not Multica specifics. The adapter
interface already formalizes this boundary — any board becomes a source: read its todos, route
them to the right lane, write status transitions back. The same capability-aware,
capacity-disciplined, human-filtered routing then works whether the tickets live in Jira or in
Multica — and a team can adopt Auriga's routing without adopting Multica. No second adapter exists
yet; this is still aspirational, not started.

**Route across a tree of Auriga instances.** `t010-memory-and-topology` landed the data shape (a
committed `orchestrator-topology.json` — one parent, many children, manually wired per instance)
but deliberately built zero logic on top of it. `t015` (shipped 2026-09-06) landed the up-direction
on the real shape, driven by the operator's actual multi-level deployment: per-project "meta
orchestrators" at e.g. a Dostal Tech / Firefly Events / Personal level, mostly handing tickets
directly to the right repo/runner today; a hypothetical top-level "meta of everything" orchestrator
above them would only need to know its own children and hand a ticket down to the right one (e.g.
"make a ticket for Firefly Events' Flayr app" fires it into Firefly Events' own board and lets that
instance's own Minerva/architect/runners take it from there). Two structural findings fell out of
that conversation:

- **Hand-up is recursive by construction, with no multi-level code required.** Every instance runs
  the identical local rule against its own `topology.parent`. If a parent can't route a handed-up
  ticket either and has its own parent, its next cycle hands it up again automatically — recursion
  is a property of the tree shape, not something any one instance's code has to implement.
- **Hand-down is the same shape as hand-up, and the same shape as today's existing `PROJECT_LANE`
  routing table** — "which child owns this project" is structurally identical to "which agent lane
  owns this project," just a different kind of target. Both directions share one real new
  capability: a cross-board `createIssue` write (genuinely new — no adapter creates tickets today,
  only acts on existing ones), config-driven via an extended topology schema (real
  adapter/reachability info per node, or a reference into `AURIGA_CONFIG`'s existing multi-tenant
  pattern).

Sequenced as two epics sharing that one primitive: **`t015` (shipped)** did the up-direction only
(one parent, no selection ambiguity, explicit-label-triggered) — no auto-detection of "doesn't
fit," no operator-chat ticket-origination surface (a separate, bigger question: does a top-level
orchestrator even have its own board, or does it work from pure conversational input?). **`t016`**
(queued next, not started) adds hand-down: a `PROJECT_LANE`-style routing-table extension so a
project can resolve to `{ kind: 'child', childId }` instead of `{ kind: 'agent', lane }`, reusing
`t015`'s cross-board-write primitive unchanged.

Combined with Pantheon's toggle-and-compare model, this makes routing policy — and now routing
*topology* — a first-class, swappable, measurable thing: pick your board adapter, pick your lanes
and runtimes, pick where a given instance's authority ends and its parent's begins, flip rules on
and off, and compare throughput and cost at every step.

---

## ④ Auriga's UI — a clean operator dashboard (landed, epic `p3-auriga-ui`)

Auriga has a simple operator dashboard — a clean, focused surface for seeing Auriga's state
(epics/stories/status, the audit/log trail of what it's done), nothing more. Built on
**shadcn/ui + Vite/Tailwind** as an isolated frontend package, separate from the router's
zero-dep backend.

*(Correction, 2026-08-17: an earlier version of this section described a general-purpose,
LLM-assisted, self-building UI-creation tool — v0-style code generation, templates, "create
new components/charts/dashboards as needs grow." That was written for **Janus** (Pantheon's
UI-creation portal), not Auriga, and got recorded here by mistake. Auriga is an orchestrator,
not a UI builder — its own UI stays a simple, clean dashboard. The corrected content has been
moved out; Janus's own repo/VISION.md is the right home for it.)*

---

## Good first contributions

- **Design `t016` (hand-down)** (§③, the current active planning item) — pick up
  `.pHive/epics/t016-*` once its design discussion exists, or help scope the child-selection
  question (a `PROJECT_LANE`-style routing table entry resolving to `{ kind: 'child', childId }`).
- **Add a routing unit test** — extend the relevant `src/router/test/*.test.mjs` file with an edge
  case (a new hive-story shape, a capacity boundary, a `waiting_on` variant).
- **Sharpen `isHiveStory` detection** — cover more of the real shapes Minerva emits without producing
  false positives on non-hive stories.
- **Improve the human-queue export** — richer `.pHive/human-queue.yaml` output (grouping, reason
  detail) from `scripts/export-human-queue.mjs`.
- **Sketch a second board adapter** — a read-only GitHub Issues or Linear adapter matching the
  issue/run/PR shapes `core.mjs` consumes, as a proof of the §③ any-board direction (no writes —
  just prove the shape maps).
- **Emit a decision record** — log a structured per-assignment record (lane, runtime, rationale) to
  the JSONL so routing choices become analyzable.

See [`README.md`](README.md) for how to run the router and where each piece lives.
