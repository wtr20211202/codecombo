import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 书签间跳转键 E2E（P-20261004-102）：Ctrl+Alt+PgUp/PgDn 上/下一个书签环形跳转
 * （原提案预留的 Alt+PgUp/PgDn 与 Monaco 内核 scrollPageUp/Down win/linux 绑定
 * 撞键，退避 Ctrl+Alt 家族）——
 *   ① 无书签时按键放行（越界放行惯例：不消费、不切 tab、光标不动）
 *   ② 主链路：两文件各一书签 → Ctrl+Alt+PgDn 跳下一个（跨文件打开+行定位落光标）
 *      → 再按回环到首文件书签 → Ctrl+Alt+PgUp 反向回绕
 * 跳转链 = handleSearchOpenFile「开文件 + 行定位轮询」既有链（书签列表弹层
 * 点选同款）；环形序 = 路径字典序 × 行升序（neighborBookmark 纯函数，单测在
 * useEditorBookmarks.test.ts）。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-bookmark-jump')
const PROJ = 'e2e-bookmark-jump'
const FILE_A = 'bm-a.txt'
const FILE_B = 'bm-b.txt'
/** A/B 各一书的书签行（fixture 中与 MARK 行号严格一致） */
const MARK_A = 120
const MARK_B = 30

function buildFixtureA(): string {
  const lines: string[] = ['// jump fixture A：书签起点']
  for (let i = 1; i <= 300; i++) {
    if (i === MARK_A) lines.push(`// MARK-JUMP-A-${i} A 的书签落点`)
    else lines.push(`// fixture A line ${i}`)
  }
  return lines.join('\n')
}

function buildFixtureB(): string {
  const lines: string[] = ['// jump fixture B：书签终点']
  for (let i = 1; i <= 40; i++) {
    if (i === MARK_B) lines.push(`// MARK-JUMP-B-${i} B 的书签落点`)
    else lines.push(`// fixture B line ${i} bm-jump-b-${i}`)
  }
  return lines.join('\n')
}

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
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), buildFixtureA())
  fs.writeFileSync(path.join(REPO_DIR, FILE_B), buildFixtureB())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 书签跳转基线'])
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

/** 打开项目并经文件树打开 A、B 两文件（幂等：已开的只会被激活） */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await page.locator('.file-tree .item-name', { hasText: FILE_B }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('bm-jump-b-3', { timeout: 8000 })
}

/** 光标 1-based 行号：cursor 的 content 坐标 top / 行高（滚出视口也成立） */
async function cursorLine(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('.pane-primary .monaco-editor .cursor').first().evaluate((el) => {
    const h = parseFloat((el as HTMLElement).style.height) || 22
    return Math.round(parseFloat((el as HTMLElement).style.top) / h) + 1
  })
}

/** Ctrl+G 转行落光标（键盘路径确定性最好），落到后断言行号 */
async function gotoLine(page: import('@playwright/test').Page, line: number): Promise<void> {
  await page.locator('.pane-primary .monaco-editor').click({ position: { x: 250, y: 200 } })
  await page.keyboard.press('Control+G')
  await page.keyboard.type(String(line))
  await page.keyboard.press('Enter')
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(line)
}

/** 激活某文件 tab 并等光标落到 line（tab 视图快照恢复的光标位） */
async function activateTab(page: import('@playwright/test').Page, file: string, line: number): Promise<void> {
  await page.locator('.pane-primary .editor-tab', { hasText: file }).click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: file })).toHaveClass(/active/)
  await gotoLine(page, line)
}

/** Ctrl+Alt+B 当前行加/删书签（Monaco 编辑器域键位，编辑器需持焦点） */
async function pressToggleBookmark(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+Alt+B')
}

/** uiState 持久化里的书签表（GET /api/ui-state → data.local.bookmarks[projectId]）；
 *  记录形态随 P-20261004-105 演进为 { line, anchor? }（旧纯行号 number[] 读取端降级收编），
 *  这里归一取 line 字段——本 spec 断言行号集合，锚内容属 105 域 */
async function persistedBookmarks(): Promise<Record<string, number[]>> {
  const res = await fetch(`${API_BASE}/api/ui-state`)
  const all = (await res.json()) as { data?: { local?: { bookmarks?: Record<string, Record<string, unknown[]>> } } }
  const raw = all?.data?.local?.bookmarks?.[projectId] || {}
  return Object.fromEntries(
    Object.entries(raw).map(([f, marks]) => [f, marks.map(m => (typeof m === 'number' ? m : (m as { line: number }).line))]),
  )
}

/** 清空本项目的书签（用例隔离）：uiState 是服务端全局态且用例顺序共享，
 *  equality 断言需要确定性起点。只摘除本项目的键，其余实例/命名空间原样保留 */
async function resetProjectBookmarks(): Promise<void> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`)
  const all = (await res.json()) as { data?: Record<string, { bookmarks?: Record<string, Record<string, number[]>> }> }
  const data = all?.data || {}
  const local = data.local || {}
  const bookmarks = { ...(local.bookmarks || {}) }
  delete bookmarks[projectId]
  local.bookmarks = bookmarks
  data.local = local
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify(data),
  })
}

test('无书签时 Ctrl+Alt+PgDn 放行：不消费、不切 tab、光标不动', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)

  await activateTab(page, FILE_A, 10)
  await page.keyboard.press('Control+Alt+PageDown')
  await page.waitForTimeout(800)
  // 仍是 A 活跃 + 光标原位（无书签 veto 放行，跳转链零触发）
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 3000 }).toBe(10)
})

test('Ctrl+Alt+PgDn 跨文件跳下一个书签→再按回环；Ctrl+Alt+PgUp 反向回绕', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)

  // A:120 / B:30 各加一书签（toggle 即时落盘，等持久化收敛再按跳转键）
  await activateTab(page, FILE_A, MARK_A)
  await pressToggleBookmark(page)
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await activateTab(page, FILE_B, MARK_B)
  await pressToggleBookmark(page)
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({ [FILE_A]: [MARK_A], [FILE_B]: [MARK_B] })

  // 回 A 的书签行（环形序起点），Alt+PgDn → 跨文件跳 B:30（打开+定位落光标）
  await activateTab(page, FILE_A, MARK_A)
  await page.keyboard.press('Control+Alt+PageDown')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toHaveClass(/active/, { timeout: 8000 })
  await expect.poll(() => cursorLine(page), { timeout: 8000 }).toBe(MARK_B)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(`MARK-JUMP-B-${MARK_B}`, { timeout: 8000 })

  // 再按 Alt+PgDn：B:30 严格之后无书签 → 环尾回绕到 A:120
  await page.keyboard.press('Control+Alt+PageDown')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/, { timeout: 8000 })
  await expect.poll(() => cursorLine(page), { timeout: 8000 }).toBe(MARK_A)

  // Alt+PgUp 反向：A:120 严格之前无书签 → 环头回绕到 B:30；再按回 A:120
  await page.keyboard.press('Control+Alt+PageUp')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toHaveClass(/active/, { timeout: 8000 })
  await expect.poll(() => cursorLine(page), { timeout: 8000 }).toBe(MARK_B)
  await page.keyboard.press('Control+Alt+PageUp')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/, { timeout: 8000 })
  await expect.poll(() => cursorLine(page), { timeout: 8000 }).toBe(MARK_A)
})
