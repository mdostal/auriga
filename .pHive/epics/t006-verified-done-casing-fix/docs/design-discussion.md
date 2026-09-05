# Design discussion: t006-verified-done-casing-fix

## Goal

Fix GitHub issue #81: `detectVerifiedDone` (core.mjs) never advances an
`in_review` story to `done` off a genuinely merged PR, because its check
compares against field names/casing that real `gh`-sourced PR objects never
actually use. Confirmed live: 19 stories stuck `in_review` on `dostal-tech`,
some 4-5+ days stale, despite having real merged PRs.

## Root cause (verified against current code myself, 2026-09-05)

```js
export function detectVerifiedDone(inReviewIssues, prsByIssue) {
  ...
  const merged = prs.some((pr) => pr.state === 'merged' || pr.merged_at != null);
```

Real PR objects come from `gh pr list --json ...,state,mergedAt` (see
`pantheon-v2-l2/index.mjs`'s `ghPrs()`), where `gh` itself returns:
- `state: "MERGED"` — uppercase, never lowercase `"merged"`.
- `mergedAt: "<timestamp>"` — camelCase, never snake_case `merged_at`.

Both halves of the `||` are therefore always false for every real PR this
data source produces — `detectVerifiedDone` can structurally never fire.
`prIsOpen()`, a few dozen lines below in the same file, already normalizes
correctly:

```js
export function prIsOpen(pr = {}) {
  const st = (pr.state || '').toLowerCase();
  if (st === 'open') return true;
  if (st === 'merged' || st === 'closed') return false;
  return !pr.merged_at && !pr.mergedAt && !pr.closed_at && !pr.closedAt;
}
```

**A closely related note, not a live bug:** `detectFalseDone`'s merged-PR
guard (added this week for #76, line ~929) has the same lowercase-only
`p.state === 'merged'` clause, but ALSO already checks both `merged_at` and
`mergedAt` — so it works correctly in practice today (the `mergedAt` clause
catches every real case), just carries a vestigial dead clause. Worth
tidying in the same pass for consistency, since it's the same file, same
bug class, and touching it while already here is cheaper than a separate
epic later — but it is NOT part of #81's actual reported defect and carries
zero live risk either way.

## Fix

Normalize exactly the way `prIsOpen()` already does. Two options considered:

**Option A (what #81 suggests, minimal):** inline-normalize inside
`detectVerifiedDone` only:
```js
const merged = prs.some((pr) => {
  const st = (pr.state || '').toLowerCase();
  return st === 'merged' || pr.mergedAt != null || pr.merged_at != null;
});
```

**Option B (slightly broader):** extract a small shared helper (e.g.
`isPrMerged(pr)`) used by both `detectVerifiedDone` and `detectFalseDone`'s
merged-guard, so the casing-normalization logic exists in exactly one place
rather than being hand-copied a third time. Also tidies the vestigial
lowercase-only clause noted above.

**Recommendation: Option B.** This is the THIRD time this exact casing
class has bitten this file this week (`prIsOpen` already had it right,
`detectFalseDone`'s guard partially duplicated it, now `detectVerifiedDone`
lacks it entirely) — a shared helper closes the pattern instead of leaving
a fourth copy to eventually drift. Small, safe, additive; does not change
either caller's existing behavior for real data, only fixes/clarifies the
casing check itself.

## Open question for the operator

Which option do you want — A (touch only `detectVerifiedDone`, smallest
possible diff, closest to the literal bug report) or B (shared
`isPrMerged()` helper, also tidies the vestigial `detectFalseDone` clause)?
Both are low-risk; B is marginally more code touched for a real
consistency win.

## Verification plan

Full `npm run test:all` before and after. Add regression tests to
`core.test.mjs` for `detectVerifiedDone` with a real gh-shaped PR object
(`state: "MERGED"`, `mergedAt: <ts>`, no `state`/`merged_at` lowercase
fields at all) — the exact shape #81 describes, not a shape that happens to
also satisfy the old broken check.

## Scale

Small — one function (or one shared helper + two call sites), single file,
full existing test coverage to lean on.
