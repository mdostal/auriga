import { defineConfig } from '@playwright/test'

// e2e config for the real, built dashboard: builds src/ui (`vite build`),
// then boots the real src/server/index.mjs (which serves that dist/ output
// as static files per this story) on a dedicated port, and points tests at
// it. No mocks — this proves the whole thing works as one server, wired to
// this repo's actual .pHive/ state.
const PORT = process.env.AURIGA_E2E_PORT || '8799'

export default defineConfig({
  testDir: './tests/e2e',
  // The hardening/ subdir has its own dedicated config
  // (playwright.hardening.config.js, run via `npm run test:e2e:hardening`)
  // that boots real servers pointed at real empty/malformed temp .pHive/
  // fixtures instead of this repo's own — exclude it here so it isn't
  // picked up (and run against the WRONG, real-data server) by this
  // config's recursive default testDir glob.
  testIgnore: '**/hardening/**',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
  },
  webServer: {
    command: `node ../server/index.mjs`,
    url: `http://localhost:${PORT}/api/epics`,
    reuseExistingServer: false,
    timeout: 15_000,
    env: { PORT },
  },
})
