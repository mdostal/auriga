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

## Files / paths

- `auriga-router.mjs` — entrypoint / scan loop.
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs`.
- `test/core.test.mjs` — `npm test`.
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.
