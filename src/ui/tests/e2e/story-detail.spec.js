import { test, expect } from '@playwright/test'

// Real end-to-end click-through, no mocks: navigates the real dashboard from
// the epics list -> a real epic's stories -> a real story's detail page, and
// asserts that story's REAL, full (not truncated/summarized) acceptance
// criteria text renders, per this story's acceptance criteria. Uses
// p2-adapter-interface/p2-router-cutover — a real, rich story YAML with 5
// acceptance criteria and 2 cross_cutting entries (concern + action).

test('epics list -> epic -> story detail renders real acceptance criteria and cross-cutting text', async ({ page }) => {
  await page.goto('/')

  // Epics list -> click a real epic.
  const p2Row = page.getByRole('row', { name: /p2-adapter-interface/ })
  await expect(p2Row).toBeVisible()
  await p2Row.click()

  // Epic detail: its real stories render with correct status badges.
  const storyRow = page.getByRole('row', { name: /p2-router-cutover/ })
  await expect(storyRow).toBeVisible()
  await expect(storyRow).toContainText('done')
  await storyRow.click()

  // Story detail: real, full acceptance_criteria text (not truncated).
  await expect(page.getByRole('heading', { name: 'Acceptance Criteria' })).toBeVisible()
  await expect(page.locator('body')).toContainText(
    'Given cycle(opts) is called, when opts is inspected, then it accepts { backlog, spawn, cfg, core, log, sleep, dryRun, noZombie, maxAssign, now } — no `mca` parameter remains',
  )
  await expect(page.locator('body')).toContainText(
    'Given the unblock, cascade, false-done/review-scan, dispatch, and review-lane passes, when grepped, then none references `mcaImpl` — every call site uses `backlog.*` or `spawn.*`',
  )

  // Cross-cutting: both concern name and its action text are shown.
  await expect(page.getByRole('heading', { name: 'Cross-Cutting' })).toBeVisible()
  await expect(page.locator('body')).toContainText('adapter-boundary-integrity')
  await expect(page.locator('body')).toContainText(
    "This is the story that PROVES the boundary works end-to-end — the cutover-e2e test IS the concern's enforcement mechanism for this slice of work",
  )

  // Dependencies + status also render.
  await expect(page.locator('body')).toContainText('p2-multica-backlog-adapter')
  await expect(page.locator('body')).toContainText('p2-multica-spawn-adapter')
})
