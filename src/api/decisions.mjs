// GET /api/decisions?since=<iso>&limit=<n> — the router's decision records
// (`decision`, `verify_ok`, `advance`, `zombie`, `review`, `scan`), oldest
// first, for Janus Insights via core-api's /api/auriga/decisions (PANT-1024).
// Reads only the JSONL file the router appends to at AURIGA_RECORDS_FILE (a
// volume shared between the two containers); never Multica. With `since` it
// returns the first `limit` records after it, so callers page forward by the
// last `ts` they saw; without it, the newest `limit`.
import express from 'express';
import { readRecords } from '../router/lib/observability.mjs';

export const DEFAULT_DECISIONS_LIMIT = 2000;
export const MAX_DECISIONS_LIMIT = 10000;

export function createDecisionsRouter(opts = {}) {
  const env = opts.env || process.env;
  const file = opts.recordsFile ?? env.AURIGA_RECORDS_FILE ?? null;
  const router = express.Router();

  router.get('/api/decisions', (req, res) => {
    const { since } = req.query;
    if (since !== undefined && !Number.isFinite(new Date(since).getTime())) {
      return res.status(400).json({ error: `since must be an ISO timestamp, got ${JSON.stringify(since)}` });
    }
    let limit = DEFAULT_DECISIONS_LIMIT;
    if (req.query.limit !== undefined) {
      limit = parseInt(req.query.limit, 10);
      if (!(limit > 0)) return res.status(400).json({ error: 'limit must be a positive integer' });
      limit = Math.min(limit, MAX_DECISIONS_LIMIT);
    }
    if (!file) {
      return res.json({ records: [], unavailable: 'AURIGA_RECORDS_FILE is not set on auriga-api' });
    }
    try {
      res.json({ records: readRecords(file, { since: since || null, limit }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
