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
  await expect(storyRow).toContainText('shipped')
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

// Regression test for a post-review fix: StoryDetailView's "← Back to
// {epicId}" button used to always reset navigation to the TOP-LEVEL epics
// list (losing the drill-down), even though its own label promises
// returning to that epic's story list. Clicking it must land back on the
// SAME epic's story list, not the top-level epics table.
test('StoryDetailView\'s "Back to {epic}" button returns to that epic\'s story list, not the top-level epics list', async ({ page }) => {
  await page.goto('/')

  const p2Row = page.getByRole('row', { name: /p2-adapter-interface/ })
  await expect(p2Row).toBeVisible()
  await p2Row.click()

  const storyRow = page.getByRole('row', { name: /p2-router-cutover/ })
  await expect(storyRow).toBeVisible()
  await storyRow.click()

  await expect(page.getByRole('heading', { name: 'Acceptance Criteria' })).toBeVisible()

  const backButton = page.getByRole('button', { name: /Back to p2-adapter-interface/ })
  await expect(backButton).toBeVisible()
  await backButton.click()

  // Must land on p2-adapter-interface's OWN story list (not the top-level
  // epics table) — the same story row is visible again, and the top-level
  // epics list's description text (unique to the non-drilled view) is gone.
  await expect(page.getByRole('row', { name: /p2-router-cutover/ })).toBeVisible()
  await expect(page.getByText("Live epic list from this repo's .pHive/epics/ state.")).not.toBeVisible()
})
