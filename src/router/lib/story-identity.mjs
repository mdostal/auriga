// Story-key + slug matching and description-parsed identity/dependency
// helpers — extracted from core.mjs (t011 decomposition) as a fully
// self-contained leaf module: zero dependencies on any other core.mjs
// function. Background (2026-07-31, loop-integrity fixes): Minerva-planned
// stories carry a short epic-scoped key in their Multica title, e.g.
// "[m-02-file-layer-implementation] ..." and their build agents name PR
// branches after the SAME key ("feat/m-01-service", "feat/PAN-6952", etc.)
// — NOT always after the PAN-#### ticket id. cron-maker worked because its
// branches happened to embed the pan-#### id; mnemosyne#1
// (feat/m-01-service) does not, so its PR never matched its ticket and sat
// forever. storyKey() extracts that short key so a PR can be matched to
// its ticket even when the branch has no PAN id.

// Unified story-key extractor. A story key identifies a story within its
// epic and appears at the START of the story's title bracket
// ("[<key>-<words>]") and at the start of a dependency SLUG
// ("<key>-<words>"). The short-key convention is strictly
// <letters>-<digits>, e.g. m-02, cm-07, htq-01, flayr-01, jfpm-01, mit-04,
// v-04, lct-03. Epic-tag slugs such as "p1-router-capability-routing" are
// exact story ids, not short keys: treating every p1-* sibling as key "p1"
// collapses unrelated stories onto one key and can false-unblock
// dependents. The trailing (?![0-9]) forces the FULL number to be
// captured, so a longer-numbered key can never be read as a shorter one —
// ct-010 never collapses to ct-01. Downstream comparison is EXACT string
// equality (storyKey === slugKey), so correct full-key extraction is
// exactly what rejects false-prefix cross-matches.
function extractStoryKey(str = '') {
  const m = String(str).match(/^\s*\[?\s*([a-z]{1,8}-\d{1,3})(?![0-9])/i);
  return m ? m[1].toLowerCase() : null;
}

// Short epic-scoped key from a story TITLE's leading "[key-...]" bracket
// (e.g. "m-02", "cm-07", "hf-01"). null when the title has no parseable
// leading key.
export function storyKey(issue = {}) {
  return extractStoryKey(issue.title || '');
}

// Short key from a dependency SLUG (e.g. "m-01-core-recall-interface" ->
// "m-01", "cm-07-e2e-integration" -> "cm-07"). null when unparseable.
export function slugKey(slug = '') {
  return extractStoryKey(slug);
}

// Known plugin-hive PHASE tokens that appear inside a story's `steps:`
// block as `depends_on: [research]` etc. These are workflow phases, NOT
// story dependencies, and must be excluded when parsing a story's real
// cross-story dependency list.
const HIVE_PHASE_TOKENS = new Set([
  'research', 'implement', 'implementation', 'test', 'test-spec', 'tests',
  'review', 'plan', 'design', 'integrate', 'integration', 'spec', 'build',
]);

// Story-level dependency slugs declared in the DESCRIPTION (not metadata).
// Minerva emits the story's own dependencies as the FIRST `depends_on: [...]`
// line in the YAML front-matter (before the `steps:` block). Older stories carry
// this ONLY in the description, never mirrored into metadata.depends_on — so
// detectUnblocks/depsSatisfied (which read metadata only) never saw them and the
// child never unblocked (the m-02-depends-on-m-01 case). We read the FIRST
// depends_on line and drop any hive PHASE tokens defensively.
// Minerva emits a story's own dependency slugs in the description in TWO shapes, and
// BOTH must parse — else a real dependency is silently dropped and the story
// false-unblocks (the rsh-03/PAN-5830 case: a block-list dep on rsh-01 was missed, so
// the story looked dependency-free and was eligible to unblock while rsh-01 was still
// stuck). Forms:
//   1. inline array   ->  depends_on: [a-01-foo, b-02-bar]
//   2. YAML block list ->  depends_on:\n  - a-01-foo\n  - b-02-bar
// We drop any plugin-hive PHASE tokens (research/implement/test/...) defensively.
export function descStoryDeps(issue = {}) {
  const desc = issue.description || '';
  // Match the FIRST `depends_on:` in the description and capture EITHER an inline
  // [array] OR a block list — in one regex so the earliest occurrence wins. This
  // matters because a Minerva story's `steps:` block further down carries per-phase
  // `depends_on: [research]` lines; parsing inline-anywhere-first would grab a phase
  // dep and shadow the real story dep declared at the top (the rsh-03/PAN-5830 bug).
  const m = desc.match(/(^|\n)[ \t]*depends_on:[ \t]*(\[[^\]]*\]|\r?\n(?:[ \t]*-[ \t]*[^\n]+\r?\n?)+)/i);
  let raw = [];
  if (m) {
    const body = m[2];
    if (body.trimStart().startsWith('[')) {
      raw = body.trim().replace(/^\[|\]$/g, '').split(',');
    } else {
      raw = body.split(/\r?\n/).map((l) => l.replace(/^[ \t]*-[ \t]*/, ''));
    }
  }
  return raw
    .map((s) => s.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
    .filter((s) => !HIVE_PHASE_TOKENS.has(s.toLowerCase()));
}

// A story's own declared id, from the Minerva YAML front-matter `id: <slug>` line
// (e.g. "id: p1-router-capability-routing"). Some epics (the "p1-..." convention)
// use this full descriptive slug as BOTH the story's identity and the value every
// sibling's depends_on: [...] names — there is no separate short "prefix-NN" key
// to extract (storyKey/slugKey return null for "p1-router-capability-routing",
// since the epic tag "p1" mixes a letter and a digit before the first hyphen,
// which the [a-z]{1,8}-\d{1,3} pattern above doesn't match). Falling through
// descDepsSatisfied's short-key lookup for this convention silently treated
// EVERY dep as unresolved -> vacuously satisfied, so a story never actually
// waited on its declared deps (PAN-6664 loop-integrity bug, 2026-07-31).
export function descStoryId(issue = {}) {
  const desc = issue.description || '';
  const m = desc.match(/(^|\n)\s*id:\s*([a-z0-9][a-z0-9_-]*)/i);
  return m ? m[2].trim().toLowerCase() : null;
}
