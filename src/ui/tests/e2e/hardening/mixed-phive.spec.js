import { test, expect } from '@playwright/test'

// Real end-to-end checks, no mocks: playwright.hardening.config.js's
// webServer boots the actual src/server/index.mjs with AURIGA_PHIVE_ROOT
// pointed at a real temp .pHive/ containing three real fixture epics:
//   - broken-epic         genuinely malformed epic.yaml (no `name` field)
//   - zero-story-epic     valid, but has zero stories
//   - minimal-story-epic  valid, one story missing every optional field
// This proves the malformed-YAML graceful-degradation acceptance criterion
// end-to-end (API layer through to a rendered UI state) and the zero-story /
// missing-optional-field acceptance criteria, all against real files on
// disk read by the real read layer — not fixture data injected into the UI.

test('epics list renders valid epics and silently skips a malformed epic.yaml — no blank page, no crash', async ({ page }) => {
  const apiRes = await page.request.get('/api/epics')
  expect(apiRes.status()).toBe(200)
  const epics = await apiRes.json()
  const ids = epics.map((e) => e.id)
  expect(ids).toContain('zero-story-epic')
  expect(ids).toContain('minimal-story-epic')
  expect(ids).not.toContain('broken-epic') // skipped by listEpics(), per read.mjs

  await page.goto('/')

  const table = page.getByRole('table')
  await expect(table).toBeVisible()
  await expect(page.locator('body')).toContainText('zero-story-epic')
  await expect(page.locator('body')).toContainText('minimal-story-epic')
  await expect(page.locator('body')).not.toContainText('broken-epic')
  await expect(page.locator('body')).not.toContainText('undefined')
  await expect(page.getByRole('alert')).toHaveCount(0) // graceful skip, not surfaced as an error
})

test('an epic with zero stories shows an explicit empty state for the stories list', async ({ page }) => {
  await page.goto('/')

  const row = page.getByRole('row', { name: /zero-story-epic/ })
  await expect(row).toBeVisible()
  await row.click()

  await expect(page.getByText('No stories found for this epic.')).toBeVisible()
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('undefined')
})

test('a story missing every optional field renders "None"/omits sections rather than undefined or broken output', async ({ page }) => {
  await page.goto('/')

  const epicRow = page.getByRole('row', { name: /minimal-story-epic/ })
  await expect(epicRow).toBeVisible()
  await epicRow.click()

  const storyRow = page.getByRole('row', { name: /minimal-story/ })
  await expect(storyRow).toBeVisible()
  await storyRow.click()

  // Sections that guard on Array.isArray(...) && length > 0 render "None"
  // for the required-but-empty-shaped ones (Dependencies, Acceptance
  // Criteria, Cross-Cutting all always render); purely-optional sections
  // (Risks, References) are omitted entirely rather than showing anything.
  await expect(page.getByRole('heading', { name: 'Cross-Cutting' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Dependencies' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Acceptance Criteria' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Risks' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'References' })).toHaveCount(0)

  const body = page.locator('body')
  await expect(body).toContainText('None')
  await expect(body).not.toContainText('undefined')
  await expect(body).not.toContainText('[object Object]')
})
