import { test, expect } from '@playwright/test'

// Real end-to-end check, no mocks: playwright.hardening.config.js's
// webServer boots the actual src/server/index.mjs with AURIGA_PHIVE_ROOT
// pointed at a real, empty temp .pHive/ (epics/ dir exists, zero epics
// inside it) — proving the freshly-initialized-repo case renders an
// explicit empty state instead of a blank page or an error, all the way
// from the real API through the real rendered UI.

test('freshly-initialized .pHive/ (zero epics) shows an explicit empty state, not a blank page or error', async ({ page }) => {
  const apiRes = await page.request.get('/api/epics')
  expect(apiRes.status()).toBe(200)
  expect(await apiRes.json()).toEqual([])

  await page.goto('/')

  await expect(page.getByText('Live epic list from this repo')).toBeVisible() // CardDescription — proves the card itself rendered
  await expect(page.getByText('No epics found.')).toBeVisible()

  // No table at all (nothing to render), and definitely no broken output.
  await expect(page.getByRole('table')).toHaveCount(0)
  await expect(page.locator('body')).not.toContainText('undefined')
  await expect(page.locator('body')).not.toContainText('NaN')
  await expect(page.getByRole('alert')).toHaveCount(0) // no error state either
})
