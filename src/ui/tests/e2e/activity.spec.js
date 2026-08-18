import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// src/ui/tests/e2e -> repo root
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..')

// Real end-to-end check, no mocks: playwright.config.js's webServer boots the
// actual src/server/index.mjs, backed by listActivity()'s real merge of this
// repo's own `git log` with real .pHive/audits/post-run/*.yaml records. This
// test asks git directly (not a hardcoded string) for the actual current
// HEAD commit, so it stays correct as this repo's history grows, and
// asserts that exact real commit appears in the rendered feed — per this
// story's acceptance criteria.

test('activity view renders a real, recent commit from this repo\'s own git log', async ({ page }) => {
  const [hash, subject] = execFileSync(
    'git',
    ['log', '-n', '1', '--pretty=format:%H%x1f%s'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  ).split('\x1f')

  await page.goto('/')
  await page.getByRole('button', { name: 'Activity' }).click()

  await expect(page.getByText('Real git commits merged with post-run audit records')).toBeVisible()
  await expect(page.locator('body')).toContainText(subject)
  await expect(page.locator('body')).toContainText(hash.slice(0, 7))

  // Real post-run audit record also present in the merged feed.
  await expect(page.locator('body')).toContainText('p2-adapter-interface-execute-20260816T161309Z')
})
