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
zero dependencies, and runs as a single supervised process guarded by a `/tmp` pidfile lock.

What works, honestly:

- **Capability-aware routing** — merged on `main`. `isHiveStory()` detects plugin-hive/Minerva-planned
  stories (by label, or by the `methodology:` + `steps:` + hive-role `agent:` shape Minerva emits) and
  forces them onto `HIVE_LANE` (Claude + plugin-hive), because Codex/Opencode lanes have no plugin-hive
  install and would silently self-block. Everything else honors `PROJECT_LANE`, falling back to
  `DEFAULT_LANE`.
- **Pure-code state-machine transitions** — merged on `main`. `in_progress → in_review` when the
  latest run is done and not failed; `in_review → done` **only** when a linked PR has actually merged
  (`state === 'merged'` or a non-null `merged_at`) — run status alone is never trusted as completion.
  Both scans re-derive candidates from live board state each cycle, so they're idempotent by
  construction.
- **Capacity discipline** — per-agent `maxInflight`, per-runtime `RUNTIME_CAP` (a shared runtime is
  capped as one pool, to avoid single-runtime contention collapse), and small per-cycle batch caps
  (`perCycleTotal` / `perCyclePerAgent`) so the router never mass-flips the board.
- **Human-todo filter (priority-1)** — issues labeled `human-todo` or `waiting_on: <human name>` are
  excluded from the agent pool before any lane logic and exported to `.pHive/human-queue.yaml` via
  `scripts/export-human-queue.mjs` for a human to triage.
- **Zombie recovery** — stale/failed `in_progress` issues are detected and re-run (or re-assigned),
  respecting `isHive` so recovery honors the same capability rule.
- **Safety** — only ever assigns / re-runs; never deletes or cancels. `--dry-run` computes and logs
  every decision without touching the board. 26 unit tests cover the pure decision logic against
  mocked board state.

**Where it lives / runs now:** a single supervised Node process on the hive
(`nohup ./supervisor.sh`), scanning an aligned-only set of Multica projects (Auriga / Heimdall /
Consus today) on a ~75s cycle. Pidfiles and JSONL logs land in `/tmp`.

**What is a stub / not yet wired:**

- The richer **routing engine** in `src/engine/` (on the `feat/routing-engine` branch) — a
  TypeScript board-state consumer with Multica/DB adapters, escalation, cross-instance lease locks,
  observability counters, and a verifier pool — is **recovered from the legacy `pantheon-orchestrator`
  and not yet integrated** with the live `.mjs` router. Treat it as a design source, not a running
  component.
- Only aligned projects with a real agent + repo are in the scan set; ~14 unaligned projects are
  deliberately out until they get agents/repos (an operator decision).
- Lane maps and agent IDs in `config.mjs` are hand-maintained against a specific workspace, not yet
  discovered dynamically.

---

## ② Goals — near-term next steps

- **Consolidate the remaining router PRs.** Several routing improvements are open (repo-provisioning
  gate, seed → Minerva planning-lane routing, bulk human-todo extraction, seed rerouting, the
  `auriga-build` review/release lane). Land the good ones on `main` and close the stale.
- **Methodology-aware `DEFAULT_LANE`.** Today `DEFAULT_LANE` is a flat spread across Codex agents;
  make the fallback itself capability/methodology-aware so a non-`PROJECT_LANE` story still lands on a
  runtime that can actually execute its declared methodology.
- **Reconcile the known routing gap.** `config.mjs` documents "unmapped projects" named in an epic
  that don't correspond to real Multica project IDs. Reconcile with Minerva/operator rather than
  fabricating entries.
- **Fold the engine in — or retire it.** Decide whether the `feat/routing-engine` TypeScript engine
  becomes Auriga's core (adapters + verifier pool + lease locks) or whether its good parts are ported
  into the running `.mjs` router. Either way, remove the two-implementations ambiguity.
- **Dynamic lane/agent discovery.** Stop hand-maintaining agent UUIDs; discover lanes and their
  capabilities from the substrate.
- **Metrics at every decision.** Emit a decision record per routing choice (lane, runtime, why) so
  routing policy can be A/B'd — the platform-wide toggle-and-compare model, applied to the router
  itself.

---

## ③ Long-term vision — route across ANY board

Today Auriga routes the Multica board. The long-term direction is **plugins / adapters that let
Auriga route across any ticket system** — Linear, Jira, GitHub Issues, YouTrack — not just Multica.

The router's decision core is already pure and substrate-agnostic: it operates on plain issue/run/PR
shapes, not Multica specifics. Formalize that boundary as an **adapter interface** (the
`src/engine/` adapters are the first sketch of this), and any board becomes a source: read its
todos, route them to the right lane, write status transitions back. The same capability-aware,
capacity-disciplined, human-filtered routing then works whether the tickets live in Jira or in
Multica — and a team can adopt Auriga's routing without adopting Multica.

Combined with Pantheon's toggle-and-compare model, this makes routing policy a first-class,
swappable, measurable thing: pick your board adapter, pick your lanes and runtimes, flip rules on and
off, and compare throughput and cost at every step.

---

## Good first contributions

- **Add a routing unit test** — extend `src/router/test/core.test.mjs` with an edge case (a new
  hive-story shape, a capacity boundary, a `waiting_on` variant).
- **Sharpen `isHiveStory` detection** — cover more of the real shapes Minerva emits without producing
  false positives on non-hive stories.
- **Improve the human-queue export** — richer `.pHive/human-queue.yaml` output (grouping, reason
  detail) from `scripts/export-human-queue.mjs`.
- **Sketch a board adapter** — a read-only GitHub Issues or Linear adapter matching the issue/run/PR
  shapes `core.mjs` consumes, as a proof of the §③ direction (no writes — just prove the shape maps).
- **Emit a decision record** — log a structured per-assignment record (lane, runtime, rationale) to
  the JSONL so routing choices become analyzable.
- **Docs** — tighten this file or the READMEs as the engine/router consolidation lands.

See [`README.md`](README.md) for how to run the router and where each piece lives.
