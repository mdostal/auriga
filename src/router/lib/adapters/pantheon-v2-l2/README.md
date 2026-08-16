# pantheon-v2-l2

This is the **ONLY sanctioned path from Auriga to Pantheon**. Auriga must
never call Minerva, Consus, or any other Pantheon-side system directly — if a
future story needs Auriga to talk to Pantheon, it talks through this adapter,
not around it.

`index.mjs` exports `createPantheonV2L2BacklogAdapter()` and
`createPantheonV2L2SpawnAdapter()`, implementing the `BacklogAdapter` (see
`../backlog-adapter.mjs`) and `SpawnAdapter` (see `../spawn-adapter.mjs`)
shapes exactly like every other adapter in this directory — plain factory
functions, no class, frozen object literals.

## Intentionally unbuilt

Every method on both adapters **throws** an error shaped
`{ name: 'NotImplementedError', message: '...' }` referencing this file. That
is not a placeholder waiting to be filled in as a side effect of some other
story — it is this epic's deliberate final state. `p2-adapter-interface`
proves the adapter *boundary* (backlog/spawn interfaces, a real Multica-backed
implementation, and this stub); it does not build a real Pantheon
integration, and was never meant to.

Building the real implementation — actually wiring `dispatch`, `listIssues`,
and the rest to whatever Pantheon's L2 surface turns out to be — is
**Pantheon's own future, separate epic**, not Auriga's job. Auriga stays
agnostic of every specific external system it routes to or is routed by; see
`.pHive/CONTEXT.md`'s adapter-boundary-integrity principle and
`.pHive/cross-cutting-concerns.yaml`. Naming or assuming Pantheon-specific
shapes inside Auriga's core (`lib/core.mjs`) or `auriga-router.mjs` would
violate that boundary just as surely as a half-built implementation here
would.

A stub that fails loudly is safer than one that looks like it's working: if
this adapter is ever wired in as though it were real, every call fails
immediately and visibly, instead of quietly doing nothing (or something
wrong) while looking like a working integration. Do not "improve" these
methods to return empty/success values to make a caller stop erroring — that
would recreate exactly the silent-half-integration failure mode this stub
exists to prevent.

Any change to this directory that adds real (non-throwing) behavior without
first updating this statement is a signal to escalate, per the
`adapter-boundary-integrity` cross-cutting concern.
