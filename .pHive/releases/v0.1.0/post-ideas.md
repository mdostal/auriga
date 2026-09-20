# Auriga v0.1.0 — post ideas

- **"Zero to querying your board in one command"** — lead with the install.sh one-liner
  through to a real `auriga_get_story` MCP tool call from a Claude Code session.
- **"We made our orchestrator's config a CLI instead of a source file"** — the
  project-registry story: what `PROJECT_NAMES`/`PROJECT_IDS` used to look like
  (hardcoded object literals) vs. `auriga project add`.
- **"The dashboard vs. the MCP server: two ways to ask Auriga what's happening"** —
  contrast the visual dashboard (browse, at a glance) against the MCP tools (ask a
  specific question from inside your own agent session).
- **"Standalone by design"** — the adapter-interface story: why Auriga's core has zero
  hardcoded coupling to Multica/GitHub/any specific backlog, and what that buys an
  operator who wants to point it at something else entirely.
- **Technical deep-dive**: the `auriga_get_story` latency fix (75s -> 50ms) as a small,
  self-contained case study in "measure before you ship, then measure again after you
  claim it's fixed."
