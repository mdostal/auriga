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
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.
