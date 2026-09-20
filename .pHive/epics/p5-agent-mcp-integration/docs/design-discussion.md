# Design Discussion: Agent/Harness Install-and-Interact (MCP Server)

## 0. Prelude

**NORTH STAR** (from `.pHive/project-profile.yaml`):
Goal: Auriga becomes a generic, standalone top-level orchestrator with pluggable
backlog/spawn adapters — no direct external-system coupling.
Audience: the operator, running many concurrent sessions across many unrelated
projects, wanting Auriga as the top-level dispatcher above all of them.

**Revised per grill V2**: north_star's "many concurrent sessions" text actually
describes the DISPATCH-side audience — Auriga handing work out to many sessions, not
an operator querying it back. This epic is the reverse direction (one operator session
asking Auriga a question), which north_star doesn't literally describe. The honest
connection is narrower: north_star's audience is "the operator... wanting Auriga as
the top-level dispatcher," and an MCP query surface is a plausible tool for that
operator to check on their own dispatcher without opening a UI — a reasonable
extension, not something north_star already asked for verbatim.

**PRIOR ART**: `p2-adapter-interface` (the `backlogAdapter`/`spawnAdapter` pattern this
epic must respect), `p3-auriga-ui` + `p4-auriga-branding` (the dashboard and showcase
page this epic adds UI surfaces to).

## 1. What Are We Doing?

Operator's explicit scope decision (asked directly, only this option chosen): build
the **operator-side MCP server** direction, not a formalization of the existing
dispatch-side agent-instructions contract, and not a docs-only install story.

Four pieces:
1. A new Auriga MCP server exposing board-query (and, pending Open Question 1,
   board-mutate) tools to any Claude Code/Codex session the operator runs.
2. `auriga agent init` / `auriga agent status` CLI commands mirroring Portunus's
   pattern — detect harnesses, register the MCP server, install skills.
3. A real `docs/install.sh` published via the GitHub Pages setup `p4-auriga-branding`
   already stood up.
4. A prominent, collapsible "install & interact" surface in both the dashboard
   (`src/ui/`) and the showcase page (`docs/index.html`).

"Done": an operator can run one install command, then immediately ask their own Claude
Code/Codex session about Auriga's board state and get a real answer — not a demo, a
real MCP round-trip against this repo's actual `.pHive/` state or live Multica board
(scope-dependent, see Open Question 2).

## 2. What I Found

Research read Portunus's actual implementation (not just the operator's description)
and Auriga's real adapter/CLI/UI code — see `research-brief.md` for full detail. Three
findings materially shape this design:

- **Portunus's `agent init`/`agent status` feature is not yet on its own `main`
  branch** — it's on `dev`/`feat/portunus-agent-init`. Not a blocker for Auriga, but
  means the reference pattern is itself mid-flight, not a settled convention.
- **`backlogAdapter` has no "create a new task" method** — confirmed across the
  contract, the real Multica implementation, and the stub. An MCP "add a task" tool
  cannot be built without first extending the adapter (contract + both
  implementations), which is real, adapter-boundary-integrity-governed scope this
  epic didn't originally account for.
- **`src/server/`'s existing HTTP API cannot be reused as the MCP server's data
  source** — it's a read-only layer over local `.pHive/*.yaml` *planning* docs, not
  live board state, and is GET-only by hard design ("v1 is display-only"). The MCP
  server needs to call `backlogAdapter` directly, in-process — which actually mirrors
  Portunus's own explicit "no subprocess/HTTP boundary" design decision for its MCP
  server, so this isn't a deviation, it's the same pattern applied consistently.

## 3. My Proposed Approach

Given the real gap found in §2, I'm proposing this as **vertical slices** (each leaves
the product in a working state), sequenced so the riskiest unknown (the adapter
extension) lands first:

**Slice 1 — Extend `backlogAdapter` with a create method (if Open Question 1 says yes).**
Add `createIssue(projectId, title, body)` to the contract + real Multica
implementation + stub implementation, with real tests against the stub (per
adapter-boundary-integrity's own checklist: "stub adapter exists and is exercised by
tests"). This is pure backend work, no MCP/CLI/UI yet — a working, tested addition to
an existing subsystem.

**Slice 2 — The MCP server itself.** New module (likely `src/router/lib/mcp/` or a
sibling package), using `@modelcontextprotocol/sdk` (Node/TS equivalent of Portunus's
`mcp` Python package — first use of this SDK in the repo), stdio transport (matching
Portunus), calling `backlogAdapter` directly in-process. Tools: list epics/stories with
status, get story detail, check what's blocked/in-flight, and (if Slice 1 shipped)
add a task. Runnable and testable standalone (via the stub adapter) before any CLI
wiring exists.

**Slice 3 — CLI: `auriga agent init`/`agent status`/`mcp`.** New bin script (e.g.
`src/router/bin/auriga.mjs`, added as a second `bin` entry in
`src/router/package.json` alongside the existing `auriga-router`), mirroring
Portunus's exact `mcp_registered`/`register_mcp` shape: `shutil.which`-equivalent
harness detection (Node: check `$PATH` via `which`/`process.env.PATH` scan), the
**same targeted-lookup fix Portunus already learned the hard way** (`claude mcp get
auriga`, not `claude mcp list` — the 30+s health-check-everything bug is real and
already-diagnosed, no need to rediscover it), registration via `claude mcp add
--scope user auriga -- auriga mcp` / `codex mcp add auriga -- auriga mcp`, idempotent,
`--harness` narrowing, `status` read-only.

**Resolved per grill U1 (real chicken-and-egg, not silently dropped)**: `claude mcp
add ... -- auriga mcp` requires `auriga` to already resolve on `$PATH` at registration
time, but Slice 4 (the only PATH-provisioning mechanism) is sequenced after Slice 3,
and Slice 3's own verification bar demands a real round-trip. Fix: Slice 3's
verification uses `npm link` (from `src/router/`) as the interim dev-install step —
this is the standard Node mechanism for "make a local package's bin resolve on
`$PATH`" without needing Slice 4's public install path to exist yet. Slice 4 later
proves the SAME registration flow works via the public install path too, but Slice 3
does not block on it.

**Module boundaries (grill U2 — the "H" half of H/V, addressed directly here rather
than a separate document):** the MCP module (Slice 2) and the CLI module (Slice 3) are
separate files with one shared dependency — the CLI's `mcp` subcommand simply invokes
the same server-start function the MCP module exports, it does not duplicate server
logic. Real-vs-stub adapter selection reuses `p2-adapter-interface`'s existing
env-var-driven switching mechanism (already used by `auriga-router.mjs`) — the MCP
module reads the same env var at startup, no new switching mechanism, no new config
surface.

**Slice 4 — `docs/install.sh` + README.** Bash script mirroring Portunus's shape
(adapted: Node/npm install instead of pipx, `pantheon-auriga` package name per the npm
collision found in research), published via the existing `/docs`-on-`main` Pages setup
(simpler than Portunus's own `gh-pages`-branch path — no extra publish step needed
here). README's top line becomes the curl-pipe-bash one-liner.

**Slice 5 — UI surfacing.** A dismissible/collapsible "Install & Interact" card in
`src/ui/src/App.jsx`'s header (net-new — no existing dismiss/localStorage pattern to
extend, confirmed by research) remembering dismissed state in `localStorage`, and a
matching section in `docs/index.html` near the existing `#install` section (static
HTML — "collapsible" there likely means a plain `<details>`/`<summary>` disclosure
rather than a JS-driven dismiss-and-remember, since the showcase page has zero
client-side state today and shouldn't gain a JS runtime just for this).

## 4. What Could Go Wrong

- **High, unresolved (grill H1) — no safety/authz discussion for write-capable tool
  exposure.** Once ANY board-mutate tool is live — a new `createIssue` (Slice 1), or
  the pre-existing `setIssueStatus`/`commentOnIssue` (already on `backlogAdapter`
  today, zero new code needed to expose them) — any Claude/Codex session, including
  one running unattended or spawning its own subagents, can mutate the real live
  Multica board via a tool call the operator never directly typed. This wasn't named
  in the original draft at all. Not mitigated yet — this is Open Question 1 below, and
  the honest options are: ship v1 fully read-only (no write tools of any kind, not even
  the pre-existing ones), or ship writes but require some form of confirmation the MCP
  protocol/harness actually supports. This needs your call, not a default.
- **Medium — synchronous, subprocess-heavy adapter calls inside MCP tool handlers
  (grill H2).** Some `backlogAdapter` methods (`listAllIssues`,
  `listCandidatePullRequests`) do paginated, multi-subprocess, potentially
  multi-second scans, and the contract is synchronous end-to-end. Calling these
  directly from an MCP tool handler risks a multi-second stall on that tool call, with
  unknown behavior against Claude Code/Codex's own tool-call timeout. Mitigation:
  Slice 2 must measure real latency against the real Multica adapter (not just the
  fast in-memory stub) before being called done, and note actual numbers in its
  verification writeup.
- **Low — scope creep from the adapter gap.** Slice 1 wasn't in the operator's
  original ask; it's a real prerequisite research surfaced. Mitigation: named
  explicitly as Open Question 1 rather than silently added — if the operator says
  read-only-v1 is fine, Slice 1 (and the "add a task" MCP tool) drops entirely and the
  epic gets meaningfully smaller.
- **Low — the operator's live `~/.claude`/codex config may be under external
  management** (sync tooling, backup, policy) that a `claude mcp add --scope user`
  mutation could interact with unexpectedly (grill H3). Not deeply investigated — flagged
  as a live assumption rather than a verified-safe fact.
- **Medium — first use of a new SDK (`@modelcontextprotocol/sdk`) in this codebase.**
  No prior art in Auriga to pattern-match against; some real learning-curve risk on
  the actual tool-registration API surface. Mitigation: Slice 2 is scoped to ship
  standalone-testable against the stub adapter before any CLI/registration work
  depends on it — if the SDK integration is harder than expected, it fails fast and
  in isolation.
- **Medium (raised from Low per grill P1) — harness registration is inherently
  environment-dependent and mutates the operator's live, daily-use tool config.**
  `claude mcp add`/`codex mcp add` mutate real local machine state. The original
  mitigation ("a real init → status → re-init → teardown cycle") asserted this was
  safe without interrogating the failure mode: an interrupted cycle (crash, timeout)
  could leave the config half-registered. Revised mitigation: this verification MUST
  run human-watched, not as part of an unattended/automated agent test pass, and the
  teardown step must be independently confirmed to actually remove the registration
  (re-run `agent status` after teardown and check it reports unregistered), not just
  assumed to have worked because the command exited 0.
- **Low — `pantheon-auriga` npm publish is out of this epic's real control.**
  Confirmed the name is free, but actually publishing to npm is a separate account/CI
  concern not yet set up for this repo. Mitigation: named as Open Question 3 — this
  epic can ship the CLI/install.sh path (git-based install, mirroring how Portunus's
  own install.sh currently installs from GitHub, not PyPI, per research) without
  requiring an npm publish at all.

## 5. Dependencies and Constraints

- `adapter-boundary-integrity` cross-cutting concern applies directly to Slice 1 (any
  new adapter method) and Slice 2 (the MCP server must call the adapter, never
  Multica directly) — walked explicitly here, not deferred to execute-time.
- `documentation` cross-cutting concern (grill C1, previously unwalked) also applies:
  this epic modifies `README.md` (Slice 4's top-line install command), adds a
  brand-new public reference document (`docs/install.sh`), and modifies
  `docs/index.html` (Slice 5). Each story touching these must update
  `.pHive/CONTEXT.md`'s Key paths if it introduces a genuinely new file worth
  documenting there (the new MCP module and CLI bin script likely qualify).
- Local validation is the gate (now documented for real in `.pHive/CONTEXT.md`,
  closed out in `p4-auriga-branding`) — this epic's verification must be a real local
  run against real binaries, not a self-report.
- `hive.config.yaml -> developer.pr_style: atomic-prs` — same real-merge-commit
  convention as prior epics.
- New runtime dependency: `@modelcontextprotocol/sdk` in `src/router/` (or wherever
  Slice 2 lands) — first new dependency since `p2-adapter-interface`.

## 6. Open Questions — RESOLVED (2026-08-18, operator sign-off, all as-recommended)

1. **Write scope: fully read-only v1.** No write tools of any kind — not `createIssue`
   (Slice 1 dropped entirely from this epic), not the pre-existing
   `setIssueStatus`/`commentOnIssue`. Query tools only: list epics/stories with status,
   get story detail, check what's blocked/in-flight. The unresolved autonomous-mutation
   safety question (grill H1) is sidestepped by having nothing to mutate — a follow-on
   epic can revisit write capability once that question has an actual answer.
2. **Adapter target: real Multica-backed adapter by default**, matching
   `auriga-router.mjs`'s own default. Stub available via the existing
   `p2-adapter-interface` env-var switch for local dev — no new mechanism.
3. **npm publish: out of scope.** `docs/install.sh` installs from GitHub directly,
   mirroring Portunus's own current (also-not-yet-published) approach. No new
   account/CI setup.
4. **Showcase collapse: plain `<details>`/`<summary>` disclosure.** Zero JS, matches
   the page's existing zero-client-state design. Does not remember dismissal across
   visits — acceptable per operator sign-off.

## 6 (superseded — original text kept for record)

1. **Revised per grill V1/H1 — what write capability, if any, does the MCP server
   expose in v1?** Three real options, not two: **(a) fully read-only** — no write
   tools at all, not even the pre-existing `setIssueStatus`/`commentOnIssue` methods
   `backlogAdapter` already has; **(b) status-only** — expose the two EXISTING write
   methods (`setIssueStatus`, `commentOnIssue`) as tools, but do not add Slice 1's new
   `createIssue`; **(c) full read+write** — ship Slice 1 too, full task-creation
   capability. This is the single biggest scope AND risk lever in the epic — grill's
   unresolved H1 (no safety/authz discussion exists yet for any autonomous LLM tool
   call mutating the real live board unattended) applies to options (b) and (c) alike,
   not just (c). My lean, revised after the grill finding: **(a) fully read-only v1**
   — it sidesteps the unresolved safety question entirely rather than accepting it
   silently, and the operator's original ask ("what to feed the agent... to get
   interactivity") is substantially served by real read access alone. Write capability
   (b) or (c) is a legitimate follow-on epic once the confirmation/authz question has
   an actual answer, not something to back into by default here. But this is your call.
2. **Does the MCP server talk to the real Multica-backed `backlogAdapter` (live board
   state) by default, or the stub (in-memory, for demo/dev use) — and is that
   switchable the same way `auriga-router.mjs` already switches adapters?** My lean:
   real adapter by default (mirrors `auriga-router.mjs`'s own default), stub available
   via the same env-var/config mechanism already established in `p2-adapter-interface`
   for the router — no new switching mechanism needed, reuse what exists.
3. **Is an actual npm publish (of `pantheon-auriga`) in scope for this epic, or does
   `docs/install.sh` install from GitHub directly** (mirroring Portunus's current
   git-based install, npm publish still pending on Portunus's side too per research)?
   My lean: GitHub-based install for now, npm publish is a separate, later step — no
   new account/CI setup needed to ship this epic.
4. **Showcase-page collapse mechanism**: a plain `<details>` disclosure (zero JS,
   matches the page's current zero-client-state design), or a small inline script with
   `localStorage` (matches the dashboard's mechanism, but introduces the page's first
   JS-driven state)? My lean: `<details>` — consistent with the page being a static
   showcase, not an app.

## 7. Verification Strategy

```
VERIFICATION PLAN:
  Tools: node:test (new MCP server unit tests against the stub adapter), a real
    integration test invoking the actual claude/codex binaries on this machine
    (init -> status -> re-init idempotency -> status again), Playwright (dashboard
    UI card dismiss/remember behavior), oxlint (src/ui/)
  Platforms: this machine's real Claude Code + Codex CLI installs (not mocked),
    browser (dashboard + showcase page)
  Automated: full existing suite must stay green (172 router + 50 server + 8
    Playwright baseline from p4) plus new tests for every new module
  Manual: a real MCP round-trip from an actual Claude Code session asking Auriga's
    new server a real question against this repo's real state — the actual bar the
    operator's original ask implies ("what to feed the agent... to get
    interactivity"), not just unit-tested tool-registration code
  Not verifying: an actual npm publish (Open Question 3 — likely out of scope)
```

## 8. Scale Assessment

```
SCALE ASSESSMENT:
  Files affected: new MCP server module, 2-3 adapter files (if Slice 1 ships),
    new CLI bin script + package.json bin entry, docs/install.sh, README.md,
    src/ui/src/App.jsx (+ new component), docs/index.html
  Subsystems: ONE NEW subsystem (the MCP server) plus extensions to two existing
    ones (backlogAdapter, if Slice 1 ships; the CLI surface, which doesn't exist
    today as a top-level command)
  Migration required: no
  Cross-team coordination: no (single operator, single repo)
  Unknowns: 4 open questions above — Open Question 1 alone changes the epic's size
    materially (drops or keeps Slice 1 + the create-task MCP tool)

  RECOMMENDATION: Medium scope. This is genuinely new architecture (new SDK
  dependency, new subsystem, new CLI, cross-stack UI work) spanning multiple
  layers — matches Hive's own Medium criteria ("multi-file, multiple layers,
  cross-stack: needs H/V planning to slice correctly"). Revised per grill U2: rather
  than skip the "H" half silently, the module-boundary question (§3, Slice 3 note) is
  answered directly in this document — MCP module and CLI module share one
  server-start function, real-vs-stub selection reuses p2's existing env-var
  mechanism, no new config surface. With that gap closed, proposing to use the 5
  vertical slices in §3 as the story decomposition basis directly, without a separate
  horizontal-plan.md/vertical-plan.md document pair. Open to running full formal H/V
  docs if you'd rather have them as standalone artifacts.
```
