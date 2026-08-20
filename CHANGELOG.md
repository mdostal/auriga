# Changelog

All notable changes to Auriga are documented in this file.

## [Unreleased]

## [0.1.0] - 2026-08-19

**Auriga's first public release: a standalone, adapter-based orchestrator with its own dashboard, showcase page, MCP server, and a real project registry — no more hardcoded, hand-edited config.**

### Added

- **Standalone adapter interface** (PRs #58, #59): the router's dispatch/state-machine core no longer talks to Multica directly — `backlogAdapter`/`spawnAdapter` interfaces sit between them, each with a real Multica-backed implementation and an in-memory stub, plus a documented, intentionally-unbuilt `pantheon-v2-l2` adapter as the only sanctioned future path into Pantheon. Auriga now runs fully standalone with zero live external systems present.
- **Operator dashboard** (PR #60): a real Vite/React read-only UI (epics list, story detail with dependency view, activity log) served by a new local HTTP API over `.pHive/` planning state — the first way to see what Auriga is doing without reading raw YAML.
- **Public GitHub Pages showcase + Star Atlas dashboard restyle** (PR #61): a public marketing/demo page at the repo's GitHub Pages site explaining what Auriga is and how to install it, plus a visual restyle of the real dashboard to match — the operator dashboard kept its tab-based navigation rather than adopting the showcase's long-scroll layout, since the two serve different audiences.
- **Operator-side MCP server + agent install/interact CLI** (PR #62): a new `auriga` command line tool — `auriga agent init`/`agent status` detects and registers Auriga's MCP server with Claude Code and Codex CLI installs, and the MCP server itself exposes three read-only tools (list board, get story detail, list blocked/in-flight) so an operator's own agent session can query Auriga's board directly, without opening the dashboard. Ships deliberately read-only in this release — write capability was scoped out pending its own safety design, not an oversight. `docs/install.sh` gives a one-line install.
- **Real, living project registry** (PR #63): `auriga project scan`/`add`/`remove`/`list` replaces the router's old hand-edited list of which Multica projects it dispatches to and which agent lane handles each one — a real operator-facing CLI instead of a source-code edit, including freeform per-project notes.
- **Core dispatch engine** (baseline, first documented in this release): capability-aware routing so hive-tagged stories always land on a Claude+plugin-hive lane; a pure state-machine covering `todo → in_review → done` transitions with auto-unblock when a dependency reaches done; a human-todo filter that routes human-owned tickets to their own queue instead of the agent dispatch pool; a repo-provisioning gate that prevents dispatch failures on unprovisioned repos; and triage passes that bulk-reassign self-blocked stories, re-evaluate stale dependency blocks, and route unplanned/mis-dispatched seeds to the Minerva planning lane.

### Fixed

- **PR-matching regression** (PR #58): the review lane's GitHub PR discovery was silently narrowing matches to raw-identifier-substring-only, dropping slug-branched PRs the router's own richer matcher would have found — the same bug class previously seen in this project (PAN-7150). Fixed by scanning the board once per cycle and filtering client-side with the full matcher.
- **`auriga_get_story` MCP tool latency** (main, post-#62): the story-detail tool's pull-request lookup did an uncached live GitHub scan across every configured repo on every call — measured at ~75 seconds against the real board. Fixed by caching the board-wide scan with a short TTL, the same fix already proven in the router's own dispatch loop — first call still pays the scan cost, every call after is ~50-60ms.
- **Dashboard security hardening** (PR #60): an unguarded `decodeURIComponent()` in the local HTTP API could crash the server, and a path-traversal gap in epic/story file resolution could read arbitrary YAML outside `.pHive/`. Both fixed with a shared path-containment guard.

### Security

- **Deep pre-publication audit** (main, pre-public): before making this repo public, a full audit of every tracked file and git history found no real secrets (API keys, tokens, credentials) anywhere. Real Multica operational identifiers (agent/project UUIDs, a workspace ID, human names) are present and have been since the router's earliest commits, but are not treated as sensitive — this repo is owned and published under the operator's own real identity.
