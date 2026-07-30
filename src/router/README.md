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
- `lib/` — `config.mjs`, `core.mjs`, `multica.mjs`.
- `test/core.test.mjs` — `npm test`.
- Repo provisioning gate: before dispatch, the router checks every distinct repo
  referenced by `lib/config.mjs` `AGENTS[*].repo` with
  `git -C <repo_path> remote get-url origin`. A todo only blocks on this if
  EVERY agent in its target lane (hive stories use `HIVE_LANE`, everything else
  `PROJECT_LANE`/`DEFAULT_LANE`) has a missing/un-provisioned repo; if at least
  one lane agent's repo is provisioned, dispatch proceeds to that agent as
  normal. A fully-blocked issue is set to status `blocked` with metadata
  `blocked_reason=needs-repo` (Multica's status enum has no `needs-repo`
  literal, so this pairing is the distinct signal — see PAN-6594).
  `AURIGA_REPO_BASE` defaults to the parent directory of the checked-out plugin
  repos, and `AURIGA_REPO_PATH_<OWNER>_<REPO>` can override a single repo path.
- Pidfiles / logs (in `/tmp`, single-instance safety):
  - `/tmp/auriga-router.pid`, `/tmp/auriga-router.log`, `/tmp/auriga-router.jsonl`
  - `/tmp/auriga-supervisor.pid`, `/tmp/auriga-supervisor.log`
- Overridable: `AURIGA_PIDFILE`, `AURIGA_LOG`.
