# Auriga Router

The auto-router: the decide+assign layer that self-drains the Multica board by
routing unassigned todos to Pantheon swarm agents. Runs live on the hive.

## Run

```sh
# one-shot (no daemon)
npm run once      # node auriga-router.mjs --once
npm run dry       # --once --dry-run

# supervised (keeps exactly ONE detached router alive, restarts on death)
nohup ./supervisor.sh >> /tmp/auriga-supervisor.log 2>&1 &
```

`supervisor.sh` defaults `DIR` to this directory
(`~/Documents/work/dostal/code/auriga/src/router`) and `NODE` to the mise
node 24 install. Override via env if needed.

## Files / paths

- `auriga-router.mjs` — entrypoint / scan loop.
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs`, `planning.mjs`.
- `test/core.test.mjs`, `test/planning.test.mjs` — `npm test`.
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.

## Planning lane — seeds vs. planned stories (`lib/planning.mjs`)

**The rule:** a raw / un-planned ticket is a **SEED**. Auriga never hand-creates
story tickets — it routes a seed to the planning agent (`minerva-dev`), which
runs **plugin-hive** kickoff+plan (via `minerva-plan`) and files the
dependency-ordered **PLANNED stories** back to Multica as sub-issues of the
seed. Only those planned stories then reach a dev **BUILD** lane, where the dev
agent runs **plugin-hive** `/hive:execute` on the story and then `/hive:review`
+ `/hive:test`. Every processing stage is plugin-hive — nothing is ad-hoc.

```
SEED ──Auriga──▶ minerva-dev ──/hive:kickoff + /hive:plan──▶ PLANNED stories
                                                                   │
        (sub-issues, left unassigned; Minerva's plan produces them)│
                                                                   ▼
                          dev agent ──/hive:execute ▶ /hive:review ▶ /hive:test ▶ push
```

**Convention (labels are workspace entities, matched by NAME):**

| marker on a **top-level** ticket | role | routed to |
|---|---|---|
| label `idea` / `needs-plan` (`consus-idea`) | **seed** | planning lane (`minerva-dev`) |
| label `idea`/`needs-plan` **and it already has sub-issues** | **epic** | skipped (planning done; only its stories build) |
| label `planned` / `epic` (with sub-issues) | **epic** | skipped |
| label `planned` (no sub-issues) | **story** | build lane |
| a **sub-issue** (`parent_issue_id` set) | **story** | build lane |
| unmarked (no seed/planned label) | **other** | build lane (today's default) |

Config lives in `config.mjs` → `PLANNING` (`agent`, `seedLabels`,
`plannedLabels`, `seedFallback`, `maxPerCycle`). `seedFallback` is **off** by
default, so the running dev board is never hijacked — only explicitly-marked
seeds get planned. Turn it on to treat every unmarked childless top-level ticket
as a seed.

**Escalation (minerva-plan exit 2 — parked on a real strategic gate):** handled
agent-side. `minerva-dev` comments the open questions on the seed and sets it to
`blocked`; a `blocked` (non-todo) seed drops out of the candidate pool, so the
router never silently re-routes it — it waits for a human / Consus to resolve
the gate. The router only ever **assigns** (never deletes/cancels).

Router log events: `plan_route` (a seed routed to planning), `plan_assign_error`;
`scan` now also reports `seedTodos`.
