import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 工作树锁定切换 E2E：右键 worktree → 锁定 → git worktree list 显示
 * (+)（锁定标记）→ 右键解锁 → 恢复。锁定的语义是防止误删/误检出到该
 * worktree。自包含前置（CLI 建 worktree），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-wt-lock')
const WT_DIR = REPO_DIR + '-lock'
const PROJ = 'e2e-wt-lock'
const WT_BRANCH = 'wt-lock-branch'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let savedHeaders: Record<string, string> = {}

test.beforeAll(async ({ request }) => {
  savedHeaders = await unlockHeaders()
  const headers = savedHeaders
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  for (const dir of [REPO_DIR, WT_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'wt lock e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: wt lock 基线'])
  const created = await request.post(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
  // worktree 元数据里的路径形态决定服务端 lock/unlock 按不按得中：
  // Windows 服务端走 CLI（win 路径落元数据）；linux 服务端经服务端 API 建
  // （/mnt/c 形态；Windows git 建 /mnt/c 路径会被当成相对路径，无法同形）
  if (serverIsLinux) {
    const wt = await request.post(`${API_BASE}/api/projects/${projectId}/worktrees`, {
      headers, data: { path: serverPath(WT_DIR), branch: WT_BRANCH },
    })
    expect(wt.ok()).toBeTruthy()
  } else {
    git(REPO_DIR, ['worktree', 'add', WT_DIR, '-b', WT_BRANCH])
  }
})

test.afterAll(async ({ request }) => {
  const headers = savedHeaders['X-Lock-Token'] ? savedHeaders : await unlockHeaders()
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { execFileSync('git', ['worktree', 'remove', '--force', WT_DIR], { cwd: REPO_DIR }) } catch { /* 已不存在 */ }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(WT_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('工作树锁定/解锁切换：锁定标记出现 → 解锁还原', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.wt-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  // 工作树分节折叠时先展开
  let wtRow = page.locator('.wt-item', { hasText: WT_BRANCH }).first()
  if (!(await wtRow.isVisible().catch(() => false))) {
    const header = page.locator('.section-header').filter({ hasText: '工作树' }).first()
    if (await header.isVisible().catch(() => false)) {
      await header.click()
      await page.waitForTimeout(600)
    }
  }
  wtRow = page.locator('.wt-item', { hasText: WT_BRANCH }).first()
  await expect(wtRow).toBeVisible({ timeout: 5000 })

  // 锁定
  await wtRow.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('锁定', { exact: true }).first().click()
  await expect(page.locator('.n-message').filter({ hasText: '已锁定' })).toBeVisible({ timeout: 5000 })

  // CLI/服务端语义：worktree list 中该行带 locked 标记（+ 前缀）
  await expect.poll(async () => {
    const list = git(REPO_DIR, ['worktree', 'list', '--porcelain'])
    return list.includes('locked') ? 'locked' : 'unlocked'
  }, { timeout: 5000 }).toBe('locked')

  // 行上出现锁定徽章（列表已按锁定态刷新）再右键：跨拓扑刷新往返慢，
  // 早右键会按未锁态弹「锁定」菜单，「解锁」项不存在（实测间歇翻车）
  wtRow = page.locator('.wt-item', { hasText: WT_BRANCH }).first()
  await expect(wtRow.locator('.wt-badge.locked')).toBeVisible({ timeout: 8000 })

  // 解锁还原
  await wtRow.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('解锁', { exact: true }).first().click()
  await expect(page.locator('.n-message').filter({ hasText: '已解锁' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => {
    const list = git(REPO_DIR, ['worktree', 'list', '--porcelain'])
    return list.includes('locked') ? 'locked' : 'unlocked'
  }, { timeout: 5000 }).toBe('unlocked')
})
