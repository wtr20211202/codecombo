import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器书签锚 E2E（P-20261002-131）：长文件/评审场景的跳级锚点。
 *   ① 主链路：Ctrl+Alt+B 当前行加书签 → uiState 持久化落盘 → 切到文件 B →
 *      命令面板「书签列表」弹层 → 点选条目跳回 A 的书签行（光标落位）
 *   ② 行号漂移：书签行上方插入 10 行后书签跟随到 +10（Monaco 装饰范围跟踪，
 *      弹层读到的行号同步漂移）
 *   ③ gutter 图标点击 toggle：glyph margin 单击加书签、再击移除（含落盘回读）
 *   ④ 行内容锚自愈（P-20261004-105）：外部改写磁盘（书签行上方插 10 行）后
 *      关签重开（重读磁盘）→ 按锚重定位跟随原内容行 +「已自动重锚」弱提示；
 *      锚行被删后重开 → 保持原行号 + 失效弱标（诚实降级）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-bookmarks')
const PROJ = 'e2e-editor-bookmarks'
const FILE_A = 'bm-a.txt'
const FILE_B = 'bm-b.txt'
/** 主链路书签行（fixture 中与 MARK 行号严格一致） */
const MARK_LINE = 120
/** 漂移用书签行（上方插 10 行后应为 +10） */
const DRIFT_LINE = 50
const DRIFT_AFTER = DRIFT_LINE + 10
/** 自愈用书签行（外部改写后 +10 重定位；锚行删除后失效弱标） */
const SELFHEAL_LINE = 200
const SELFHEAL_AFTER = SELFHEAL_LINE + 10

function buildFixtureA(): string {
  const lines: string[] = ['// bookmark fixture A：跳级锚点']
  for (let i = 1; i <= 300; i++) {
    // 首行是文件头说明，循环标记行整体 +1——标记落点按「文件行号 = 常量」严格
    // 对齐（P-20261004-105 锚断言锚定行内容，行号与内容必须逐行一致；此前标记
    // 实际落在常量 +1 行，旧断言只验行号未暴露）
    if (i === MARK_LINE - 1) lines.push(`// MARK-BM-${MARK_LINE} 书签落点`)
    else if (i === DRIFT_LINE - 1) lines.push(`// MARK-DRIFT-${DRIFT_LINE} 漂移用书签行`)
    else if (i === SELFHEAL_LINE - 1) lines.push(`// MARK-SELFHEAL-${SELFHEAL_LINE} 自愈锚行`)
    else lines.push(`// fixture A line ${i}`)
  }
  return lines.join('\n')
}

function buildFixtureB(): string {
  const lines: string[] = ['// bookmark fixture B：中转标签']
  for (let i = 1; i <= 40; i++) lines.push(`// fixture B line ${i} bm-b-marker-${i}`)
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
  git(REPO_DIR, ['commit', '-m', 'root: 书签基线'])
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
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('bm-b-marker-3', { timeout: 8000 })
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

/** Ctrl+Alt+B 当前行加/删书签（Monaco 编辑器域键位，编辑器需持焦点） */
async function pressToggleBookmark(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+Alt+B')
}

/** uiState 持久化里的书签表（GET /api/ui-state → data.local.bookmarks[projectId]）；
 *  P-20261004-105 起记录为 { line, anchor? }（锚 = 行内容规范化前 80 字符） */
async function persistedBookmarks(): Promise<Record<string, Array<{ line: number, anchor?: string }>>> {
  const res = await fetch(`${API_BASE}/api/ui-state`)
  const all = (await res.json()) as { data?: { local?: { bookmarks?: Record<string, Record<string, Array<{ line: number, anchor?: string }>>> } } }
  return all?.data?.local?.bookmarks?.[projectId] || {}
}

/** 清空本项目的书签（用例隔离）：uiState 是服务端全局态且用例顺序共享，
 *  equality 断言需要确定性起点。只摘除本项目的键，其余实例/命名空间原样保留 */
async function resetProjectBookmarks(): Promise<void> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`)
  const all = (await res.json()) as { data?: Record<string, { bookmarks?: Record<string, unknown> }> }
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

/** 关闭 A 的编辑器签（模拟会话离开文件），随后从文件树重开——重开链读磁盘现值，
 *  是跨会话/外部改写漂移重定位（打开文件时机）的确定性触发路径。视口就绪交给
 *  调用方 gotoLine（重开后视图状态恢复到原滚动位，文件头不在虚拟滚动 DOM 里） */
async function closeAndReopenFileA(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveCount(0)
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines').first()).toBeVisible({ timeout: 8000 })
}

test('加书签→切文件→书签列表→点击跳回书签行', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)

  // A 激活落 120 行，Ctrl+Alt+B 加书签（gutter 图标 + 整行弱高亮随装饰出现）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// bookmark fixture A', { timeout: 8000 })
  await gotoLine(page, MARK_LINE)
  await pressToggleBookmark(page)
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-line').first()).toBeVisible()

  // toggle 即时落盘：uiState 里出现 A 的书签记录（行号 + 行内容锚，时间戳断言
  // 等价于持久化断言）
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: MARK_LINE, anchor: expect.stringContaining(`MARK-BM-${MARK_LINE}`) }],
  })

  // 切到文件 B：A 的书签从编辑器装饰上消失（model 已切走）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('bm-b-marker-3', { timeout: 8000 })
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)

  // 命令面板 → 命令模式输「书签」→「书签列表」弹层列出 A 的条目
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>书签列表')
  const item = page.locator('.palette-item').filter({ hasText: '书签列表' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  const popover = page.locator('[data-testid="bookmark-list"]')
  await expect(popover).toBeVisible({ timeout: 5000 })
  const row = popover.locator('[data-testid^="bookmark-item-"]')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(FILE_A)
  await expect(row).toContainText(`第 ${MARK_LINE} 行`)

  // 点选条目：弹层关闭 → A 激活 → 光标落回书签行
  await row.click()
  await expect(popover).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 8000 }).toBe(MARK_LINE)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(`MARK-BM-${MARK_LINE}`, { timeout: 8000 })
})

test('行号漂移：书签行上方插入 10 行后书签跟随 +10', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)

  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// bookmark fixture A', { timeout: 8000 })
  await gotoLine(page, DRIFT_LINE)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(`MARK-DRIFT-${DRIFT_LINE}`, { timeout: 8000 })
  await pressToggleBookmark(page)
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })

  // 光标移到文件头（第 1 行行首），键入 10 行注释：书签随 Monaco 装饰范围整体下移 10 行
  await gotoLine(page, 1)
  await page.keyboard.press('Home')
  for (let i = 0; i < 10; i++) {
    await page.keyboard.type(`// inserted ${i + 1}`)
    await page.keyboard.press('Enter')
  }
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(11)
  // 漂移回写防抖 0.6s + 渲染——书签 gutter 图标仍在（虚拟滚动下按需），行号状态
  // 已更新；锚随行内容刷新（内容未变锚不变）
  await page.waitForTimeout(1200)
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: DRIFT_AFTER, anchor: expect.stringContaining(`MARK-DRIFT-${DRIFT_LINE}`) }],
  })

  // 弹层读到的行号随漂移更新
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>书签列表')
  const item = page.locator('.palette-item').filter({ hasText: '书签列表' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  const popover = page.locator('[data-testid="bookmark-list"]')
  await expect(popover).toBeVisible({ timeout: 5000 })
  const row = popover.locator('[data-testid^="bookmark-item-"]')
  await expect(row).toContainText(`第 ${DRIFT_AFTER} 行`, { timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)
})

test('gutter 图标点击 toggle：单击加书签、再击移除', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)

  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// bookmark fixture A', { timeout: 8000 })
  // 定位到 MARK 行（光标行号几何已由 cursorLine 验证），取光标盒中心 y 作为
  // 该行车道点击位。编辑器开了 smoothScrolling——Ctrl+G 后滚动有动画，须等
  // 光标盒几何稳定再测量（动画期间测量会把点击位算到未滚完的行带上）
  await gotoLine(page, MARK_LINE)
  const editor = page.locator('.pane-primary .monaco-editor')
  const glyphClick = async () => {
    const cursor = page.locator('.pane-primary .monaco-editor .cursor').first()
    let prevY = -1
    for (let i = 0; i < 12; i++) {
      const y = (await cursor.boundingBox())?.y ?? -1
      if (y >= 0 && Math.abs(y - prevY) < 1) break
      prevY = y
      await page.waitForTimeout(120)
    }
    const c = (await cursor.boundingBox())!
    const e = (await editor.boundingBox())!
    await editor.click({ position: { x: 8, y: c.y - e.y + c.height / 2 } })
  }

  // glyph margin 车道在行号左侧（编辑器最左 ~20px）：单击该车道 = 加书签
  await glyphClick()
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: MARK_LINE, anchor: expect.stringContaining(`MARK-BM-${MARK_LINE}`) }],
  })

  // 再击同一行车道 = 移除书签（落盘回读为空）
  await glyphClick()
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0, { timeout: 5000 })
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({})
})

test('行内容锚自愈：外部插入行重开后跟随原内容；锚行被删重开后失效弱标', async ({ page }) => {
  await resetProjectBookmarks()
  await openProjectAndFiles(page)
  const fileAPath = path.join(REPO_DIR, FILE_A)

  // ── 第一幕：加书签 → 外部改盘（书签行上方插 10 行，agent 批量改动同形）→
  // 关签重开（重读磁盘）→ 按锚重定位跟随原内容行 + 弱提示 ──
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// bookmark fixture A', { timeout: 8000 })
  await gotoLine(page, SELFHEAL_LINE)
  await pressToggleBookmark(page)
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: SELFHEAL_LINE, anchor: expect.stringContaining(`MARK-SELFHEAL-${SELFHEAL_LINE}`) }],
  })

  const external = fs.readFileSync(fileAPath, 'utf8').split('\n')
  external.splice(SELFHEAL_LINE - 1, 0, ...Array.from({ length: 10 }, (_, i) => `// external inserted ${i + 1}`))
  fs.writeFileSync(fileAPath, external.join('\n'))
  await closeAndReopenFileA(page)

  // 重锚弱提示（会话内一次性事件提示）+ 持久化跟随到原内容行（锚不变）
  await expect(page.locator('.n-message', { hasText: '已自动重锚' })).toBeVisible({ timeout: 8000 })
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: SELFHEAL_AFTER, anchor: expect.stringContaining(`MARK-SELFHEAL-${SELFHEAL_LINE}`) }],
  })
  await gotoLine(page, SELFHEAL_AFTER)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(`MARK-SELFHEAL-${SELFHEAL_LINE}`, { timeout: 8000 })
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph.is-stale')).toHaveCount(0)

  // 弹层行号跟随重锚（无失效标）
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>书签列表')
  await page.locator('.palette-item').filter({ hasText: '书签列表' }).first().click()
  const popover = page.locator('[data-testid="bookmark-list"]')
  await expect(popover).toBeVisible({ timeout: 5000 })
  await expect(popover.locator(`[data-testid="bookmark-item-${SELFHEAL_AFTER}"]`)).toContainText(`第 ${SELFHEAL_AFTER} 行`)
  await expect(popover.locator('[data-testid="bookmark-stale-badge"]')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(popover).toHaveCount(0)

  // ── 第二幕：锚行被外部删除 → 重开 → 诚实降级：保持原行号 + 失效弱标
  //（gutter 同图标弱化形态 + 弹层「可能已漂移」小标）──
  const truncated = fs.readFileSync(fileAPath, 'utf8').split('\n')
  const anchorIdx = truncated.findIndex(l => l.includes(`MARK-SELFHEAL-${SELFHEAL_LINE}`))
  expect(anchorIdx).toBeGreaterThanOrEqual(0)
  truncated.splice(anchorIdx, 1)
  fs.writeFileSync(fileAPath, truncated.join('\n'))
  await closeAndReopenFileA(page)
  await gotoLine(page, SELFHEAL_AFTER)

  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph.is-stale').first()).toBeVisible({ timeout: 8000 })
  // 行号诚实保留在最后一次重锚位（不瞎猜新落点），锚原样保存
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({
    [FILE_A]: [{ line: SELFHEAL_AFTER, anchor: expect.stringContaining(`MARK-SELFHEAL-${SELFHEAL_LINE}`) }],
  })
  await page.keyboard.press('Control+Shift+P')
  const input2 = page.locator('.palette-input input')
  await expect(input2).toBeVisible({ timeout: 5000 })
  await input2.fill('>书签列表')
  await page.locator('.palette-item').filter({ hasText: '书签列表' }).first().click()
  const popover2 = page.locator('[data-testid="bookmark-list"]')
  await expect(popover2).toBeVisible({ timeout: 5000 })
  await expect(popover2.locator('[data-testid="bookmark-stale-badge"]')).toBeVisible()
})

test('旧数据面兼容：升级前纯行号书签原样可用（读取端降级收编、不回写）', async ({ page }) => {
  await resetProjectBookmarks()
  // 预置升级前版本的落盘形态（纯行号数组）——「旧数据面 + 新二进制」组合
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`)
  const all = (await res.json()) as { data?: Record<string, { bookmarks?: Record<string, unknown> }> }
  const data = all?.data || {}
  const local = data.local || {}
  local.bookmarks = { ...(local.bookmarks || {}), [projectId]: { [FILE_A]: [MARK_LINE] } }
  data.local = local
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify(data),
  })

  await openProjectAndFiles(page)
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// bookmark fixture A', { timeout: 8000 })
  await gotoLine(page, MARK_LINE)
  // 旧格式书签照常落装饰（无锚降级：不重定位不标失效），读取不产生写盘副作用
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph.is-stale')).toHaveCount(0)
  // 原始落盘形态原样保留（新读取端收编只在内存，不回写）
  await expect.poll(persistedBookmarks, { timeout: 8000 }).toEqual({ [FILE_A]: [MARK_LINE] })
})
