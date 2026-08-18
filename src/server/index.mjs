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

import http from 'node:http';
import { listEpics, getEpic, getStory, listActivity } from './lib/read.mjs';

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
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

    sendJson(res, 404, { error: 'not found' });
  });
}

// Only listen when invoked directly (`node src/server/index.mjs`), not when
// createServer is imported for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const PORT = Number(process.env.PORT) || 8787;
  const server = createServer();
  server.listen(PORT, () => {
    process.stdout.write(`[auriga-server] listening on http://localhost:${PORT}\n`);
  });
}
