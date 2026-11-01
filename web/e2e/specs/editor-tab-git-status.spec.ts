import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 按 git 状态着色 E2E（P-20261003-242）：基线提交后改一个文件
 * （tracked 修改）+ 新建一个文件（untracked），开关两种形态：
 *   ① 默认关：tab 无 git-modified / git-untracked 类（不渲染，存量形态不变）
 *   ② 设置·外观开关打开：修改文件 tab 蓝下划线 / 未跟踪绿下划线（::after 底条；
 *      活跃 tab 由底边框色承载），且与设置行持久化 font-settings 一致
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-git-status')
const PROJ = 'e2e-tab-git-status'
const MODIFIED_FILE = 'tracked.ts'
const UNTRACKED_FILE = 'brand-new.ts'

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, MODIFIED_FILE), 'export const tracked = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab git 状态着色基线'])
  // 产出两形态变更：tracked 修改（蓝）+ 未跟踪新文件（绿）
  fs.writeFileSync(path.join(REPO_DIR, MODIFIED_FILE), 'export const tracked = 2\n')
  fs.writeFileSync(path.join(REPO_DIR, UNTRACKED_FILE), 'export const fresh = 1\n')
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并经文件树打开两个文件成 tab（第一个为活跃 tab） */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: MODIFIED_FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: MODIFIED_FILE }).first().click()
  await expect(page.locator('.editor-tab', { hasText: MODIFIED_FILE })).toBeVisible()
  await page.locator('.file-tree .item-name', { hasText: UNTRACKED_FILE }).first().click()
  await expect(page.locator('.editor-tab', { hasText: UNTRACKED_FILE })).toBeVisible()
}

/** tab 底部细条（::after）的 content 求值：开关关时 content:none → 'none'，
 *  开关开（非活跃 tab）→ '""'（伪元素实际渲染） */
function tabUnderlineContent(page: import('@playwright/test').Page, name: string) {
  return page.locator('.editor-tab', { hasText: name }).first()
    .evaluate(el => getComputedStyle(el, '::after').content)
}

test('默认关：变更文件的 tab 不渲染 git 状态下划线', async ({ page }) => {
  await openProjectAndFiles(page)
  // 两形态变更在册（变更面板缓存面有值），但开关默认关 → 无着色类、无 ::after
  await expect(page.locator('.editor-tab.git-modified')).toHaveCount(0)
  await expect(page.locator('.editor-tab.git-untracked')).toHaveCount(0)
  expect(await tabUnderlineContent(page, MODIFIED_FILE)).toBe('none')
})

test('开关开：修改 tab 蓝下划线 / 未跟踪绿下划线，持久化 font-settings', async ({ page }) => {
  await openProjectAndFiles(page)

  // 设置 → 外观 → 打开开关（直写 store 即时生效，编辑器行为类不参与设置脏护栏）
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('[data-testid="settings-git-status-tabs"]')
  await expect(row).toBeVisible({ timeout: 3000 })
  await row.locator('.n-checkbox').click()
  await expect(row.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // tab 类随开关即时出现（数据面 = changes store 缓存，零新增请求）
  const modifiedTab = page.locator('.editor-tab', { hasText: MODIFIED_FILE }).first()
  const untrackedTab = page.locator('.editor-tab', { hasText: UNTRACKED_FILE }).first()
  await expect(modifiedTab).toHaveClass(/git-modified/)
  await expect(untrackedTab).toHaveClass(/git-untracked/)

  // 颜色语义：非活跃/活跃统一经 ::after 或底边框承载——修改蓝、未跟踪绿。
  // 未跟踪 tab 是活跃 tab（后打开），底条走底边框色（::after 已退场），取边框色
  const modifiedRgb = await modifiedTab.evaluate(el => getComputedStyle(el, '::after').backgroundColor)
  const untrackedRgb = await untrackedTab.evaluate(el => getComputedStyle(el).borderBottomColor)
  expect(modifiedRgb).toMatch(/rgb\(/)
  expect(untrackedRgb).toMatch(/rgb\(/)
  expect(modifiedRgb).not.toBe(untrackedRgb)
  // 各自主题变量语义（蓝=accent-blue / 绿=accent-green）：与 tab 内蓝色系元素
  // （脏点 accent-blue）同源对比——修改 tab 的下划线与脏点同蓝
  const dirtyDotRgb = await modifiedTab.locator('.tab-dot')
    .evaluate(el => getComputedStyle(el).backgroundColor).catch(() => '')
  if (dirtyDotRgb) expect(modifiedRgb).toBe(dirtyDotRgb)

  // 持久化落盘：font-settings 记录 gitStatusTabs:true
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { gitStatusTabs?: boolean } }).editor?.gitStatusTabs).toBe(true)

  // 刷新后 tab 由 uiState 自动恢复，着色仍生效
  await page.reload()
  await expect(page.locator('.editor-tab', { hasText: MODIFIED_FILE }).first()).toHaveClass(/git-modified/, { timeout: 15000 })
  await expect(page.locator('.editor-tab', { hasText: UNTRACKED_FILE }).first()).toHaveClass(/git-untracked/)
})
