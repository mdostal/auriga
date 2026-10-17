// The one place Auriga's operator-facing surfaces (the MCP server, the
// `auriga` CLI, the Config-Expose API in src/server.mjs) pick a backlog
// adapter (PANT-818). Gods talk only through Pantheon: the default is the
// pantheon-v2-l2 adapter, built the same way auriga-router.mjs builds its
// defaultBacklog. There is deliberately no direct-Multica mode.

import { createPantheonV2L2BacklogAdapter } from './pantheon-v2-l2/index.mjs';
import { createStubBacklogAdapter } from './stub/backlog.mjs';

/**
 * Pantheon's pantheon-v2-l2 backlog adapter by default, built the same way
 * auriga-router.mjs builds its defaultBacklog (base URL from
 * PANTHEON_API_URL, tenant scope from AURIGA_TENANT_ID). Stub via
 * AURIGA_BACKLOG_ADAPTER=stub. Any other value throws: there
 * is no direct-Multica mode.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import('./backlog-adapter.mjs').BacklogAdapter}
 */
export function selectBacklogAdapter(env = process.env) {
  const mode = env.AURIGA_BACKLOG_ADAPTER || 'pantheon-v2-l2';
  if (mode === 'stub') {
    return createStubBacklogAdapter();
  }
  if (mode !== 'pantheon-v2-l2') {
    throw new Error(
      `AURIGA_BACKLOG_ADAPTER="${mode}" is not supported; use "pantheon-v2-l2" (default) or "stub". ` +
      'Auriga reaches the board only through Pantheon core-api.',
    );
  }
  return createPantheonV2L2BacklogAdapter({
    baseUrl: env.PANTHEON_API_URL,
    tenantId: env.AURIGA_TENANT_ID,
  });
}
