# Grill Record — p5-agent-mcp-integration

**Source draft:** .pHive/epics/p5-agent-mcp-integration/docs/design-discussion.md
**CONTEXT.md substrate:** present
**round_number:** 1
**unresolved_count:** 10 (2 touching real blocking risk)

## Summary

- Vocabulary mismatches: 2
- Hidden assumptions: 3
- Unresolved tensions: 2
- Convention violations: 1
- Posture mismatches: 2

**Verified accurate (no finding, stated for calibration):** `backlogAdapter` genuinely
has no create/add-issue method. `src/server/` is genuinely GET-only. `@modelcontextprotocol/sdk`
is real and published (1.30.0). `src/router/package.json` is `"type":"module"`, only
`auriga-router` bin exists. `cross-cutting-concerns.yaml` has exactly the two concerns
already known. `pantheon-auriga` is genuinely free on npm. GH Pages confirmed
`/docs` on `main`. Portunus's code quotes in the research brief match the real commit
`9621eb2c` verbatim in substance.

## Vocabulary mismatches

- **V1** — "Read/status-only v1" (Open Question 1) is ambiguous about `backlogAdapter`'s
  two EXISTING write methods (`setIssueStatus`, `commentOnIssue`) — neither doc states
  whether an MCP server built under this framing exposes those as tools. Does "status-only"
  mean zero mutation capability, or status-transition mutation included and only
  task-creation excluded?
- **V2** — The design's Prelude stretches north_star's "many concurrent sessions" (the
  DISPATCH-side audience — Auriga handing work to sessions) to also justify the
  QUERY-side single-session MCP use case this epic actually builds, which the research
  brief itself calls "reversed in direction" one paragraph earlier. Is there a real
  connection, or is the quote doing more justification work than it should?

## Hidden assumptions

- **H1 (CRITICAL)** — No safety/authz discussion for write-capable tool exposure. Once
  any board-mutate tool is live (new `createIssue`, or the pre-existing
  `setIssueStatus`/`commentOnIssue`), ANY Claude/Codex session — including one running
  unattended or spawning subagents — can mutate the real live Multica board via a tool
  call the operator never directly typed. Is autonomous, unconfirmed board mutation via
  an LLM tool call an accepted risk, or does it need a confirmation gate?
- **H2** — `backlogAdapter`'s contract is explicitly synchronous
  (`execFileSync`-backed); some methods (`listAllIssues`, `listCandidatePullRequests`)
  do paginated, multi-subprocess, potentially multi-second scans. The design commits to
  calling the adapter "directly, in-process" from MCP tool handlers with no discussion
  of what a multi-second synchronous call does to the MCP server process or to
  tool-call timeouts on the harness side. Is that latency profile acceptable as-is?
- **H3** — No mention of whether the operator's live `~/.claude`/codex config is under
  any external management (sync tooling, policy) a `claude mcp add --scope user`
  mutation could interact badly with. Simply assumed safe to mutate?

## Unresolved tensions

- **U1 (CRITICAL)** — Real chicken-and-egg: Slice 3 registers via `claude mcp add
  --scope user auriga -- auriga mcp` (a bare command name, requires `auriga` on
  `$PATH` at registration time). Slice 4 (`install.sh`) is the only described
  PATH-provisioning mechanism, and is sequenced AFTER Slice 3. Yet Verification Strategy
  demands a real MCP round-trip as part of Slice 3's own bar. Neither doc mentions
  `npm link` or an interim dev-install step. How is Slice 3 verified end-to-end before
  Slice 4 exists?
- **U2** — §8 quotes Hive's own Medium-scope trigger ("multi-file, multiple layers,
  cross-stack: needs H/V planning to slice correctly"), confirms the epic matches it,
  then recommends skipping H/V in favor of vertical slices alone — addressing only the
  "V" half. No horizontal/cross-slice pass exists (e.g. how the MCP module boundary
  interacts with the CLI module, or where real-vs-stub adapter config lives across
  slices). Is "vertical slices alone" equivalent to what the quoted criterion demands?

## Convention violations

- **C1** — The `documentation` cross-cutting concern (applies when a story "adds/
  removes/renames reference documents") is never walked, despite this epic clearly
  triggering it: modifies `README.md`, adds a brand-new public `docs/install.sh`,
  modifies `docs/index.html`. `adapter-boundary-integrity` is walked explicitly; this
  one is silent. Given the draft prides itself on walking concerns rather than
  deferring them, why is this one skipped?

## Posture mismatches

- **P1** — The real-machine-mutation risk (§4) is named but rated "Low," with its
  mitigation ("a real init → status → re-init → teardown cycle") asserted rather than
  interrogated — no discussion of what happens if that cycle is interrupted mid-run
  (crash, timeout) leaving the operator's live config half-registered, or whether this
  verification runs unattended vs. human-watched. Is "Low" the right severity for a
  step that mutates the operator's live, daily-use tool config as part of routine
  verification?
- **P2** — The draft repeatedly emphasizes its own rigor ("grounded in file reads, not
  inference," citing p4's grill as its bar to clear) while simultaneously skipping the
  `documentation` concern (C1) and leaving the PATH sequencing gap (U1) unmentioned. Is
  the stated rigor bar applied consistently, or selectively to the parts easiest to
  verify by reading code?

## Out of scope (this pass)

Grill does not propose solutions. Resolution happens in the design-discussion revision
and, for H1/U1 in particular, in direct operator sign-off — these are real judgment
calls (accepted-risk vs. gated) not something to silently resolve.
