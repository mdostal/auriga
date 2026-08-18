import { test, expect } from '@playwright/test'

// Real end-to-end check, no mocks: playwright.config.js's webServer boots
// the actual src/server/index.mjs (serving src/ui's real built dist/), and
// this test navigates a real browser to it and asserts real epic data from
// THIS repo's .pHive/epics/ — not fixture/mock data (per this story's
// acceptance criteria).

test('dashboard renders this repo\'s real epics with accurate story counts', async ({ page }) => {
  await page.goto('/')

  const table = page.getByRole('table')
  await expect(table).toBeVisible()

  // p1-dispatch-throughput: 11 stories, all pending -> epic status "pending".
  const p1Row = page.getByRole('row', { name: /p1-dispatch-throughput/ })
  await expect(p1Row).toContainText('P1: Convert Dispatch Throughput to DONE Throughput')
  await expect(p1Row).toContainText('pending')
  await expect(p1Row).toContainText('11')

  // p2-adapter-interface: 5 stories, all done -> epic status "done".
  const p2Row = page.getByRole('row', { name: /p2-adapter-interface/ })
  await expect(p2Row).toContainText('P2: Adapter-Interface Extraction')
  await expect(p2Row).toContainText('done')
  await expect(p2Row).toContainText('5')

  // p3-auriga-ui: the epic this very story belongs to.
  const p3Row = page.getByRole('row', { name: /p3-auriga-ui/ })
  await expect(p3Row).toContainText('P3: Auriga UI')
  await expect(p3Row).toContainText('4')

  // Real literal IDs actually present in the rendered page text.
  await expect(page.locator('body')).toContainText('p2-adapter-interface')
  await expect(page.locator('body')).toContainText('p1-dispatch-throughput')
  await expect(page.locator('body')).toContainText('p3-auriga-ui')
})
