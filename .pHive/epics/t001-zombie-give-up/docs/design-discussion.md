# Design discussion: t001-zombie-give-up

## Goal

Fix GitHub issue #75 (triage t-001): Auriga's own `detectZombies` (core.mjs)
detects a stale `in_progress` issue and re-fires `assign`/`rerun` every
cycle, forever, without ever resolving it. Answer the issue's explicit
question — is this intentional stopgap or scope creep? — with a real
architectural decision, and stop the pointless infinite loop either way.

## The architectural question

`plugins/hellsing/README.md` (pantheon-v2 host repo) documents that
"the dangerous actuation of terminating stuck processes" belongs to
Hellsing, with Auriga staying "a thin, event-driven state-machine
consumer." Hellsing is `phase: concept` with zero runnable code anywhere.

**Decision: intentional stopgap, not scope creep — but it must stop looping
forever.** Auriga cannot defer zombie recovery entirely to a god that
doesn't exist and isn't running anywhere; a stuck story with no recovery
attempt at all is strictly worse than one Auriga tries to unstick a bounded
number of times. What IS scope creep — and what this fix removes — is the
UNBOUNDED part: retrying forever, indefinitely, is Auriga overstepping into
"we'll keep throwing actuation at this until something works," which edges
toward the dangerous, open-ended actuation Hellsing's README reserves for
itself. The fix keeps Auriga's actuation bounded and clearly logged, and
makes the boundary with Hellsing explicit in code so a future session
wiring up Hellsing knows exactly what to take over.

Auriga also has no capability to actually TERMINATE a stuck runtime process
today (no such method exists on SpawnAdapter, and adding one would be
exactly the kind of pre-emptive integration this repo's own adapters
README explicitly forbids — building a capability ahead of a real,
concrete consumer). So "resolve/terminate" in the issue's own ask is
interpreted here as: stop endlessly re-actuating, and surface the give-up
clearly (log event + a comment on the issue) so a human — or, later,
Hellsing — has something concrete to act on. Actually killing/restarting
the underlying process stays out of scope, reserved for Hellsing per the
documented architecture.

## Fix

`detectZombies` (core.mjs) already receives `runsByIssue` — the issue's own
run history is a natural, stateless attempt counter (no new persistent
state needed, consistent with this file's existing pure-function style).
Add a bounded cap: once an issue's run count reaches
`cfg.CAPS.zombieMaxAttempts` (new config, sane default e.g. 3), stop
emitting `assign`/`rerun` actions for it and instead emit a `give-up`
action.

`auriga-router.mjs`'s zombie-recovery block handles `give-up` distinctly:
log a `zombie_give_up` event (never actuates spawn/assign again for that
issue on this path) and best-effort leave a comment on the issue via
`backlog.commentOnIssue` (already part of the BacklogAdapter contract,
already used elsewhere with the same try/catch-and-continue convention) so
there's a durable, human-visible marker distinct from the routine zombie
log noise.

Document the Hellsing boundary explicitly in a code comment on
`detectZombies` and in this epic, so this reads as a considered, bounded
stopgap — not silent scope creep — and is easy to unwind once Hellsing
exists and takes over actuation.

## Risks

- Low. Purely additive: bounded stories behave exactly as before (rerun/
  assign) until they cross the attempt cap; only stories that were ALREADY
  looping forever change behavior, and only to stop looping.
- The give-up comment write is best-effort (existing convention) — a
  comment failure must never block giving up.

## Scale

Small — one function's bounded-cap addition + one router call-site branch +
a config default. Design discussion is sufficient; no H/V planning needed.
