// GET /api/config — full router config snapshot (PROJECT_IDS, AGENTS, lane
// mappings, caps). Read-only; no secrets live in lib/config.mjs so nothing
// needs redaction before serializing.
import express from 'express';

export function createConfigRouter(cfg) {
  const router = express.Router();

  router.get('/api/config', (req, res) => {
    res.json({
      PROJECT_IDS: cfg.PROJECT_IDS,
      PROJECT_NAMES: cfg.PROJECT_NAMES,
      AGENTS: cfg.AGENTS,
      RUNTIME_CAP: cfg.RUNTIME_CAP,
      PROJECT_LANE: cfg.PROJECT_LANE,
      DEFAULT_LANE: cfg.DEFAULT_LANE,
      TREE_AGENT_ATTACHMENTS: cfg.TREE_AGENT_ATTACHMENTS,
      HUMAN_NAMES: cfg.HUMAN_NAMES,
      CAPS: cfg.CAPS,
    });
  });

  return router;
}
