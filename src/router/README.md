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
| `writes_held` | Present only when the cycle was held before any pass because core-api writes couldn't carry the operator token (a transient lookup failure, PANT-1159). A `cycle_writes_held` event carries the same reason. Nothing was written, and the next cycle decides again. |
| `blocked_runtimes` | Runtimes rate-limit-blocked by the end of the cycle (sorted). |
| `dry_run` | Whether the cycle ran with `--dry-run`. |

A healthy idle router shows `cycle_summary` every `AURIGA_CYCLE_MS` with
`errors: 0` and zero pass counts. A wedged one stops emitting it.

### `decision` event (decision records)

One `decision` per routing choice a `cycle()` pass makes: a dispatch, a
cross-board hand-off, or an issue a guard turned away. It exists so routing
policy can be compared across runs (VISION.md ②, "metrics at every decision").
The schema is versioned by `schema`. A consumer should reject versions it
doesn't know, and any breaking change bumps the version. The constants and
enums live in `lib/decisions.mjs`.

```json
{
  "ts": "2026-09-27T22:00:00.000Z",
  "event": "decision",
  "schema": 1,
  "tenant_id": "dostal-tech",
  "instance_id": "auriga-1",
  "identifier": "PANT-816",
  "pass": "build",
  "action": "assign",
  "agent": "auriga-build",
  "runtime": "claude",
  "lane": "Auriga",
  "reason": "project_lane",
  "candidates": [
    { "agent": "auriga-dev", "runtime": "codex", "selected": false, "skip": "runtime_blocked" },
    { "agent": "auriga-build", "runtime": "claude", "selected": true }
  ],
  "caps": {
    "agent_inflight": 1, "agent_queued": 1, "agent_max_inflight": 3, "agent_cycle_assigns": 0, "per_cycle_per_agent": 2,
    "runtime_inflight": 2, "runtime_queued": 1, "runtime_cap": 4, "assigned": 0, "max_assign": null
  },
  "dry_run": false,
  "error": null
}
```

Every field is always present. A field is `null` when it doesn't apply, never missing.

| Field | Meaning |
|---|---|
| `schema` | Record version, currently `1`. |
| `ts` | When the decision was made. |
| `tenant_id` / `instance_id` | The tenant the cycle ran for (the multi-tenant tenant, else `AURIGA_TENANT_ID`), and `AURIGA_INSTANCE_ID`. |
| `identifier` | The issue. |
| `pass` | `build` \| `cascade` \| `zombie` \| `assigned_idle` \| `review` \| `hand_up` \| `hand_down`. |
| `action` | `assign` (route to a newly chosen agent), `rerun` (re-enqueue on the current assignee), `create_remote` (hand-up/hand-down to another board), `skip` (a guard turned it away). |
| `agent` / `runtime` | Who it went to. `null` for hand-offs and for skips made before an agent was picked. |
| `lane` | The issue's project lane name. |
| `reason` | Why, from the enum below. |
| `candidates` | Every lane agent considered: the chosen one has `selected: true`, and each rejected one has a `skip` reason (`agent_offline`, `agent_at_capacity`, `runtime_at_capacity`, `runtime_blocked`, `per_cycle_per_agent_cap`, `unknown_agent`, or `lower_ranked` for an agent that was eligible but lost the load/lane-order tiebreak). Passes that rerun the current assignee list just that agent. |
| `caps` | Headroom at decision time, before this dispatch was counted. `agent_inflight` + `agent_queued` / `agent_max_inflight`, `agent_cycle_assigns` / `per_cycle_per_agent`, `runtime_inflight` + `runtime_queued` / `runtime_cap`, and `assigned` / `max_assign` (the cycle-wide cap). `*_inflight` counts running issues plus this cycle's dispatches. `*_queued` counts assigned `todo` issues with a live run the runtime hasn't started yet (PANT-1158): they hold a slot until the runtime is done with them. An assigned `todo` with no run (the dispatch dead-zone) holds none. A `null` cap means uncapped. |
| `dry_run` | `true` on a `--dry-run` cycle. A dry run emits the same decisions the live cycle would, at the point it would dispatch. |
| `error` | The adapter error message when the dispatch or hand-off failed, else `null`. |

`reason` values:

| Group | Values |
|---|---|
| Dispatch | `project_lane`, `default_lane` (project has no lane of its own), `methodology_lane` (no project lane, and the story declares a methodology/skill not every `DEFAULT_LANE` agent can run — see `RUNTIME_CAPABILITIES`), `hive_story` (hive lane), `tree_attachment` (`TREE_AGENT_ATTACHMENTS`), `seed_planning` (seed routed to the planning agent), `existing_assignee` (a rerun on the current assignee), `review_tier_full` / `review_tier_light` / `review_tier_backend` / `review_tier_standard` (review, by squad tier), `no_local_route` (hand-up), `project_route_child` (hand-down). |
| Guard skips (`dispatchEligible()`) | `max_assign`, `pass_cap`, `agent_parked`, `seed`, `runtime_blocked`, `assignee_runtime_blocked`, `per_cycle_per_agent_cap`. |
| Other skips | `no_capacity` (no lane agent free), `no_capable_lane` (no `DEFAULT_LANE`/`HIVE_LANE` agent can run the story's declared methodology/skills), `give_up_max_attempts` (zombie/review retry cap reached, parked for a human: status `blocked`, `blocked_reason`, and the explanation in metadata `blocked_note`, never a comment, PANT-1461), `agent-task-active` on an assign error (the agent already has a fresh queued/running task on the issue, so Multica would enqueue a second one; logged as `dispatch_skip_active_task`, PANT-1461), `unknown_child` / `child_unreachable` (hand-down config rejected). |

`skip` records are rate-limited to one per issue per
`CAPS.decisionSkipWindowCycles` cycles (default 10), so an issue a guard
rejects every cycle doesn't flood the log. The give-up records aren't
rate-limited; each happens once, because the issue is parked. A follow-up
forced rerun (after an assign, or after a verify finds no run started) is part
of the same decision and doesn't emit a second record.

The older `route` event is kept alongside `decision` for build picks, because
`cycle_summary`'s `passes.routed` count reads it (`passForEvent()`).

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

### Shared state with auriga-api

When the router and auriga-api run in separate containers, mount one volume
(e.g. `/var/lib/auriga`) into both and point both at the same files:

- `AURIGA_HEARTBEAT_FILE` — auriga-api's `GET /api/lanes` reports
  `runnerStatus: running` while the heartbeat is newer than
  `AURIGA_RUNNER_STALE_MS` (default 3 × `AURIGA_CYCLE_MS`), and
  `runnerLastCycleAt` from the heartbeat's `ts`. The pidfile check remains a
  fallback for same-host runs.
- `AURIGA_RECORDS_FILE` — the router also appends its `decision`, `verify_ok`,
  `advance`, `zombie`, `review` and `scan` events to this JSONL file, trimmed
  back to the last `AURIGA_RECORDS_MAX_LINES` (default 5000) lines once it
  grows 20% past that. auriga-api serves it as
  `GET /api/decisions?since=<iso>&limit=<n>` → `{ records }`, oldest first
  (limit default 2000, max 10000). With `since` it returns the first `limit`
  records after it; without it, the newest `limit`.

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
- `lib/decisions.mjs` — `decision` record schema, reason enum, skip rate limiter.
- `bin/healthcheck.mjs` — container healthcheck (see Observability).
- Runtime files (defaults):
  - `/tmp/auriga-router.pid` (`AURIGA_PIDFILE`), `/tmp/auriga-router.heartbeat` (`AURIGA_HEARTBEAT_FILE`)
  - `auriga-supervisor.lock` next to the pidfile (`AURIGA_SUPERVISOR_LOCK`)
  - JSONL log: stdout, or `AURIGA_LOG`. Supervisor: stderr, or `SUP_LOG`; router stdout/stderr, or `ROUTER_LOG`.
  - The launchd template sets `AURIGA_LOG=/tmp/auriga-router.jsonl`, `ROUTER_LOG=/tmp/auriga-router.log`, `SUP_LOG=/tmp/auriga-supervisor.log` to keep the host layout.

### Heimdall lane eligibility

`AGENT_LANES` in the existing `AURIGA_CONFIG` JSON maps exact configured agent
names to Heimdall lane IDs, for example:

```json
{ "AGENT_LANES": { "build-primary": "claude@primary", "build-secondary": "claude@secondary" } }
```

Keys may be agent names or Multica agent IDs; a name entry wins. The live
daemon also loads the shipped map `src/router/config/agent-lanes.json`
(ID-keyed, since agent names repeat across tenants), or the file named by
`AURIGA_AGENT_LANES_FILE`. `AGENT_LANES` in `AURIGA_CONFIG` overrides it per
key, and a tenant config's `AGENT_LANES` merges over both. Tests and library
callers get no shipped map: only the daemon entry points load it.
This is explicit operator configuration; caps and lane lists are unchanged.
Unmapped agents and unknown lane IDs retain their existing eligibility.
Set `HEIMDALL_URL` to the sensing service (default `http://heimdall:4870`).
When mappings exist, each cycle reads `GET /lanes` with a three-second timeout.
A boolean `effective_enabled` takes precedence; older responses allow `status:
"up"` only. Disabled or unavailable agents are excluded from new dispatch,
including recovery reruns, without cancelling or modifying active runs. If all
agents in the configured list are unavailable, the ticket waits; a
`no_available_lane` decision includes candidate rejection reasons.

Send-backs that bypass routing (core-api's review closer re-assigns the
original builder and sets `todo`) are caught by assigned-idle detection: a
plain `todo` assigned to an agent whose Heimdall lane is unavailable, with no
active run, is unassigned straight away (`assigned_idle_unassign`, reason
`assignee-lane-unavailable`, plus `availability_reason`). There is no stale
wait. The next build pass routes it within its list or holds it with
`no_available_lane`. A Heimdall outage with no last known state never triggers
this.

Read failures are stale-while-error (PANT-1385). Every successful `GET /lanes`
is kept in `AURIGA_LANE_STATE_FILE` (default: `heimdall-lanes.json` next to
`AURIGA_HEARTBEAT_FILE`, so it survives the `--once` loop's per-cycle
processes). When Heimdall can't be reached, that last known state is used: a
lane it reported as limited stays unavailable, and the availability reason says
`(last known state, Ns old; heimdall unreachable)`. A cached limited lane whose
`manual_reset_at`/`reset_at` has passed is let back in; one with no reset time
stays as last read. Only a router that has never read Heimdall successfully
fails open. Decision and `scan` records carry `lane_state_error`,
`lane_state_source` (`live`, `cache`, `none`, or null when no map is
configured), `lane_state_age_s` and `lane_state_fetched_at`. The `start` /
`start_multi_tenant` line and every `scan` log `agentLanes` (the size of the
agent->lane map; 0 means nothing is gated) and `build` (a hash of
`auriga-router.mjs` + `lib/lane-state.mjs`), so the running code can be checked
against a commit.
Auriga also takes a lane out on its own evidence (PANT-1445). When the latest
started run on a lane failed on a provider limit (`session`/`usage`/`weekly`
limit, quota, credit, 429; a per-model limit such as "Opus limit" does not
count), every agent on that lane is unavailable until the reset in the error
text (e.g. `resets Nov 24, 5am (UTC)`), or `redispatchCooldownMs` when it gives
none. The reason reads `auriga:<lane>:provider limit observed on <ticket> until
<time>`, and it gates exactly like a Heimdall one: new work goes to the next
agent in the list, an assigned `todo` is unassigned (`assigned_idle_unassign`)
and an `in_progress` ticket with no live run is reassigned (`zombie`, reason
`assignee-lane-unavailable`). A run that starts later on the lane clears it.
Each new limit logs `lane_limit_observed` once and is reported to Heimdall as a
`failure` outcome carrying the error, so Heimdall marks the lane too; `scan`
lists `lanesLimitObserved`. Limits are kept across `--once` processes in
`AURIGA_OBSERVED_LIMITS_FILE` (default `observed-lane-limits.json` next to the
lane-state file), since the limited ticket's runs stop being fetched once it is
re-routed.

Assigned-idle stops re-running a ticket the agent has already turned down
(PANT-1459, pantheon-v2#598; live: FFE-880 re-ran 35 times in 24 h, each run
"Routed to me again. Nothing has changed since ..."). Only the assignee's own
completed runs count; provider-limit failures and runs from before the last
park are ignored. When the latest one declined the ticket ("routed to me
again", "nothing has changed since", "not picking this up", "declining this",
"don't pick this up", ...), reason `assigned-idle-agent-declined`. When the last
`assignedIdleNoProgressRuns` (CAPS, default 3, 0 = off) completed runs show no
PR link, push or commit and the ticket is still `todo`, reason
`assigned-idle-no-progress`. Either way the ticket is unassigned
(`assigned_idle_unassign` with `park: true`) and parked: status `blocked`,
`blocked_reason` set to the reason, `assigned_idle_parked_at` and an
`assigned_idle_park_note` in metadata. No comment is posted, since Multica treats
every comment as a trigger (PANT-1457). Both reasons are router give-up reasons,
so a human moving the ticket off `blocked` ends the park, and only runs after
`assigned_idle_parked_at` count from then on.

**The router never comments on an assigned issue (PANT-1457, PANT-1461).**
Multica treats every comment as a trigger and queues a run for the assignee,
so each router notice used to add a duplicate task. Notices go to metadata and
the log instead: `review_hold` / `review_hold_note` (review gate holds),
`blocked_reason` / `blocked_note` (zombie and review give-ups),
`assigned_idle_park_note` (declined/no-progress parks) and `review_squad_plan`
(the plan the review squad reads). The one comment left is the hand-up/hand-down
pointer on a cancelled issue, posted only after it is unassigned (skipped if the
unassign fails). On top of that, an assign is skipped when the target agent
already has a fresh queued or running task on the issue.

Founder-claimed tickets are human todos (PANT-1459): never routed, re-run or
review-dispatched. A ticket is founder-claimed when its description contains a
`FOUNDER_CLAIM_MARKERS` phrase (also read as `founder_claim_markers`, the dragon
autopilot's key; case-insensitive) or `claimed by <name>` for any `HUMAN_NAMES`
entry.

Auriga also takes a whole Multica runtime out when it keeps failing (PANT-1397).
A runtime is one daemon/CLI install, so when it breaks (dragon's opencode
runtime, 2026-11-17/18: `/home/node` tmpfs full, every run "exit status 1")
every agent on it fails whatever the ticket, while Heimdall still reports the
providers up. Auriga watches the runs it already fetches (in_progress, assigned
todo and in_review tickets) per physical `runtime_id`. When the newest
`runtimeFailureStreak` (default 3) finished runs on a runtime all failed, across
at least `runtimeFailureMinIssues` (default 2) tickets, every agent whose newest
run was on that runtime is unavailable with reason `auriga:runtime-<id>:<n> runs
failed in a row (<tickets>) until <time>`. It gates exactly like a lane outage
(next agent, `assigned_idle_unassign`, `zombie`). Provider-limit failures and
cancels with no error don't count; a successful run clears the streak. The hold
lasts `runtimeFailureCooldownMs` (default 30 min) from the newest failure; then
the runtime is let back in and its next run is the probe. Each further failure
doubles the hold, up to `runtimeFailureMaxCooldownMs` (default 4 h). Caps are
never touched, so a hold always ends on its own. `runtimeFailureStreak: 0` in
CAPS turns the gate off. Each new hold logs `runtime_unhealthy` once (runtime,
streak, tickets, agents, error); `scan` lists `runtimesHeld`. History and the
current holds live in `AURIGA_RUNTIME_HEALTH_FILE` (default
`runtime-health.json` next to the lane-state file), which pantheon-v2's nurse
check `bin/runtime-health-check.sh` reads to tell the nurse. To release a
runtime by hand once it is fixed, delete that file (`/var/lib/auriga/runtime-health.json`
in the pilot container).

The same streak rule also runs per Heimdall lane (PANT-1445). On 2026-11-23
Gemini failed every run ("opencode exited with error: exit status 1") while the
opencode runtime's other lanes kept succeeding, so the runtime gate never fired.
Heimdall still said `gemini` was up, and reviews kept going to
flayr-review-gemini/auriga-review-gemini. Auriga now groups the same run history
by each agent's `laneId`. When the newest `laneFailureStreak` (default: the
runtime streak, 3) finished runs on a lane all failed, across at least
`laneFailureMinIssues` tickets, every agent on that lane is unavailable with
reason `auriga:<lane>:<n> runs failed in a row on the lane (<tickets>) until
<time>`. The cooldown and doubling are the same as the runtime hold.
`laneFailureStreak: 0` turns it off. Each new hold logs `lane_unhealthy` once;
`scan` lists `lanesFailing`; the store keeps `laneHolds`.

A lane failure never blocks a ticket. In review dispatch:
- a ticket whose reviewer's lane is unavailable is re-dispatched to a reviewer
  on a lane that is up (`assignee-lane-unavailable`), or waits if there is none;
- runs by agents whose lane is currently out don't count toward
  `reviewMaxAttempts` (or the zombie build-attempt count);
- when all `reviewMaxAttempts` failures happened on one lane and another
  `REVIEW_LANE` lane is up, the ticket goes to that lane
  (`review-failed-on-one-lane`), or waits for budget or capacity, instead of
  giving up. Only failures that span lanes, or a single review lane, give up and
  park the ticket for a human (PANT-262).

Heimdall decision ids live in `AURIGA_DECISIONS_FILE` (default
`heimdall-decisions.json`, same directory, entries expire after 14 days), so the
outcome of a ticket assigned in one `--once` process can be reported by a later one.
The executed lane is recorded as `executed_lane`. Because the current outcome
API credits its immutable selected lane, Auriga reports an outcome only when
that selection matches the mapped executor. A mismatch emits
`route_lane_mismatch` and withholds the outcome rather than crediting another
account. Unmapped execution also withholds attribution. The configured agent
list remains the boundary for routing; a Heimdall suggestion never permits
assignment outside it.

#### Per-task model override and queue hold (PANT-1327, heimdall#142)

At each `assign`, Auriga reads the same route verdict for what it says about
the model (`src/router/lib/model-override.mjs`). Heimdall decides; Auriga only
dispatches what the verdict names.

- **Override.** When the verdict is `route` for the agent's own mapped lane and
  Heimdall named a swap (`model_swap` set, or `model` differs from
  `preferred_model`), that one assignment carries `model` in the assign body
  (and in a forced rerun in the same cycle). The agent row's model is left
  alone as the preference. Each override logs `model_override` with
  `identifier`, `agent`, `lane`, `preferred_model`, `model` and `reason` (the
  swap's cause). A bare `model` equal to the preference is not an override:
  Pantheon fills `model` from the lane declaration on every answer.
- **No override.** With no swap, a verdict for another lane, `no_route`, or no
  answer, the dispatch is exactly what it was before.
- **Queue hold.** A `queue` verdict with a future `resets_at` dispatches
  nothing. It logs `dispatch_held` and writes `heimdall_queue_until` and
  `heimdall_queue_reason` to the issue metadata. `dispatchEligible` skips the
  issue in every pass until then, and the next dispatch clears both keys. A
  `queue` with no `resets_at` has no time to hold until, so it dispatches as
  before.
- **Limits.** Auriga never picks a model Heimdall did not name, never downgrades
  on its own, and spends no more than before. `MODEL_OVERRIDE` in the config
  (`enabled`, `holdUntilKey`, `holdReasonKey`) turns this off or renames the
  keys.

The model only reaches the run if the layers below carry it. Pantheon's
`/assign` and `/rerun` must forward `model`, and Multica must run a task on a
model other than its agent row's. Until both do, the override is decided and
logged here but the run still uses the agent's own model.
