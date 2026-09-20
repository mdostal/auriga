# Design discussion: t005-stale-agent-ids-fix

## Goal

Fix GitHub issue #79: after #76's false-done fix landed and was confirmed
genuinely working live, `dostal-tech`'s dispatch loop was STILL fully stuck
— PANT-4 got a fresh `dispatch-review` every ~30s cycle forever, with
`assigned: 0` throughout.

## Investigation (real, cross-session, evidence-first)

No production access from this session — root-caused entirely via code
reading plus two rounds of live data pulled by a cross-session peer
(`pantheon-v2-ff`) with SSH/docker/Multica CLI access to the real
deployment.

1. **Hypothesis formed from code alone:** `selectReviewDispatch` (core.mjs)
   only recognizes a ticket as "already under review" when its board
   `assignee_id` matches `cfg.AGENTS['auriga-review'].id` — a value
   hardcoded in `config.mjs` as `c5beb33c-2a6d-4f78-960a-73966f184506`
   ("filled in from `multica agent create`", no workspace noted).
2. **First live data point (peer):** `GET /api/backlog/agents/auriga-review`
   on the real core-api returns `7545f9ad-41da-4bd9-9674-f0dc223236b9` —
   does NOT match. `multica issue get PANT-4` confirmed its real
   `assignee_id` IS `7545f9ad-...` — the assign call writes the correct,
   live-resolved id every time; the router's own read-side check compares
   against a different, wrong value and can never recognize its own
   assignment. Confirms the router's decision LOGIC is correct; the DATA
   it's reasoning over is stale.
3. **Widened the investigation before fixing anything:**
   `config-substrate.mjs`'s own header comment says "All IDs verified live
   against workspace Pantheon (7feca4c9-...)" — the OLD workspace PR #66
   already found and moved every PROJECT id away from (in favor of the
   correct `f32af269-...`). The AGENTS table had never gotten the same
   treatment — this is the exact same staleness bug class, just never
   applied to agent ids. `computeInflight`/`computeReviewInflight` build an
   `assignee_id -> lane name` map from these same ids, so this was a
   systemic blast radius (inflight capacity counting router-wide), not just
   the one visibly-broken review-lane symptom.
4. **Second live data pull (peer), all 9 agent names:** 8 resolved to real,
   different-from-hardcoded ids. `heimdall-dev` 404'd — no agent by that
   name exists in the corrected workspace. Split out as its own follow-up
   (GitHub issue #80) rather than guessed.
5. **Third finding (peer, independently, reading config.mjs directly):**
   `config.mjs` added the `auriga-review` entry via
   `AGENTS['auriga-review'] = {...}` — an UNCONDITIONAL assignment (not
   `??=`, not a merge) running AFTER `config-substrate.mjs`'s AGENTS object
   was already built. Even fixing the id wouldn't be future-proof: this
   line would silently stomp any tenant-scoped `AGENTS` override
   pantheon-v2's config generator might someday emit for this one agent.
   This is a real, separate structural bug on top of the stale-id one.

## Fix

- Updated 8 of 9 agent ids in `config-substrate.mjs` to the live-verified
  values. Left `heimdall-dev`'s id UNCHANGED with a comment pointing at
  issue #80 — an absent/wrong id fails the same way either way, and
  `chooseAgentForProject` already falls back to `heimdall-dev-codex`, so
  guessing would add risk without removing any.
- Moved `auriga-review`'s entire definition from `config.mjs` into
  `config-substrate.mjs`'s `AGENTS` default (with its correct id) — it is
  now just another entry in the one real default, uniformly overridable via
  `_ext.AGENTS` exactly like every other agent, with zero special-cased
  mutation and zero stomp risk.
- Updated both files' stale header comments (removed the wrong workspace
  claim, added the real re-verification note + issue reference).

## Verification

Full `npm run test:all` green before and after (308+52 unit/integration,
8 e2e/hardening — 2 new tests added). No test hardcoded any of the old
stale UUID strings (grepped to confirm before changing). Cannot verify
against the real live board from this session — that verification is the
cross-session peer's to confirm post-deploy, same as #76/#78.

## Scale

Small — pure config data correction + one structural stomp-guard removal,
zero router decision-logic changes. Design discussion is sufficient.
