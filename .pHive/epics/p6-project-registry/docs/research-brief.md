# Research Brief: Standalone Project Registry

**Epic:** p6-project-registry
**Requirement:** turn `config-substrate.mjs`'s hardcoded `PROJECT_NAMES`/`PROJECT_IDS` into
a real, living registry — `add`/`remove`/`list`/`scan` operations, plus freeform notes
("base level memory") per project — all owned and stored by Auriga itself, standalone,
not routed through Mnemosyne or any other sibling god.

## 1. The current hardcoded shape, and what's actually functional vs. cosmetic

`config-substrate.mjs`'s own header already frames this exact gap: a "KNOWN GAP" comment
(verbatim) states 8 unmapped projects were named in an earlier epic's plan, only 1
("Tools") corresponds to a real Multica project, and "fabricating routing entries for
non-existent projects would be wrong... needs reconciliation with Minerva/operator before
this part of the epic can be completed." This epic is that reconciliation mechanism.

Tracing every real call site (not assumption):
- **`PROJECT_NAMES`** — cosmetic only. 3 read sites in `core.mjs`, all
  `cfg.PROJECT_NAMES[issue.project_id] || issue.project_id` — always has a safe fallback
  to the raw UUID. Nothing routing-critical depends on a name existing.
- **`PROJECT_IDS`** — functional and order-sensitive. This is the actual **dispatch-
  eligibility gate**: `core.mjs`'s `selectAssignments` and `detectCascadeDispatch` both
  filter to `PROJECT_IDS`-aligned projects only — **a project missing from this list is
  silently excluded from real dispatch/cascade entirely**, even though board-wide status
  scans (`listAllProjectIds()`) already see it. Order also determines dispatch priority
  (`core.mjs` sorts by `PROJECT_IDS.indexOf(...)`) — this is why the file's own comment
  says "aligned lanes first... Consus LAST so it is drained sparingly."
- **`PROJECT_LANE`** — functional but safely degrades. A project missing from
  `PROJECT_LANE` already falls back cleanly to `DEFAULT_LANE` (`core.mjs`'s
  `chooseAgentForProject`: `cfg.PROJECT_LANE[projectId] || cfg.DEFAULT_LANE`) — this is
  NOT the silent-exclusion mechanism (`PROJECT_IDS` is).

**What a real registry must therefore still guarantee**: an ordered, ID-equivalent set
that gates real dispatch eligibility. Everything else (display names, lane assignment)
can degrade gracefully or stay out of scope without breaking routing.

## 2. Project discovery — what's really available for a "scan"

`backlogAdapter.listAllProjectIds()` returns **IDs only**, by typedef contract. The real
Multica implementation calls `multica project list --output json` and then does
`.map((p) => p && p.id)` — **discarding whatever else each project object carries**. No
other call site in this codebase reveals the full shape of a Multica project object
(name/description fields), so what `scan` can show beyond raw IDs is not yet confirmed
without a real `multica project list` call or a new adapter method that stops discarding
those fields.

**Real precedent for extending the adapter with a "ported extra"**: `listAllIssues` and
`listCandidatePullRequests` are both already-established patterns of methods NOT in the
strict `BacklogAdapter` typedef, present only on the real (and sometimes stub)
implementation, presence-checked by callers (`scanAllIssues` in `lib/mcp/server.mjs`
already does exactly this shape). A `listAllProjects()`-style ported extra (returning
`{id, name}` instead of bare IDs) would follow this exact, already-proven convention —
not a new pattern, and not "pre-emptive" since scan genuinely needs it now.

**Project vs. repo — already a clean, distinct mental model in this codebase.** A Multica
"project" (board container) and a GitHub "repo" (where code lands) are already modeled
separately: each `AGENTS[name]` entry has its own `repo:` field; `PROJECT_LANE` maps a
project UUID to agent *lane names*, connecting to a repo only one hop away via
`AGENTS[laneName].repo`. `REVIEW_REPO_OWNER`/`REVIEW_SEARCH_REPOS` are a wholly separate,
GitHub-only concept for the review lane's PR discovery, unconnected to Multica projects.
This epic's registry is about Multica *projects* specifically — repo association, if
wanted, is a separate concern already served by the existing `AGENTS[...].repo` field.

## 3. Where persistent state should live — no existing dotfile precedent

**Corrected per grill V1**: grepped the whole router for local file writes and found 3
real write call-sites across 2 files, not 1 — `auriga-router.mjs`'s PID-file write and
log-file append, plus `reroute-hive-off-codex.mjs`'s log append. All 3 default to `/tmp`
(ephemeral), so the substantive conclusion (no committed/persistent-state precedent)
still holds — the count itself was simply wrong on first pass. `AURIGA_PIDFILE`/
`AURIGA_LOG` both default to `/tmp` (ephemeral, not real state). `AURIGA_PHIVE_ROOT` is
explicitly test-only (Playwright fixture override), not a production state-dir
convention. **No `~/.auriga/`-style machine-local directory exists anywhere in this
repo.** The p5 CLI's `agent-setup.mjs` writes zero local files — MCP registration is a
pure CLI shell-out to the harness's own tooling, confirmed by that file's own header
comment.

**The one real precedent for "operator-extensible list" is `HUMAN_NAMES`** — a plain
committed array literal in `config.mjs`, hand-edited, with an explicit maintainer
comment inviting edits, no CLI/file mechanism. This is closer to what
`PROJECT_NAMES`/`PROJECT_IDS`/`PROJECT_LANE` already are today (committed source,
hand-edited) than to a gitignored machine-local state file — and functionally, which
projects Auriga dispatches to is genuinely shared, portable state (same router,
potentially different machines/operators), not personal-machine-only state like an MCP
registration.

## 4. p5 CLI conventions to model a new `project` subcommand family on

`bin/auriga.mjs` owns ONLY argv parsing + output formatting (explicit in its own header
comment), delegating all logic to a separate lib module. Dispatch is a flat
`if (cmd === X && sub === Y)` chain, not a framework. `lib/agent-setup.mjs`'s functions
that touch the outside world take an **injected dependency** as their first parameter
(`execFileSync` there) so tests assert exact calls against a plain function double, zero
real subprocess/file I/O — `agent-setup.test.mjs` confirms this pattern with inline
array-recording closures, no mocking library. A new `lib/project-registry.mjs` should
mirror this shape exactly: pure functions taking an injected `fs`-like dependency (or a
resolved file path + injected read/write functions) for testability.

`src/router/package.json`'s existing `bin` field (`{"auriga-router": ..., "auriga": "./bin/auriga.mjs"}`)
is where a `project` subcommand family attaches — no new bin entry needed, just new
dispatch branches in the existing `auriga.mjs`.

## 5. Cross-cutting concerns — re-confirmed verbatim

`adapter-boundary-integrity`'s `applies_when` explicitly names `src/router/lib/config.mjs`
— this concern is triggered by this epic regardless of whether the registry itself makes
any external call, purely because it touches that file path. Its `implementation_checklist`
includes "New hardcoded IDs, workspace-specific values, or lane maps are NOT added to
core logic — they live in adapter config" — directly on-point: this epic is explicitly
*removing* hardcoded values from `config-substrate.mjs`, the opposite direction of a
violation, but the concern still needs walking explicitly in design-discussion, not
skipped.

`lib/adapters/README.md`'s "No pre-emptive integrations" section, verbatim: "Auriga must
never pre-build a concept for a tool... it doesn't yet have a real story for... When a
real need shows up, add the method then, in the story that needs it — not before." This
directly grounds the operator's own instruction not to build any Mnemosyne/pantheon-v2-l2
hook in this epic.

**Concrete existing precedent for exactly this boundary**: `lib/adapters/pantheon-v2-l2/`
already exists — both its `BacklogAdapter` and `SpawnAdapter` implementations are fully
stubbed, every method throws `NotImplementedError`, and its own README states this is
"the epic's deliberate final state, not a placeholder... Pantheon's own future, separate
epic — not Auriga's job." If this epic needs to gesture at a future Mnemosyne sync at
all (it likely doesn't need to), this stub-that-throws shape is the established pattern
to mirror, not a real hook.

## Open items for design discussion

1. **Registry storage format and location** — no existing precedent forces a specific
   answer, but the functional analysis above (PROJECT_IDS gates real dispatch,
   genuinely shared/portable state, closest existing precedent is `HUMAN_NAMES`'s
   committed-and-hand-edited shape) points toward a committed JSON file the CLI
   reads/writes, not a gitignored machine-local directory.
2. **Scan's name/description capability** — needs a new "ported extra" adapter method
   (`listAllProjects()`-shaped, following the exact precedent `listAllIssues`/
   `listCandidatePullRequests` already established) since the current
   `listAllProjectIds()` discards everything but the ID.
3. **Is PROJECT_LANE (agent-lane assignment) in scope for this epic, or does the
   registry only cover "which projects exist + notes," leaving lane assignment as a
   separate, still-hand-edited concern** — given PROJECT_LANE already degrades safely
   to DEFAULT_LANE when absent, scoping it out doesn't break anything.
