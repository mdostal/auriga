#!/usr/bin/env node
// Auriga Config-Expose API — read-only REST surface over the router's config,
// live lane state, and computed gaps. Data layer for the Janus UI and the
// Cura sync-check. Phase 1 (MVP): GET-only. Phase 2 (PATCH /api/config,
// POST /api/config/reload) is deferred.
//
// Board data comes ONLY through Pantheon core-api (PANT-818): the same
// backlog adapter the MCP server and the router use (pantheon-v2-l2 by
// default, AURIGA_BACKLOG_ADAPTER=stub for tests). No direct Multica CLI or
// GitHub call anywhere on this surface.
import express from 'express';
import * as cfg from './router/lib/config.mjs';
import * as core from './router/lib/core.mjs';
import { selectBacklogAdapter } from './router/lib/adapters/select-backlog.mjs';
import { createConfigRouter } from './api/config.mjs';
import { createLanesRouter } from './api/lanes.mjs';
import { createGapsRouter } from './api/gaps.mjs';

export function createApp(opts = {}) {
  const app = express();
  const backlog = opts.backlog || selectBacklogAdapter(opts.env || process.env);

  // Janus UI runs on a separate origin; this is a read-only API so an open
  // CORS policy is fine, but allow pinning it down via env if that changes.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.AURIGA_API_CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true }));
  app.use(createConfigRouter(cfg));
  app.use(createLanesRouter(cfg, backlog, core));
  app.use(createGapsRouter(cfg, backlog, core));

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = parseInt(process.env.AURIGA_API_PORT || '4000', 10);
  createApp().listen(port, () => {
    console.log(`[auriga-api] listening on :${port}`);
  });
}
