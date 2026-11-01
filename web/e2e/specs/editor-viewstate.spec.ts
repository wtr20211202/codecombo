import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器切 tab 保存/恢复光标与滚动 E2E（P-20261002-11）：
 *   ① 主组往返：A 中 Ctrl+G 落 120 行（视图随动）→ 切 B → 切回 A → 滚动与光标行原位还原
 *   ② 分屏双组互不串位：同文件共享 model 开在两组，各自定位不同行，两组各自
 *      往返切换后各恢复各的位置（per-group 快照桶，单一 Map 语义在双组下会串）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-viewstate')
const PROJ = 'e2e-editor-viewstate'
const FILE_A = 'viewstate-a.txt'
const FILE_B = 'viewstate-b.txt'
/** 光标落点（1-based 行号，fixture 中与 MARK 行号严格一致） */
const MARK_LINE_MAIN = 120
const MARK_LINE_SPLIT = 180

function buildFixtureA(): string {
  const lines: string[] = ['// viewstate fixture A：滚动+光标跨 tab 保留']
  for (let i = 1; i <= 260; i++) {
    if (i === MARK_LINE_MAIN) lines.push(`// MARK-A-${i} 光标落点（主组）`)
    else if (i === MARK_LINE_SPLIT) lines.push(`// MARK-A-${i} 光标落点（分屏组）`)
    else lines.push(`// fixture A line ${i}`)
  }
  return lines.join('\n')
}

function buildFixtureB(): string {
  const lines: string[] = ['// viewstate fixture B：中转标签']
  for (let i = 1; i <= 40; i++) lines.push(`// fixture B line ${i} b-marker-${i}`)
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
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), buildFixtureA())
  fs.writeFileSync(path.join(REPO_DIR, FILE_B), buildFixtureB())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: viewstate 基线'])
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
}

/** 若上次会话恢复出分屏（空态占位或带文件），先一键关闭归到单组 */
async function ensureSplitClosed(page: import('@playwright/test').Page) {
  if (!(await page.locator('.pane-split').isVisible().catch(() => false))) return
  const emptyClose = page.locator('.split-empty-close')
  if (await emptyClose.isVisible().catch(() => false)) {
    await emptyClose.click()
  } else {
    await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '关闭分屏' }).click()
  }
  await expect(page.locator('.pane-split')).toHaveCount(0)
}

/** 垂直滚动位置：本 Monaco 版本滚动作用在 .view-lines 位移上，
 *  scrollTop = 编辑器容器 top − view-lines top（页级滚动两者同减，天然抵消） */
async function readScrollTop(page: import('@playwright/test').Page, pane: string): Promise<number> {
  const ed = await page.locator(`${pane} .monaco-editor`).boundingBox()
  const vl = await page.locator(`${pane} .monaco-editor .view-lines`).boundingBox()
  return ed && vl ? Math.max(0, ed.y - vl.y) : 0
}

/** 光标 1-based 行号：cursor 的 content 坐标 top / 行高（滚出视口也成立） */
async function cursorLine(page: import('@playwright/test').Page, pane: string): Promise<number> {
  return page.locator(`${pane} .monaco-editor .cursor`).first().evaluate((el) => {
    const h = parseFloat((el as HTMLElement).style.height) || 22
    return Math.round(parseFloat((el as HTMLElement).style.top) / h) + 1
  })
}

/** 等滚动读数落定并返回稳定值：smoothScrolling 开启下 Ctrl+G 的居中 reveal
 *  走 ScrollType.Smooth 平滑滚动（gotoLineQuickAccess 实锚），光标 style.top
 *  即刻到位而滚动动画随后才收敛——基线若取动画中值，往返断言拿「动画中值」
 *  比「快照恢复末值」即假漂移（实测 9~52px 随负载漂动、两轮全量复现）。
 *  Scrollable 构造带 forceIntegerValues（monaco scrollable.js），scrollTop 整数
 *  化：连续两次（间隔 150ms）读数相等 = 动画收敛到目标像素，取该值 */
async function waitScrollSettled(page: import('@playwright/test').Page, pane: string): Promise<number> {
  let prev = await readScrollTop(page, pane)
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(150)
    const cur = await readScrollTop(page, pane)
    if (cur === prev) return cur
    prev = cur
  }
  return prev
}

/** Ctrl+G 转行落光标（Monaco 快速输入；滚轮在本环境会误滚外层页面，
 *  键盘路径确定性最好），等平滑滚动落定后断言滚动确已离开顶部 */
async function gotoLine(page: import('@playwright/test').Page, pane: string, line: number): Promise<number> {
  await page.locator(`${pane} .monaco-editor`).click({ position: { x: 250, y: 200 } })
  await page.keyboard.press('Control+G')
  await page.keyboard.type(String(line))
  await page.keyboard.press('Enter')
  await expect.poll(() => cursorLine(page, pane), { timeout: 5000 }).toBe(line)
  const top = await waitScrollSettled(page, pane)
  expect(top).toBeGreaterThan(1000) // 120/180 行深处的滚动位，非 1:1 顶部
  return top
}

test('主组切 tab 往返：滚动位置与光标行还原', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)

  // 主组切到 A，Ctrl+G 落 120 行（视图随动到深处）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  const scrollBefore = await gotoLine(page, '.pane-primary', MARK_LINE_MAIN)

  // 切到 B（首次打开曾走 loading 占位：A 的编辑器整卸载，卸载前快照生效）再切回 A
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()

  // 断言滚动与光标行双还原（±2px 容差：位移亚像素取整）
  await expect.poll(async () => readScrollTop(page, '.pane-primary'), { timeout: 5000 })
    .toBeGreaterThan(scrollBefore - 2)
  const top = await readScrollTop(page, '.pane-primary')
  expect(Math.abs(top - scrollBefore)).toBeLessThanOrEqual(2)
  await expect.poll(() => cursorLine(page, '.pane-primary'), { timeout: 5000 }).toBe(MARK_LINE_MAIN)
})

test('分屏双组同文件各滚各的：往返后互不串位', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)

  // 主组：A 落 120 行
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  const scroll0 = await gotoLine(page, '.pane-primary', MARK_LINE_MAIN)

  // tab 右键 → 在右侧分屏打开（共享同一 buffer/model，两组各一签）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split')).toBeVisible()
  // 260 行文件只渲染可见窗口，长内容断言用「编辑器已挂载」代替 containText
  await expect(page.locator('.pane-split .monaco-editor')).toBeVisible({ timeout: 8000 })

  // 分屏组：同一文件落 180 行（与主组不同位置）
  const scroll1 = await gotoLine(page, '.pane-split', MARK_LINE_SPLIT)
  expect(scroll1).toBeGreaterThan(scroll0) // 两组位置确已拉开

  // 分屏打开使主组 pane 变宽/变窄触发 Monaco 重排（滚动位整体偏移），
  // 往返基线须在布局稳定后重读，不与分屏前的 scroll0 比较
  //（waitScrollSettled：重排/平滑滚动的收敛与上同因，取稳定末值）
  const scroll0b = await waitScrollSettled(page, '.pane-primary')
  await expect.poll(() => cursorLine(page, '.pane-primary'), { timeout: 5000 }).toBe(MARK_LINE_MAIN)

  // 主组往返 A→B→A：主组恢复主组的位置，分屏组原位不动
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect.poll(async () => Math.abs((await readScrollTop(page, '.pane-primary')) - scroll0b), { timeout: 5000 })
    .toBeLessThanOrEqual(2)
  await expect.poll(() => cursorLine(page, '.pane-primary'), { timeout: 5000 }).toBe(MARK_LINE_MAIN)
  await expect.poll(() => cursorLine(page, '.pane-split'), { timeout: 5000 }).toBe(MARK_LINE_SPLIT)

  // 分屏组也往返：先点分屏组标签激活组 1，再把 B 开进分屏组（卸载快照）→ 切回 A
  await page.locator('.pane-split .editor-tab', { hasText: FILE_A }).click()
  await page.locator('.file-tree .item-name', { hasText: FILE_B }).first().click()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILE_B })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
  await page.locator('.pane-split .editor-tab', { hasText: FILE_A }).click()
  await expect.poll(async () => Math.abs((await readScrollTop(page, '.pane-split')) - scroll1), { timeout: 5000 })
    .toBeLessThanOrEqual(2)
  await expect.poll(() => cursorLine(page, '.pane-split'), { timeout: 5000 }).toBe(MARK_LINE_SPLIT)

  // 主组再往返一次（此步在单一共享 Map 下会串位：分屏组的卸载快照覆盖了同键）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click()
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect.poll(async () => Math.abs((await readScrollTop(page, '.pane-primary')) - scroll0b), { timeout: 5000 })
    .toBeLessThanOrEqual(2)
  await expect.poll(() => cursorLine(page, '.pane-primary'), { timeout: 5000 }).toBe(MARK_LINE_MAIN)
})
