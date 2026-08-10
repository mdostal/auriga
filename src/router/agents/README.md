# Build-lane agent instructions (Gate-1: build lands in the story's target repo)

The Auriga router (../auriga-router.mjs) only DECIDES which Multica agent-lane a
story goes to. It does NOT check out repos. The actual `git clone` / build / push
happens inside the **Multica agent**, driven by that agent's server-side
`instructions`. This directory holds the canonical, version-controlled copy of
those instructions so the live agents can be re-applied and reviewed.

## The gate that was closed (2026-07-31)

`auriga-build` used to hard-code *"You work ONLY in the mdostal/auriga repo … Never
write into any other repo."* So any dispatched story targeting a different repo
(e.g. a plugin) dispatched fine but the agent **refused to build** it
(proof of the old behavior: run on PAN-6954 returned *"restricted to mdostal/auriga
… I posted an explanation and set the ticket to blocked"*).

## The fix — target_repo-driven build lane

`auriga-build.instructions.md` makes the build lane **generic**: it resolves the
story's target repo and builds THERE, hard-guarded to that one repo.

Resolution order (safety-critical):
1. a `target_repo: <owner/repo|git-url|local-path>` line in the story description;
2. else the ticket's `metadata.target_repo` (read via `multica issue get <id>`);
3. else, only for an Auriga story with no declared target, default to `mdostal/auriga`.

HARD GUARD: the resolved repo is the ONLY repo the agent may clone/branch/commit/
push/PR against. No target + non-Auriga => the agent comments + sets `blocked`
(never guesses a repo).

The other two hive build-lanes (`mnemosyne-dev`, `votum-dev`, see
`../lib/config.mjs` HIVE_LANE) get the same behavior via a `TARGET-REPO OVERRIDE`
block prepended to their god-specific instructions: target_repo present => build
there; absent => their default god repo (unchanged, backwards-compatible).

Note: `metadata.target_repo` cannot be set through the `multica` CLI (no
`--metadata` flag) — only programmatically (Minerva). The CLI-accessible signal is
therefore the `target_repo:` line in the **description**, which the agent reads
directly from its task prompt.

## Re-apply to the live agents

    ID=f8678f39-633f-45ef-9b1d-2ac63425877c   # auriga-build
    multica --profile dostal agent update "$ID" \
      --instructions "$(cat auriga-build.instructions.md)"

For mnemosyne-dev (4dca0020-…) / votum-dev (94e096ea-…), prepend the override block
(see git history of this dir) to their `*.base-instructions.md` and update the same way.

## Proof

Gate-1 was proven end-to-end by PAN-6957 ([cronmaker-hello-scaffold]) — a story
targeting `mdostal/cron-maker` that the build lane cloned, built, tested, pushed as
`feat/PAN-6957`, and opened a PR into `dev` in **cron-maker** (not auriga). See the
ticket run result for the commit SHA + PR URL.
