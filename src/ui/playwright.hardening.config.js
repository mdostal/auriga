import { defineConfig } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Real end-to-end config for p3-dashboard-hardening's edge cases: no mocks,
// no stubbed read layer — this boots the REAL src/server/index.mjs (which
// itself calls the REAL src/server/lib/read.mjs) but points it, via the
// AURIGA_PHIVE_ROOT env var (see lib/read.mjs's DEFAULT_PHIVE_ROOT), at real
// throwaway .pHive/ fixture directories built on disk below instead of this
// repo's own .pHive/. Two separate server processes/ports are used because
// the two scenarios need genuinely different root shapes (one with literally
// zero epics; one with epics present but edge-case-shaped) — see EMPTY_ROOT /
// MIXED_ROOT.
//
// Separate from playwright.config.js (which drives this repo's REAL .pHive/
// data) on purpose: that config's webServer intentionally can't be repointed
// without risking the real-data assertions in epics-list/story-detail/
// activity specs, so hardening gets its own config + its own npm script
// (`npm run test:e2e:hardening`) instead of overloading the default one.

const EMPTY_PORT = process.env.AURIGA_E2E_EMPTY_PORT || '8797'
const MIXED_PORT = process.env.AURIGA_E2E_MIXED_PORT || '8796'

const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'auriga-hardening-e2e-'))

// ---------------------------------------------------------------------------
// Scenario A: a freshly-initialized .pHive/ — epics/ exists but is EMPTY.
// Acceptance criterion: "Given .pHive/epics/ is empty, when the dashboard
// loads, then EpicsListView shows an explicit empty state, not a blank page
// or error."
// ---------------------------------------------------------------------------
export const EMPTY_ROOT = path.join(fixtureRoot, 'empty-phive')
fs.mkdirSync(path.join(EMPTY_ROOT, 'epics'), { recursive: true })

// ---------------------------------------------------------------------------
// Scenario B: a mix of edge-case epics/stories, real files on disk:
//   - zero-story-epic: valid epic.yaml, no stories/ dir at all (zero stories)
//   - minimal-story-epic: valid epic.yaml + one story YAML missing every
//     optional field (no cross_cutting, no risks, no references, no
//     acceptance_criteria) — only id/title/status/epic are present
//   - broken-epic: genuinely malformed epic.yaml (missing required `name`)
//     sitting alongside the two valid epics above, proving the malformed-
//     YAML acceptance criterion end-to-end: API layer through to a rendered
//     UI state that still shows the valid epics, not a blank/broken page
// ---------------------------------------------------------------------------
export const MIXED_ROOT = path.join(fixtureRoot, 'mixed-phive')

const zeroStoryEpicDir = path.join(MIXED_ROOT, 'epics', 'zero-story-epic')
fs.mkdirSync(zeroStoryEpicDir, { recursive: true })
fs.writeFileSync(
  path.join(zeroStoryEpicDir, 'epic.yaml'),
  'name: zero-story-epic\ntitle: Zero Story Epic\n',
)

const minimalEpicDir = path.join(MIXED_ROOT, 'epics', 'minimal-story-epic')
const minimalStoriesDir = path.join(minimalEpicDir, 'stories')
fs.mkdirSync(minimalStoriesDir, { recursive: true })
fs.writeFileSync(
  path.join(minimalEpicDir, 'epic.yaml'),
  'name: minimal-story-epic\ntitle: Minimal Story Epic\n',
)
fs.writeFileSync(
  path.join(minimalStoriesDir, 'minimal-story.yaml'),
  'id: minimal-story\nepic: minimal-story-epic\ntitle: A minimal story\nstatus: pending\n',
)

const brokenEpicDir = path.join(MIXED_ROOT, 'epics', 'broken-epic')
fs.mkdirSync(brokenEpicDir, { recursive: true })
// Missing the required 'name' field — readEpicYaml() throws, listEpics()
// skips it with a stderr log rather than aborting the whole listing.
fs.writeFileSync(
  path.join(brokenEpicDir, 'epic.yaml'),
  'title: This epic has no name field\n',
)

export default defineConfig({
  testDir: './tests/e2e/hardening',
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  webServer: [
    {
      command: 'node ../server/index.mjs',
      url: `http://localhost:${EMPTY_PORT}/api/epics`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: { PORT: EMPTY_PORT, AURIGA_PHIVE_ROOT: EMPTY_ROOT },
    },
    {
      command: 'node ../server/index.mjs',
      url: `http://localhost:${MIXED_PORT}/api/epics`,
      reuseExistingServer: false,
      timeout: 15_000,
      env: { PORT: MIXED_PORT, AURIGA_PHIVE_ROOT: MIXED_ROOT },
    },
  ],
  projects: [
    {
      name: 'empty-phive',
      testMatch: /empty-phive\.spec\.js/,
      use: { baseURL: `http://localhost:${EMPTY_PORT}` },
    },
    {
      name: 'mixed-phive',
      testMatch: /mixed-phive\.spec\.js/,
      use: { baseURL: `http://localhost:${MIXED_PORT}` },
    },
  ],
})
