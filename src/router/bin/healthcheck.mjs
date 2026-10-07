#!/usr/bin/env node
// Container HEALTHCHECK for the router (PANT-817). Exits 0 when the heartbeat
// file was rewritten recently, 1 when it is missing or stale — i.e. the
// router has not finished a cycle in too long (wedged, or dead).
//
//   AURIGA_HEARTBEAT_FILE    heartbeat path (default: next to AURIGA_PIDFILE)
//   AURIGA_HEALTH_MAX_AGE_MS max heartbeat age (default: 3 x AURIGA_CYCLE_MS,
//                            where AURIGA_CYCLE_MS defaults to CAPS.cycleMs)
//
// Deliberately does not import lib/config.mjs (which loads AURIGA_CONFIG):
// a healthcheck must stay cheap and must not fail on unrelated config.

import { checkHeartbeat, defaultHeartbeatFile } from '../lib/observability.mjs';

// Mirrors lib/config.mjs CAPS.cycleMs; the router honours AURIGA_CYCLE_MS the same way.
const DEFAULT_CYCLE_MS = 75000;

const cycleMs = parseInt(process.env.AURIGA_CYCLE_MS, 10) || DEFAULT_CYCLE_MS;
const maxAgeMs = parseInt(process.env.AURIGA_HEALTH_MAX_AGE_MS, 10) || 3 * cycleMs;
const file = defaultHeartbeatFile(process.env);

const res = checkHeartbeat(file, maxAgeMs);
console.log(`[auriga-healthcheck] ${res.ok ? 'ok' : 'unhealthy'}: ${res.reason}`);
process.exit(res.ok ? 0 : 1);
