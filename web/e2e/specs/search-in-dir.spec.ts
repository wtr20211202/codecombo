import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树目录右键「在此目录搜索」（P-20261003-118）E2E：
 *   1. 右键普通目录 → ProjectSearch 打开、glob 预填 `dir/**`、查询词留空；
 *      输入查询词后结果仅落该目录（根下同名关键词被 glob 排除）
 *   2. 右键含 glob 元字符的目录（weird[1]）→ glob 预填精确等值 `weird\[1\]/**`
 *      （不转义会被字符类解释成 weird1）；搜索不报错、结果（若后端可扫描该
 *      目录）全部落在该目录内——后端相关断言不写死（Windows rg / Linux git
 *      grep 双后端转义语义已实测正确，Windows git grep 对该目录本就扫描不到）
 * 自备临时仓库，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-dir')
const PROJ_NAME = 'e2e-search-in-dir'
const PKG_DIR = 'packages'
const PKG_FILE = 'packages/inner.ts'
const WEIRD_DIR = 'weird[1]'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, PKG_DIR), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, WEIRD_DIR), { recursive: true })
  // README 故意含同一关键词：无 glob 时会被搜出——目录 glob 的「仅该目录」
  // 断言才有区分度
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'inner also mentioned at root\n')
  fs.writeFileSync(path.join(REPO_DIR, PKG_FILE), 'export const inner = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, WEIRD_DIR, 'note.txt'), 'weirdnote inside\n')
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: fixture'])

  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并等文件树就绪（dir-agent-session 同款就绪等待/右键重试口径） */
async function openProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 工具栏轮询重渲染会让元素瞬时失效：右键一律带重试
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout, button: 'right' }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  return { clickRetry }
}

/** 右键目录行并点「在此目录搜索」：菜单是 NDropdown（无 role=menuitem），
 *  走 .n-dropdown-menu + 文本精确定位（dir-agent-session 同款） */
async function searchInDir(page: Page, dirName: string, clickRetry: (loc: import('@playwright/test').Locator, timeout?: number, attempts?: number) => Promise<void>) {
  const row = page.locator('.tree-item').filter({ hasText: dirName })
  await expect(row.first()).toBeVisible()
  await clickRetry(row.first())
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible({ timeout: 10000 })
  await menu.getByText('在此目录搜索', { exact: true }).click()
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 10000 })
  return card
}

test('目录右键「在此目录搜索」→ 面板打开 glob 预填 dir/**，结果仅该目录', async ({ page }) => {
  const { clickRetry } = await openProject(page)
  const card = await searchInDir(page, PKG_DIR, clickRetry)

  // 预填契约：glob 精确等值 dir/**；查询词留空（用户输）
  await expect(card.locator('.ps-glob input')).toHaveValue('packages/**')
  await expect(card.locator('input').first()).toHaveValue('')

  // 关键词根下 README 也有：无 glob 会两文件齐中——glob 在场时结果仅该目录
  await card.locator('input').first().fill('inner')
  await expect(card.locator('.ps-file-path').filter({ hasText: PKG_FILE })).toBeVisible({ timeout: 30000 })
  await expect(card.locator('.ps-file-path').filter({ hasText: 'README.md' })).toHaveCount(0)
  await expect(card.locator('.ps-file-header')).toHaveCount(1)
})

test('特殊字符目录：glob 转义预填精确等值，搜索不报错、结果不越界', async ({ page }) => {
  const { clickRetry } = await openProject(page)
  const card = await searchInDir(page, WEIRD_DIR, clickRetry)

  // 转义契约：[ ] 逐字反斜杠转义（不转义 = 字符类，会去匹配 weird1）
  await expect(card.locator('.ps-glob input')).toHaveValue('weird\\[1\\]/**')
  await expect(card.locator('input').first()).toHaveValue('')

  await card.locator('input').first().fill('weirdnote')
  // 先等搜索收敛（结果或空态二选一，后端相关：rg / Linux git grep 对转义
  // glob 命中 note.txt；Windows git grep 扫不到该目录 → 空态），再断言不炸：
  // 不允许错误横幅（glob 语法非法会让后端报错）
  await expect(card.locator('.ps-file-path, .ps-empty').first()).toBeVisible({ timeout: 30000 })
  await expect(card.locator('.ps-error')).toHaveCount(0)
  const results = card.locator('.ps-file-path')
  const count = await results.count()
  if (count > 0) {
    for (let i = 0; i < count; i++) {
      expect(await results.nth(i).textContent()).toContain(WEIRD_DIR + '/')
    }
    await expect(results.filter({ hasText: 'note.txt' })).toBeVisible()
  }
})
