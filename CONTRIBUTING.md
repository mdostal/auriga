# Contributing to Auriga

Auriga is the router god of [Pantheon](https://github.com/mdostal/pantheon-v2) — thanks for
considering a contribution. This doc is the practical path from idea to merged PR.

## Ground rules

- **`dev` is the integration branch.** All PRs target `dev`, never `main`/`master` directly.
  A bot opens the `dev` → default-branch promotion PR once `dev` is ahead.
- **The router's decision core stays pure.** Anything in `src/router/lib/core.mjs` (and its
  sibling pure-logic modules) must stay side-effect-free and unit-testable against mocked board
  state — no direct Multica/network calls from decision logic.
- **Safety invariant:** the router only ever *assigns* and *re-runs* work; it never deletes or
  cancels issues, runs, or PRs. Contributions must preserve that invariant.
- **CI is the gate.** `.github/workflows/ci.yml` auto-detects the stack and runs install + build
  + test on every PR into `dev`. Keep `npm test` (and `npm run build`) green.

## Getting started

```sh
git clone git@github.com:mdostal/auriga.git
cd auriga
npm install
npm test              # root suite: src/router/test/*.test.mjs

cd src/router
npm test              # router unit + e2e-loop suite
npm run dry            # one cycle, log-only, no board writes
```

See the [README](README.md) for the full architecture and the [docs/](docs/) directory for
deeper design notes.

## Making a change

1. Open or find a Multica ticket describing the change (routing rule, capacity policy, state
   transition, docs, etc.).
2. Branch off `dev`.
3. Add or update unit tests alongside the change — `src/router/test/core.test.mjs` for decision
   logic, `src/router/test/router-cycle.e2e.test.mjs` for loop-level behavior.
4. Run the full test suite locally before opening a PR.
5. Open a PR into `dev` with a clear description of the routing/behavior change and why.

## Good first contributions

See the **Good first contributions** section of [VISION.md](docs/VISION.md) — it's kept current
with concrete, scoped entry points (new routing unit tests, sharpening `isHiveStory` detection,
a read-only board adapter sketch, and more).

## Reporting bugs / proposing changes

Open a GitHub issue with reproduction steps (or, for routing-decision bugs, the mocked board
state that produces the wrong decision) and the expected vs. actual behavior.

## Code of conduct

Be respectful and constructive. This is a small, focused project — assume good faith and keep
discussion scoped to the technical merits of the change.
