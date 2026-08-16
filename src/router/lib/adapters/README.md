# Adapters

Auriga's router core (`lib/core.mjs`) is pure decision logic: given
issue/run/PR shapes, it decides what should happen next. It never talks to a
specific backlog system or a specific runner directly — that boundary is
enforced by two adapter interfaces:

- **`backlog-adapter.mjs`** — `BacklogAdapter`: read/write the system that
  tracks work items (list issues, read runs/PRs, change status, comment).
- **`spawn-adapter.mjs`** — `SpawnAdapter`: dispatch/assign/rerun/unassign an
  agent against an issue.

Both are JSDoc `@typedef` contracts only — no TypeScript build step, no ES6
classes. This codebase has zero `class` declarations anywhere; every
implementation is a plain factory function, `createXAdapter(cfg)`, returning
a frozen object literal (see `.pHive/project-profile.yaml`'s stated
camelCase/plain-function convention).

## Synchronous, deliberately

Every method on both `BacklogAdapter` and `SpawnAdapter` is **synchronous** —
it returns its plain result directly, never a `Promise`. This is a deliberate
match to the real, already-synchronous implementation
(`lib/multica.mjs`, backed by `execFileSync`) and to every existing consumer
call site: `auriga-router.mjs`'s `cycle()` calls its injected `mca`
dependency across ~25 sites, several inside synchronous `.some()`/`.filter()`
callbacks, and never `await`s any of them (`cycle()` being declared `async`
is unrelated — it awaits its own `sleep()`, not `mca`). Do NOT "improve" these
interfaces back to async/Promise-returning without a real story that needs
it: doing so would force the future router-cutover story to convert control
flow around every one of those call sites into async/await, turning what
should be a mechanical rename into a real, higher-regression-risk async
refactor. If a future concrete implementation genuinely needs to be
asynchronous (e.g. a network-backed backlog), that is the point to revisit
this decision explicitly — not a reason to default to async now.

## Why two adapters, not one

A backlog (where work items live) and a runner (what actually executes work
against them) are genuinely different concerns with different failure modes.
A future concrete implementation of one may need to change independently of
the other — e.g. swapping which system runs agents without touching how
issues are read, or vice versa. Splitting the interface in two keeps
`lib/core.mjs`, and any future cutover of `auriga-router.mjs` onto these
adapters, from ever depending on a vendor-specific shape for either concern.

## Stub implementations

`stub/backlog.mjs` and `stub/spawn.mjs` are in-memory, dependency-free
implementations of the two contracts, built for tests:

- `stub/backlog.mjs`'s `createStubBacklogAdapter(seedData)` seeds an
  in-memory store from plain issue/run/PR fixtures and mutates that store in
  place (`setIssueStatus`, `commentOnIssue`) so a test can observe state
  changes across a single pass.
- `stub/spawn.mjs`'s `createStubSpawnAdapter()` records every call it
  receives onto `.calls` so a test can assert on exactly what was
  dispatched/assigned/rerun/unassigned.

Neither one shells out to anything. `test/standalone-smoke.test.mjs` proves
this end-to-end: it drives `auriga-router.mjs`'s real, unmodified `cycle()`
against only these two stubs and asserts, via a mock on
`node:child_process`'s `execFileSync`, that zero external process calls are
ever attempted.

## No pre-emptive integrations

`spawn-adapter.mjs` deliberately has **no provisioning method, hook, or
middleware slot of any kind** — see the comment block at the top of that
file.

This generalizes an explicit decision made during this epic's design review:
Auriga must never pre-build a concept for a tool (Vulcan, or any other future
provisioner) it doesn't yet have a real story for. The rule applies to
**both** adapters, not just spawn: do not add a method, field, or hook to
either `BacklogAdapter` or `SpawnAdapter` speculatively. Every method in
these two contracts exists because `lib/core.mjs` or `auriga-router.mjs`'s
`cycle()` actually consumes the equivalent capability today. When a real need
shows up, add the method then, in the story that needs it — not before.

See `.pHive/CONTEXT.md` and the `adapter-boundary-integrity` cross-cutting
concern in `.pHive/cross-cutting-concerns.yaml` for the fuller rationale.
