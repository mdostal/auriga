// In-memory stub implementation of MemoryAdapter (see ../memory-adapter.mjs).
// Plain factory function, no class — matches this codebase's zero-`class`
// convention. Methods stay Promise-returning (matching the real contract's
// async shape — see memory-adapter.mjs's header comment for why MemoryAdapter
// is deliberately async, unlike BacklogAdapter/SpawnAdapter) even though an
// in-memory Map has nothing to actually await.
//
// createStubMemoryAdapter(seedData) seeds an in-memory store keyed by scope
// from seedData.byScope: { [scope]: { text, tag }[] }. remember() appends to
// that same scope's list (mutate-in-place, so a test can observe writes
// across a single pass — same convention as stub/backlog.mjs). recall() does
// a simple case-insensitive substring match against stored text, ranked by
// nothing more than insertion order — this is a test double, not a real
// semantic-search engine.

/**
 * @param {{ byScope?: Record<string, { text: string, tag?: string }[]> }} [seedData]
 * @returns {import('../memory-adapter.mjs').MemoryAdapter}
 */
export function createStubMemoryAdapter(seedData = {}) {
  const byScope = new Map();
  for (const [scope, entries] of Object.entries(seedData.byScope || {})) {
    byScope.set(scope, [...entries]);
  }

  async function recall(query, scope, opts = {}) {
    const hits = opts.hits || 5;
    const needle = String(query || '').toLowerCase();
    const entries = byScope.get(scope) || [];
    const matched = needle
      ? entries.filter((e) => String(e.text || '').toLowerCase().includes(needle))
      : entries;
    return {
      total_hits: matched.length,
      scopes: [{ scope, hits: matched.slice(0, hits) }],
      via: 'stub',
    };
  }

  async function remember(text, scope, opts = {}) {
    if (!byScope.has(scope)) byScope.set(scope, []);
    byScope.get(scope).push({ text, tag: opts.tag || 'note' });
    return { remembered: true, via: 'stub' };
  }

  return Object.freeze({ recall, remember });
}
