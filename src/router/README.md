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
nohup ./supervisor.sh >> /tmp/auriga-supervisor.log 2>&1 &
```

`supervisor.sh` defaults `DIR` to this directory
(`~/Documents/work/dostal/code/auriga/src/router`) and `NODE` to the mise
node 24 install. Override via env if needed.

### Reboot survival (launchd)

`supervisor.sh` alone only survives as long as the shell/session that
launched it. To keep the router alive across logout AND reboot, install it as
a per-user launchd LaunchAgent:

```sh
scripts/launchd/install.sh      # installs + loads com.mdostal.auriga-supervisor
scripts/launchd/uninstall.sh    # stops + removes it
```

`install.sh` fills in `NODE`/`DIR`/`HOME` for the current machine (override
via env, same as `supervisor.sh`) from
`scripts/launchd/com.mdostal.auriga-supervisor.plist.template` and installs
the result to `~/Library/LaunchAgents/`, with `RunAtLoad` + `KeepAlive` set.
Check status with `launchctl print gui/$(id -u)/com.mdostal.auriga-supervisor`;
launchd-level stdout/stderr land in `/tmp/auriga-supervisor-launchd.log`
(the router's own logs are unaffected — see Files/paths below).

## Testing

`cycle()` (one full scan -> route -> verify pass) is exported from
`auriga-router.mjs` and accepts an options bag (`mca`, `cfg`, `core`, `log`,
`sleep`, `dryRun`, `noZombie`, `maxAssign`, `now`) so tests can drive it
end-to-end against a **mock Multica layer** instead of the live `multica`/`gh`
CLI — see `test/support/mock-mca.mjs` and `test/router-cycle.e2e.test.mjs`.
Every dependency defaults to the live singleton, so `main()` (the actual
daemon loop) calls `cycle()` with no behavior change; `main()` itself only
runs when this file is executed directly (`isMainModule` guard), never when
imported by a test.

```sh
npm test           # from this directory: node --test test/*.test.mjs
# or from the repo root:
npm test           # node --test src/router/test/*.test.mjs
```

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

## Files / paths

- `auriga-router.mjs` — entrypoint / scan loop; exports `cycle()`.
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs` (predates the adapter interface; no longer
  called by `cycle()` — see `lib/adapters/`).
- `lib/adapters/` — the `backlogAdapter` / `spawnAdapter` boundary `cycle()` calls through:
  `backlog-adapter.mjs` / `spawn-adapter.mjs` (typedef contracts), `multica/` (real, live-default
  implementation), `stub/` (in-memory test double), `pantheon-v2-l2/` (intentionally-unbuilt
  stub — the only sanctioned path to Pantheon). See `lib/adapters/README.md`.
- `test/*.test.mjs` — `npm test`; `test/support/mock-mca.mjs` is the mock
  Multica layer `test/router-cycle.e2e.test.mjs` drives `cycle()` against.
- `scripts/launchd/` — `install.sh` / `uninstall.sh` +
  `com.mdostal.auriga-supervisor.plist.template` for reboot-survival.
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
  - `/tmp/auriga-supervisor-launchd.log` (launchd's own stdout/stderr capture)
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.
