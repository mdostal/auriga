// Minimal JSON API over .pHive/ state, via plain node:http — no Express, no
// new runtime dependency. Plain factory function (createServer), no class
// (matches this codebase's zero-`class` convention — see
// src/router/lib/adapters/multica/backlog.mjs's header comment).
//
// Read-only, permanently: exactly 4 GET endpoints, all backed by
// ./lib/read.mjs's pure read functions. Every other method on every route
// (POST/PUT/PATCH/DELETE/etc.) gets 405 — the read-only boundary is enforced
// at the API surface itself, not left as a mere convention someone could
// "helpfully" soften later (see the story's design decision:
// .pHive/epics/p3-auriga-ui/stories/p3-read-layer-and-api.yaml).
//
// Also serves the built frontend (src/ui/'s `vite build` output, src/ui/
// dist/) as static files for every GET path that isn't under /api/* — see
// p3-frontend-scaffold-epics-list.yaml. src/ui/ is a fully isolated
// package (own package.json/build tooling); this server only ever *reads*
// its dist/ output, never imports from src/ui/ or depends on it existing
// (serveStatic degrades to a plain 404 if dist/ hasn't been built yet, so
// `node index.mjs` and the existing API tests keep working either way).

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listEpics, getEpic, getStory, listActivity } from './lib/read.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/server/ -> src/ui/dist — the isolated frontend package's build output.
export const UI_DIST_DIR = path.resolve(__dirname, '..', 'ui', 'dist');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendFile(res, filePath) {
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[path.extname(filePath)] || 'application/octet-stream',
    'Content-Length': body.length,
  });
  res.end(body);
}

/**
 * Serves one GET request from UI_DIST_DIR (src/ui/dist). A path that maps
 * to a real file under dist/ is sent as-is; anything else with no file
 * extension (e.g. a future client-side route like /epics/p2-adapter-
 * interface) falls back to dist/index.html, standard SPA-serving behavior
 * so a hard refresh on a client route doesn't 404. Guards against path
 * traversal escaping UI_DIST_DIR. Returns true if it wrote a response,
 * false if the caller should fall through to its own 404 (e.g. dist/
 * doesn't exist because the frontend hasn't been built yet).
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname decoded-URL-free request path (url.pathname)
 * @returns {boolean}
 */
function serveStatic(res, pathname) {
  const requested = path.normalize(path.join(UI_DIST_DIR, decodeURIComponent(pathname)));
  if (!requested.startsWith(UI_DIST_DIR)) return false;

  try {
    let stat = fs.statSync(requested);
    let filePath = requested;
    if (stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      stat = fs.statSync(filePath);
    }
    sendFile(res, filePath);
    return true;
  } catch (e) {
    if (path.extname(pathname) !== '') return false; // real asset request, genuinely missing
    try {
      sendFile(res, path.join(UI_DIST_DIR, 'index.html'));
      return true;
    } catch (e2) {
      return false; // dist/ not built yet
    }
  }
}

/**
 * Builds the http.Server. Not started here — callers decide when/whether to
 * listen (index.mjs's own __main__ block listens on PORT; tests listen on an
 * ephemeral port).
 * @returns {import('node:http').Server}
 */
export function createServer() {
  return http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch (e) {
      sendJson(res, 400, { error: 'bad request' });
      return;
    }

    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'method not allowed — this API is read-only' });
      return;
    }

    const parts = url.pathname.split('/').filter(Boolean); // e.g. ['api','epics',':id']

    // GET /api/epics
    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'epics') {
      sendJson(res, 200, listEpics());
      return;
    }

    // GET /api/epics/:id
    if (parts.length === 3 && parts[0] === 'api' && parts[1] === 'epics') {
      const epic = getEpic(decodeURIComponent(parts[2]));
      if (!epic) { sendJson(res, 404, { error: 'epic not found' }); return; }
      sendJson(res, 200, epic);
      return;
    }

    // GET /api/epics/:id/stories/:storyId
    if (parts.length === 5 && parts[0] === 'api' && parts[1] === 'epics' && parts[3] === 'stories') {
      const story = getStory(decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
      if (!story) { sendJson(res, 404, { error: 'story not found' }); return; }
      sendJson(res, 200, story);
      return;
    }

    // GET /api/activity
    if (parts.length === 2 && parts[0] === 'api' && parts[1] === 'activity') {
      sendJson(res, 200, listActivity());
      return;
    }

    // Everything else under /api/* is an unknown route — JSON 404, never
    // falls through to static serving.
    if (parts[0] === 'api') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    // Not an /api/* path: serve the built frontend from src/ui/dist.
    if (serveStatic(res, url.pathname)) return;

    sendJson(res, 404, { error: 'not found' });
  });
}

// Only listen when invoked directly (`node src/server/index.mjs`), not when
// createServer is imported for tests. `AURIGA_PHIVE_ROOT` (read by
// ./lib/read.mjs's DEFAULT_PHIVE_ROOT) optionally points this whole process
// at a different .pHive/ root — used by src/ui's hardening Playwright
// scenarios to boot a real server against a real empty/malformed temp
// fixture; unset in normal use, defaults to this repo's real .pHive/.
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.PORT) || 8787;
  const server = createServer();
  server.listen(PORT, () => {
    process.stdout.write(`[auriga-server] listening on http://localhost:${PORT}\n`);
  });
}
