# Auriga v0.1.0 — first public release

Auriga is the router god of Pantheon: it senses a work board and dispatches every
ticket to the lane and agent best able to do it. This release is the first time it's
public, standalone-runnable, and has real ways to install and interact with it.

**What's in this release:**

- **Runs standalone.** Auriga's dispatch/state-machine core no longer talks to Multica
  directly — a `backlogAdapter`/`spawnAdapter` interface sits between them, with a real
  implementation and an in-memory stub. Zero live external systems required to run it.
- **A real dashboard.** A Vite/React operator UI — epics, story detail with dependency
  view, activity log — served by a local read-only HTTP API over Auriga's own planning
  state.
- **A public showcase page**, live at https://mdostal.github.io/auriga/, explaining
  what Auriga is and how to install it.
- **An MCP server + CLI.** `auriga agent init` registers Auriga's MCP server with
  Claude Code or Codex CLI, so your own agent session can query the board directly —
  what's in flight, what's blocked, story detail — without opening the dashboard.
  Read-only in this release, by design.
- **A real project registry.** `auriga project scan/add/remove/list` replaces a
  hand-edited config file with a real CLI for telling Auriga what to orchestrate.

Install: `curl -fsSL https://mdostal.github.io/auriga/install.sh | bash`

Source: https://github.com/mdostal/auriga
Full changelog: https://github.com/mdostal/auriga/blob/main/CHANGELOG.md
