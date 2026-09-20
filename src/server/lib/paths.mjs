// Shared path-containment guard. Used by both the static file server
// (index.mjs's serveStatic, guarding UI_DIST_DIR) and the read layer's
// id/storyId resolution (read.mjs's getEpic/getStory, guarding
// .pHive/epics/). One place to get "is this resolved path still inside its
// expected root" right, after an independent review found the static
// server's own inline check — a bare `resolved.startsWith(root)` — is
// bypassable: a sibling directory that merely shares `root`'s name as a
// string prefix (e.g. `dist-evil/` next to `dist/`) passes a naive prefix
// check even though it's a completely different directory. Comparing with
// `path.resolve()` plus a trailing-separator-aware prefix (or exact
// equality) closes that gap.

import path from 'node:path';

/**
 * True if `candidate` — once both are resolved to absolute, normalized
 * paths — IS `root`, or is a real descendant of it. False for anything
 * that only shares `root`'s string prefix without a path-separator
 * boundary (e.g. root=".../dist", candidate=".../dist-evil/x" is NOT
 * contained), and false for any ".."-style escape.
 * @param {string} candidate
 * @param {string} root
 * @returns {boolean}
 */
export function isPathContained(candidate, root) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(resolvedRoot + path.sep)
  );
}
