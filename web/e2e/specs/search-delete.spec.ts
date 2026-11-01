import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索结果行删除 E2E（P-20261003-178）：
 *   1. 单项目：结果行删除钮 → 确认弹窗点名文件 → 确认后文件从磁盘消失 +
 *      该文件全部结果即时移除（分组/统计跟随），其余文件结果原样保留。
 *   2. 取消：确认弹窗点取消 → 文件保留在磁盘与结果列表。
 *   3. 跨项目模式：删除钮禁用并带原因 tooltip（路由复杂度，单项目模式限定）。
 * 自备临时仓库，afterAll 清理。确认弹窗为 confirmDialog 的 n-dialog
 * （useDialog），须在弹窗内点确认按钮（CLAUDE.md 测试节）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-del-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-del-b')
const PROJ_A = 'e2e-sdel-a'
const PROJ_B = 'e2e-sdel-b'
const SCOPE_KEY = 'project-search-scope'
// 单项目用例关键词：a.log 为待删垃圾文件，keep.md 为留守对照
const NEEDLE = 'sdelneedlex'
// 跨项目用例独占关键词：两仓同名 junk 文件都命中，与用例 1/2 结果集互不干扰
const XNEEDLE = 'sdelxneedlex'

let projIdA = ''
let projIdB = ''

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 搜索结果行删除基线'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  makeRepo(REPO_A, {
    'a.log': `${NEEDLE} junk line one\n${NEEDLE} junk line two\n`,
    'keep.md': `${NEEDLE} keeper\n`,
    'same.txt': `${XNEEDLE} from-a\n`,
  })
  makeRepo(REPO_B, {
    'same.txt': `${XNEEDLE} from-b\n`,
  })
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

const DELETE_BTN = '[data-testid="ps-file-delete"]'

/**
 * 收起查询历史下拉（P-20261003-48）：搜索落地时输入框仍聚焦，历史下拉
 * 悬浮在结果列表上方（z-index 30），会拦截其下所有点击——Esc 分层关闭
 * （只收下拉不关面板），真实用户同此操作路径（search-copy-paths 同款）
 */
async function dismissHistoryDropdown(page: Page, card: ReturnType<Page['locator']>) {
  await page.keyboard.press('Escape')
  await expect(card.locator('.ps-history')).toHaveCount(0, { timeout: 3000 })
}

/** 进项目 → 开搜索面板 → 搜索 → 等统计行落地（=结果已渲染） */
async function searchInProject(page: Page, projectName: string, needle: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(needle)
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await dismissHistoryDropdown(page, card)
  return card
}

test('结果行删除 → 确认 → 磁盘消失 + 结果行即时移除，其余结果保留', async ({ page }) => {
  test.setTimeout(60000)
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  // 基线：a.log 两处命中一组 + keep.md 一组；删除钮在文件组头上
  const junkHeader = card.locator('.ps-file-header').filter({ hasText: 'a.log' })
  const keepHeader = card.locator('.ps-file-header').filter({ hasText: 'keep.md' })
  await expect(junkHeader).toHaveCount(1)
  await expect(keepHeader).toHaveCount(1)
  const delBtn = junkHeader.locator(DELETE_BTN)
  await expect(delBtn).toBeEnabled()
  // tooltip i18n（zh 直译）
  await expect(delBtn).toHaveAttribute('title', '删除该文件')

  await delBtn.click()

  // 确认弹窗（confirmDialog → n-dialog）点名待删文件
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('a.log')
  await page.getByRole('button', { name: '确认' }).click()

  // 即时移除：a.log 组消失（含其 2 条命中），统计行只剩 keep.md 的 1 处
  await expect(card.locator('.ps-file-header').filter({ hasText: 'a.log' })).toHaveCount(0, { timeout: 5000 })
  await expect(keepHeader).toBeVisible()
  await expect(card.locator('.ps-line')).toHaveCount(1)
  // 成功 toast 复用树删除族文案
  await expect(page.locator('.n-message').filter({ hasText: '已删除 a.log' })).toBeVisible({ timeout: 5000 })

  // 磁盘上文件确实没了，keep.md 原样
  expect(fs.existsSync(path.join(REPO_A, 'a.log'))).toBe(false)
  expect(fs.existsSync(path.join(REPO_A, 'keep.md'))).toBe(true)
})

test('结果行删除 → 取消 → 文件保留在磁盘与结果列表', async ({ page }) => {
  test.setTimeout(60000)
  const card = await searchInProject(page, PROJ_A, NEEDLE)

  const keepHeader = card.locator('.ps-file-header').filter({ hasText: 'keep.md' })
  await expect(keepHeader).toBeVisible()
  await keepHeader.locator(DELETE_BTN).click()

  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('keep.md')
  await page.getByRole('button', { name: '取消' }).click()

  await expect(dialog).toHaveCount(0)
  await expect(keepHeader).toBeVisible()
  expect(fs.existsSync(path.join(REPO_A, 'keep.md'))).toBe(true)
})

test('跨项目模式：删除钮禁用并带原因 tooltip', async ({ page }) => {
  test.setTimeout(60000)
  // 范围记忆种子（P-20261003-69 的 localStorage 键）：面板打开即恢复两项目范围
  await page.addInitScript(([key, ids]) => {
    window.localStorage.setItem(key as string, ids as string)
  }, [SCOPE_KEY, JSON.stringify([projIdA, projIdB])])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_A }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(XNEEDLE)
  // 跨项目流式上屏：两组头 + 统计行落地 = 全部组已落定
  await expect(card.locator('.ps-project-header').filter({ hasText: PROJ_A })).toBeVisible({ timeout: 8000 })
  await expect(card.locator('.ps-project-header').filter({ hasText: PROJ_B })).toBeVisible({ timeout: 8000 })
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  // 每个文件组头的删除钮均禁用，tooltip 说明原因；文件不消失
  const btns = card.locator(DELETE_BTN)
  const n = await btns.count()
  expect(n).toBeGreaterThanOrEqual(2)
  for (let i = 0; i < n; i++) {
    await expect(btns.nth(i)).toBeDisabled()
    await expect(btns.nth(i)).toHaveAttribute('title', '跨项目结果不支持删除，请切回单项目范围')
  }
  expect(fs.existsSync(path.join(REPO_A, 'same.txt'))).toBe(true)
  expect(fs.existsSync(path.join(REPO_B, 'same.txt'))).toBe(true)
})
