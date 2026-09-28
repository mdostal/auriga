# Auriga Router

The auto-router: the decide+assign layer that self-drains the Multica board by
routing unassigned todos to Pantheon swarm agents. Runs live on the hive.

## State-machine transitions (pure code, no agent calls)

Every cycle, before routing new todos, the router also advances issue status
based on board state alone:

- `in_progress -> in_review`: fires when an issue's latest run
  (`multica issue runs`) is done and not failed (`core.classifyRun(...).done`).
  See `core.detectRunCompletions`.
- `in_review -> done`: fires only when a PR linked to the issue
  (`multica issue pull-requests`) has actually merged (`state === 'merged'` or
  a non-null `merged_at`) — `runStatus` alone is never trusted as completion.
  See `core.detectVerifiedDone`.

Both scans re-derive their candidate set from live board state each cycle, so
a transitioned issue simply falls out of its source filter next cycle —
idempotent by construction. Atomicity across concurrent router processes comes
from the existing single-instance pidfile lock (`acquireLock`/`PIDFILE`), the
same guard the assign/rerun path already relies on.

## Run

```sh
# one-shot (no daemon)
npm run once      # node auriga-router.mjs --once
npm run dry       # --once --dry-run

# supervised (keeps exactly ONE detached router alive, restarts on death)
./supervisor.sh                    # router JSONL -> this terminal / container stdout
ROUTER_LOG=/tmp/auriga-router.log SUP_LOG=/tmp/auriga-supervisor.log \
  nohup ./supervisor.sh &          # bare host: keep log files instead
```

`supervisor.sh` is POSIX `sh` (runs unchanged in the alpine image). It uses
`node` from `PATH` (override with `NODE`; it exits 1 if no node is found) and
defaults `DIR` to its own directory. Its flock lock defaults to
`auriga-supervisor.lock` next to the router pidfile
(`AURIGA_SUPERVISOR_LOCK`). Router output is inherited unless `ROUTER_LOG` is
set, supervisor messages go to stderr unless `SUP_LOG` is set, and it checks
liveness every `AURIGA_SUPERVISOR_INTERVAL` seconds (default 30). Requires
`flock` (busybox provides it on alpine).

## Observability

### Log sink

The router writes one JSON object per line. With `AURIGA_LOG` unset (the
container default) it writes to **stdout**, so `docker logs` / the collector
sees every event. With `AURIGA_LOG` set it appends to that file instead and
stdout stays quiet (if the file can't be written, the line falls back to
stdout). Every record carries `ts` and `event`, plus `instance_id` /
`tenant_id` when `AURIGA_INSTANCE_ID` / `AURIGA_TENANT_ID` are set
(multi-tenant mode stamps each tenant's own `tenant_id`).

### `cycle_summary` event

Every `cycle()` ends with exactly one `cycle_summary`, in single- and
multi-tenant mode (one per tenant cycle there). It is emitted even when a pass
throws part-way: the summary is marked `aborted` and the error then propagates
to the existing `cycle_error` / `tenant_cycle_error` line.

```json
{
  "ts": "2026-09-27T22:00:00.000Z",
  "event": "cycle_summary",
  "duration_ms": 1834,
  "issues_scanned": 212,
  "todo": 3, "picked": 2, "assigned": 2,
  "passes": {
    "unblocked": 0, "parent_rollup": 0, "in_review": 1, "verified_done": 0,
    "changeback": 0, "cascade": 0, "zombie": 0, "assigned_idle": 0,
    "review": 1, "routed": 2, "hand_up": 0
  },
  "errors": 0,
  "aborted": false,
  "blocked_runtimes": [],
  "dry_run": false
}
```

| Field | Meaning |
|---|---|
| `duration_ms` | Wall-clock time of the cycle. |
| `issues_scanned` | Issues returned by the board scan (0 if the scan itself failed). |
| `todo` / `picked` / `assigned` | Same as `cycle()`'s return value; `null` when the cycle aborted. |
| `passes.*` | Decision events emitted per pass, counted whether applied or `dry_run`. `unblocked` / `parent_rollup` / `in_review` / `verified_done` / `changeback` = `advance` events of that kind; `cascade` = `cascade_dispatch`; `zombie` = `zombie` + `zombie_give_up`; `assigned_idle` = `assigned_idle` + `assigned_idle_unassign` + `archived_agent_unassign`; `review` = `review`; `routed` = `route`; `hand_up` = `hand_up`. Mapping: `passForEvent()` in `lib/observability.mjs`. |
| `errors` | Number of `*_error` events this cycle, plus 1 if the cycle aborted. |
| `aborted` / `abort_error` | `true` and the error message when a pass threw out of `cycle()`. |
| `blocked_runtimes` | Runtimes rate-limit-blocked by the end of the cycle (sorted). |
| `dry_run` | Whether the cycle ran with `--dry-run`. |

A healthy idle router shows `cycle_summary` every `AURIGA_CYCLE_MS` with
`errors: 0` and zero pass counts. A wedged one stops emitting it.

### Heartbeat + container healthcheck

After every `cycle_summary` the daemon atomically rewrites a heartbeat file
(the summary JSON plus `pid`) at `AURIGA_HEARTBEAT_FILE`, default
`auriga-router.heartbeat` next to the pidfile (`/tmp/auriga-router.heartbeat`
with the default `AURIGA_PIDFILE`). In multi-tenant mode an iteration that
finds no tenants still refreshes it, so the check measures loop liveness, not
tenant availability. Tests that call `cycle()` directly write no heartbeat
unless they pass `opts.heartbeatFile`.

`bin/healthcheck.mjs` exits 0 while the heartbeat's mtime is newer than
`AURIGA_HEALTH_MAX_AGE_MS`, and 1 when it is missing or stale. The default max
age is 3 × `AURIGA_CYCLE_MS` (75 s default → 225 s). A cycle's own duration
(verify sleeps, API latency) adds to the gap between heartbeats, so raise the
limit if cycles routinely run long. It reads the same env as the router, so
run it inside the router's container:

```dockerfile
HEALTHCHECK --interval=60s --timeout=10s --start-period=180s --retries=2 \
  CMD node /app/src/router/bin/healthcheck.mjs || exit 1
```

(Adjust `/app` to wherever the image copies the repo. Keep `--start-period`
longer than the first cycle, because no heartbeat exists before it finishes.)

## Human-todo filter (priority-1)

Issues labeled `human-todo`, or carrying metadata `waiting_on: <human name>`
(names configured in `lib/config.mjs` `HUMAN_NAMES`), are excluded from the
dispatch candidate pool — see `isHumanTodo` in `lib/core.mjs`. This is a
priority-1 rule: it runs before any lane/capacity logic in
`selectAssignments`, so these issues never reach an agent. `waiting_on` values
that don't match a known human name (e.g. an issue identifier like
`PAN-1234`, meaning "waiting on that dependency") are left in the normal
dispatch pool.

Excluded issues aren't just dropped — run
`node ../../scripts/export-human-queue.mjs` (from this directory) or
`node scripts/export-human-queue.mjs` (from the repo root) to write them to
`.pHive/human-queue.yaml` for a human to triage.

## Tree-aware routing

When an issue carries `tree_path` (either as a top-level field or in metadata),
`selectAssignments` first checks `TREE_AGENT_ATTACHMENTS` in `lib/config.mjs`.
Attachments on the exact tree path and each ancestor path are eligible, with
closer paths preferred. For example, a task at
`firefly-events/events/api` considers agents attached to that path, then
`firefly-events/events`, then `firefly-events`.

If the issue has no `tree_path`, or no tree-attached agent has capacity, routing
falls back to the existing project lane / default lane behavior.

## Back-half verification

The router also scans `in_review` stories in `REVIEW_PROJECT_IDS` for linked
PRs. A merged PR advances the story to `done`. An open PR dispatches
`verify-team-squad` (leader: `auriga-review`) by assigning the issue to the
squad and forcing a rerun. The squad leader is responsible for running
`/hive:review` and `/hive:test` on the PR branch, then merging to `dev` and
marking the story done on pass, or commenting required changes and returning
the story to `in_progress` on fail.

Squad assignment is the idempotency marker. A story already assigned to
`verify-team-squad` is not re-dispatched while its review run is fresh; stale or
failed review runs are re-enqueued after the zombie window. This keeps the
auriga-review lane fed without repeatedly waking an active review.

## Bulk human-todo extraction (one-off triage sweep)

`scripts/export-human-queue.mjs` above only exports what the *live router*
already scans (`cfg.PROJECT_IDS` — 3 aligned projects, `status: todo` only).
`scripts/bulk-extract-human-todos.mjs` is a separate, broader, one-off sweep
for triaging the whole board:

```sh
node scripts/bulk-extract-human-todos.mjs              # report only (default)
node scripts/bulk-extract-human-todos.mjs --apply       # also label eligible issues
node scripts/bulk-extract-human-todos.mjs --no-notify   # suppress operator notification
```

- **Scope:** every project in the workspace (`mca.listAllWorkspaceIssues()`),
  not just the router's 3 aligned ones, and every status (not just `todo`) —
  so an already-`blocked` human-todo is still visible in the report.
- **Detection:** `isHumanTodoBroad` = `core.isHumanTodo` (label `human-todo`
  or `waiting_on: <human>`) **OR** a title starting with "HUMAN TODO" (e.g.
  `PAN-6644: "HUMAN TODO (Mathew): ..."` — the concrete motivating example for
  this sweep, which has neither a label nor `waiting_on` set).
- **Report:** always written to `.pHive/human-todo-extraction-report.yaml`
  (override with `AURIGA_HUMAN_TODO_REPORT`), with `already_excluded_count`
  (blocked/cancelled — not currently reachable by any dispatch pool) and
  `needs_attention_count` (todo/in_progress — still exposed right now).
- **Notification (default ON):** for every entry still exposed to dispatch
  (`todo`/`in_progress`) and not yet labeled, posts a Multica comment on that
  issue mentioning the operator (`cfg.HUMAN_OPERATOR_MEMBER_ID`) so a human is
  actually pinged, rather than having to remember to open the YAML report.
  Once an issue is labeled `human-todo` it's treated as already surfaced and
  isn't re-notified on subsequent runs. Suppress with `--no-notify` /
  `AURIGA_HUMAN_QUEUE_NOTIFY=0`.
- **Label mutation (opt-in, default OFF):** `--apply` /
  `AURIGA_HUMAN_QUEUE_APPLY=1` attaches the `human-todo` label to entries that
  are `status: todo` and not yet labeled, positively excluding them from any
  future dispatch scan regardless of which project's router config has
  landed. This is opt-in, not automatic, per the story's own risk mitigation:
  "broad query + manual review before run" — review the report first.
- **Auth note:** like `export-human-queue.mjs`, this shells out via the
  `dostal` CLI profile (`lib/multica.mjs`), so it must be run from an
  environment with that profile logged in — it can't run from inside a
  Multica agent task's own scoped token sandbox.

## Files / paths

- `auriga-router.mjs` — entrypoint / scan loop.
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs`.
- `test/core.test.mjs` — `npm test`.
- `../../scripts/export-human-queue.mjs` — per-cycle human-queue export (aligned projects, `todo` only).
- `../../scripts/bulk-extract-human-todos.mjs` — one-off, workspace-wide human-todo triage sweep (see above).
- `lib/observability.mjs` — log sink, `cycle_summary` counting, heartbeat.
- `bin/healthcheck.mjs` — container healthcheck (see Observability).
- Runtime files (defaults):
  - `/tmp/auriga-router.pid` (`AURIGA_PIDFILE`), `/tmp/auriga-router.heartbeat` (`AURIGA_HEARTBEAT_FILE`)
  - `auriga-supervisor.lock` next to the pidfile (`AURIGA_SUPERVISOR_LOCK`)
  - JSONL log: stdout, or `AURIGA_LOG`. Supervisor: stderr, or `SUP_LOG`; router stdout/stderr, or `ROUTER_LOG`.
  - The launchd template sets `AURIGA_LOG=/tmp/auriga-router.jsonl`, `ROUTER_LOG=/tmp/auriga-router.log`, `SUP_LOG=/tmp/auriga-supervisor.log` to keep the host layout.
