# Research Brief: Agent/Harness Install-and-Interact (MCP Server)

**Epic:** p5-agent-mcp-integration
**Requirement:** give Auriga its own agent/harness install-and-interact story, mirroring
the pattern Portunus (a sibling Pantheon plugin) shipped for itself — but reversed in
direction. Operator's explicit scope decision: build the **operator-side MCP server**
only — a new Auriga MCP server so an operator's own Claude Code / Codex CLI session can
query/mutate the board directly as tool calls, plus `auriga agent init`/`agent status`
CLI commands, an install.sh on GitHub Pages, and a prominent, collapsible install/interact
UI surface in both the dashboard and the showcase page.

**Method:** read Portunus's actual implementation directly (sibling repo at
`/Users/mdostal/Documents/work/pantheon/portunus`), not just the operator's verbal
description, plus Auriga's real adapter/CLI/UI code. All findings below are grounded in
file reads, not inference.

## 1. Portunus's actual implementation — real code, with one caveat

**Caveat surfaced by research, not yet known to the operator: this feature is not yet on
Portunus's `main` branch.** It lives in commit `9621eb2c` on `dev`/`feat/portunus-agent-init`
— confirmed via `git merge-base --is-ancestor 9621eb2 HEAD` returning false against `main`.
Not a blocker for Auriga's own build, but worth knowing: the "shipped" reference point is
itself mid-flight, not a stable released pattern.

**Shape (Python):**
- `agent_setup.py` — `detect_harnesses()` is just `shutil.which("claude")` /
  `shutil.which("codex")`, nothing deeper.
- `mcp_registered(harness)` — the exact bug fix the operator mentioned: Claude Code uses
  a targeted `claude mcp get portunus` (not `mcp list`, which health-checks every
  registered server — 30+s on a machine with several configured). Codex still uses
  `codex mcp list` (that harness's `list` wasn't slow).
- `register_mcp(harness)` — pure CLI shell-outs, no direct config-file writes:
  `claude mcp add --scope user portunus -- portunus mcp` /
  `codex mcp add portunus -- portunus mcp`. Registration is fully delegated to the
  harness's own CLI subcommand.
- Skills installed to `~/.claude/skills/<name>/SKILL.md` only — Codex has no skills
  equivalent, so skills only install when `"claude"` is among the detected/targeted
  harnesses. Content-compared before copy (`filecmp.cmp(shallow=False)`) so a re-run is a
  no-op unless content changed — real idempotency, not just "doesn't crash twice."
- `agent_init()`/`agent_status()` — init attempts every harness independently (one
  failing never blocks another); status is read-only, mutates nothing.
- CLI wiring (`cli.py`): `agent init [--harness claude|codex] [--json]`,
  `agent status [--json]`, argparse subparser tree.
- **MCP server** (`mcp_server.py`, already on `main`): official `mcp` Python SDK's
  `FastMCP`, stdio transport (`mcp.run()`), ~17 `@mcp.tool()`-decorated functions. Calls
  the Portunus library **directly, in-process** — explicit design decision documented in
  the module docstring ("no subprocess boundary needed").
- `scripts/install.sh` — bash, installs `pipx` if missing, `pipx install --force
  "git+https://github.com/mdostal/portunus.git"` (from GitHub, not PyPI — the plain
  `portunus` PyPI name is an unrelated unmaintained package), verifies PATH, then runs
  `portunus agent init` automatically at the end of install.
- **Publishing divergence from Auriga**: Portunus's Pages source is a separate
  `gh-pages` branch, root path — no CI workflow found that publishes to it, so reaching
  that URL appears to need a manual/undiscovered publish step. Auriga's Pages setup
  (`/docs` on `main`, from `p4-auriga-branding`) is simpler: any file added to `docs/`
  and pushed to `main` is immediately live, no branch dance needed.
- **Package-name collision, same shape Auriga will hit**: Portunus renamed its PyPI
  distribution `portunus` → `pantheon-portunus` (installed command stays `portunus`)
  because the plain name was already taken by an unrelated project. Confirmed via `npm
  view`: plain `auriga` is also taken on npm (an unrelated isomorphic toolkit,
  `auriga@2.7.0`); `pantheon-auriga` is free.

## 2. Auriga's existing adapter interface — real gap found

`backlogAdapter` (`src/router/lib/adapters/backlog-adapter.mjs`, full contract, 6
methods): `listIssues`, `listAllProjectIds`, `getIssueRuns`, `getIssuePullRequests`,
`setIssueStatus` (write — status only), `commentOnIssue` (write — comment only). **No
"create a new issue/task" method exists anywhere** — not in the typedef, not in the real
Multica implementation (`adapters/multica/backlog.mjs`), not in the stub
(`adapters/stub/backlog.mjs`). This is a real, confirmed gap, not an assumption — grepped
for `multica issue create` and equivalents, zero hits.

`.pHive/cross-cutting-concerns.yaml`'s `adapter-boundary-integrity` concern applies
directly: "Story touches ... any new adapter module, or anything that talks to a backlog
source" and requires no direct vendor import outside its own adapter implementation, plus
a working stub path.

`src/server/` (the p3-auriga-ui HTTP read-API) is **not usable as the MCP server's data
source** — it's a separate, hard-coded-read-only layer over local `.pHive/*.yaml`
*planning* docs (epics/stories as planned, not live board state), not wired to
Multica/backlogAdapter at all. Every non-GET method returns 405 by explicit design
("v1 is display-only"). An MCP tool needing live board state (what's in flight, what's
blocked) must call `backlogAdapter` directly — mirroring Portunus's own "direct,
in-process, no subprocess/HTTP boundary" call structure — not go through `src/server/`.

## 3. Auriga's existing CLI entrypoint pattern

`auriga-router.mjs` uses flat manual `process.argv` boolean/value-flag parsing (`--once`,
`--dry-run`, etc.) — no subcommand concept, not a natural fit for nested `agent
init`/`agent status`/`mcp` subcommands.

`src/router/package.json` already declares `"bin": {"auriga-router": "./auriga-router.mjs"}`
— scoped to the router's own cycle-loop CLI, not a general-purpose `auriga` command.
**Confirmed: no top-level `auriga` CLI is installable anywhere today** — no `npm link`,
no global-install docs, nothing. Root `package.json` has no `bin` field (test-runner
wrapper only, `"private": true`). No MCP SDK dependency exists anywhere in the repo today
(grepped `modelcontextprotocol`/`@anthropic-ai/mcp`/etc., zero hits).

## 4. UI surfaces

`src/ui/src/App.jsx` — single-file `App()`, local `useState`-based route switching, a
`<header>` (lines 37-53) with title/subtitle + 2-tab `<nav>`. **Zero existing
dismissible/collapsible/localStorage pattern anywhere in `src/ui/src/`** (grepped) — a
"collapse after first view" banner is net-new UI work, not an extension of something
that exists.

`docs/index.html`'s `#install` section (lines 953-1004) — 3 numbered `.step` divs (clone
→ verify → build+run), a `.cta-row`, using an established `.install-steps`/`.step-num`
pattern. No agent/MCP content exists yet; a new subsection can extend this pattern rather
than invent a new visual language.

## 5. GitHub Pages — simpler than Portunus's setup

Confirmed live: `{"status":"built","source":{"branch":"main","path":"/docs"}}`. A new
`docs/install.sh` is reachable at `https://mdostal.github.io/auriga/install.sh`
immediately on push to `main` — no separate branch, no publish workflow needed (unlike
Portunus's apparent manual `gh-pages` step).

## Open items for design discussion

1. **The backlogAdapter gap**: does this epic add a `createIssue`-shaped write method to
   the adapter contract (+ both real and stub implementations) so the MCP server can
   genuinely "add a task to the queue," or does v1 ship read/status-only tools and defer
   task-creation to a later epic?
2. **CLI shape**: where does `auriga agent init`/`agent status`/`mcp` actually live —
   a new bin script alongside the existing `auriga-router` bin, or something else?
3. **Node MCP SDK**: `@modelcontextprotocol/sdk` (the direct Node/TS equivalent of
   Portunus's `mcp` Python package) is a new dependency — first one in this codebase.
4. **Package naming**: `pantheon-auriga` on npm (mirrors Portunus's `pantheon-portunus`
   resolution), installed command stays `auriga`?
5. **UI collapse/dismiss mechanism**: net-new localStorage-backed pattern in `src/ui/`,
   needs a design decision on scope (dashboard only, or the showcase page's static HTML
   too, which has no client-side state today at all).
