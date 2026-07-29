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

## Files / paths

- `auriga-router.mjs` — entrypoint / scan loop.
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs`.
- `test/core.test.mjs` — `npm test`.
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.
