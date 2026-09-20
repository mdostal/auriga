// MemoryAdapter — the read/write contract for whatever system holds Auriga's
// context/knowledge (prior decisions, incident notes, project-scoped facts).
// This file defines ONLY the shape, via a JSDoc @typedef; it has no runtime
// code and is never imported for its exports. Concrete implementations are
// plain factory-function modules (createXMemoryAdapter(cfg)) returning a
// frozen object literal — never an ES6 class, matching BacklogAdapter/
// SpawnAdapter's own convention (see ./README.md).
//
// A THIRD adapter, alongside BacklogAdapter/SpawnAdapter — memory is a
// genuinely different concern (context/knowledge, not work items or
// execution) with its own real provider (Mnemosyne) and its own failure
// mode (a memory miss must never break a ticket). See
// ./mnemosyne/memory.mjs's own header comment for why the real
// implementation talks to Mnemosyne DIRECTLY for now rather than through a
// Pantheon proxy (no such proxy route exists yet, mirroring
// multica/backlog.mjs's own pre-pantheon-v2-l2 history) and for the
// operator's own framing: Auriga's core state-machine doesn't need to know
// Mnemosyne's specific shape any more than it needs to know GitHub's or
// Multica's — MemoryAdapter is the same kind of provider-agnostic boundary
// as the other two.
//
// DELIBERATELY ASYNC, unlike BacklogAdapter/SpawnAdapter. Those two are
// synchronous because auriga-router.mjs's cycle() calls them across ~25
// sites and never awaits (see ./README.md's "Synchronous, deliberately"
// section) — a real, deliberate constraint tied to THAT specific consumer.
// MemoryAdapter has no such consumer yet: this epic wires it only into
// `auriga memory recall/remember` (bin/auriga.mjs's `main()`, already
// async), not into cycle()'s decision loop. Mnemosyne's own real transport
// (recall/remember over HTTP, see mnemo-client.mjs in the mnemosyne repo)
// is genuinely asynchronous, and forcing a synchronous shape here with no
// real synchronous consumer to justify it would be exactly the kind of
// premature interface-shaping ./README.md's "Synchronous, deliberately"
// section warns against doing to the OTHER two adapters. If/when a future
// story wires memory into cycle()'s own synchronous decision loop, that is
// the point to revisit this — not before.

/**
 * @typedef {Object} MemoryAdapter
 *
 * @property {(query: string, scope: string, opts?: { hits?: number }) => Promise<{ total_hits: number, scopes: object[], via: string }>} recall
 *   Semantic recall: the best-matching remembered facts for `query`, scoped
 *   to `scope` (e.g. a tenant id, a project id — whatever grouping the real
 *   provider uses to keep one context's memory from bleeding into
 *   another's). `via` names which real path served the result
 *   (implementation-specific, e.g. "service"/"cli"/"none") so a caller can
 *   tell a genuine miss from a degraded-but-still-real answer.
 *
 * @property {(text: string, scope: string, opts?: { tag?: string }) => Promise<{ remembered: boolean, via: string }>} remember
 *   Write-back: store `text` under `scope` for later recall. `remembered:
 *   false` means the write did not land anywhere (never throws) — a
 *   memory-write failure must never break the caller's own real work.
 */

export {};
