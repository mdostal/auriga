// Shared synchronous-HTTP-via-curl helper for pantheon-v2-l2's two adapters.
// BacklogAdapter/SpawnAdapter's contract is SYNCHRONOUS (see ../backlog-
// adapter.mjs / ../spawn-adapter.mjs header comments) -- the same real
// constraint the multica/ adapters solved via execFileSync against the
// `multica` CLI binary. This module solves it the identical way, just
// against `curl` calling Pantheon's own backlog API instead of a
// Multica-specific binary -- curl ships in essentially every Linux base
// image (Dockerfile.auriga installs it explicitly via `apk add curl`),
// unlike the `multica` CLI, which is a native macOS binary this container
// could never run at all (the root problem this epic exists to fix).
//
// execFileSync is INJECTED here (never imported directly by this module),
// matching cli-runner.mjs's own established convention -- see that file's
// header comment for why: node:test's per-test module-mocking needs a
// fresh binding each test, which only works if the caller (index.mjs) owns
// its own cache-busted import of execFileSync and hands it in.

const DEFAULT_TIMEOUT_SECONDS = 10;

/**
 * @param {(cmd: string, args: string[], opts: object) => string} execFileSync
 *   Injected rather than imported by this module — see file header comment.
 * @param {string} baseUrl Pantheon's backlog API base URL (no trailing slash).
 * @returns {(method: string, path: string, body?: object) => any}
 *   Returns the parsed JSON response body, or `null` for an empty body.
 *   Throws on any transport failure or non-2xx response.
 */
export function makeHttpRun(execFileSync, baseUrl) {
  return function httpRun(method, path, body) {
    const url = `${baseUrl}${path}`;
    const args = [
      '-sS',
      '--max-time', String(DEFAULT_TIMEOUT_SECONDS),
      '-X', method,
      url,
      '-H', 'content-type: application/json',
      // Appends the HTTP status code as its own trailing line so this
      // synchronous, no-headers-API call can distinguish success from
      // failure without a second round trip.
      '-w', '\n%{http_code}',
    ];
    if (body !== undefined) {
      args.push('-d', JSON.stringify(body));
    }

    const out = execFileSync('curl', args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const splitIdx = out.lastIndexOf('\n');
    const bodyText = splitIdx === -1 ? '' : out.slice(0, splitIdx);
    const statusText = splitIdx === -1 ? out : out.slice(splitIdx + 1);
    const status = Number(statusText);

    if (!(status >= 200 && status < 300)) {
      throw new Error(`Pantheon backlog API ${method} ${path} failed: HTTP ${status} ${bodyText}`.trim());
    }

    return bodyText.trim() ? JSON.parse(bodyText) : null;
  };
}
