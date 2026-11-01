import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器导航历史 E2E（P-20261002-51）：跳转链后 Ctrl+Alt+← 后退 / Ctrl+Alt+→ 前进。
 *   ① 跨文件：A 中 Ctrl+G 落 100 行 → Quick Open 开 B → 后退回 A（行号 100 附近）
 *      → 前进再到 B（光标回到离开时的行）
 *   ② 后退目标已关闭：关掉 A 后再后退 → A 重开并落回原行
 *   ③ 同文件远距跳转：A 内两次 Ctrl+G 落点之间后退/前进往返；空栈按键无副作用；
 *      列级精度（P-20261002-148 增量）：离开前光标停 10 列，后退落位经等宽
 *      字符宽校准的 DOM 测列断言恢复同一列
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-nav')
const PROJ = 'e2e-editor-nav'
const FILE_A = 'navhist-a.txt'
const FILE_B = 'navhist-b.txt'
/** 后退落点（1-based 行号，fixture 中与 MARK 行号严格一致） */
const MARK_LINE = 100

function buildFixtureA(): string {
  const lines: string[] = ['// nav fixture A：跳转链回溯']
  for (let i = 1; i <= 260; i++) {
    if (i === MARK_LINE) lines.push(`// MARK-A-${i} 后退落点`)
    else lines.push(`// fixture A line ${i}`)
  }
  return lines.join('\n')
}

function buildFixtureB(): string {
  const lines: string[] = ['// nav fixture B：中转标签']
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
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), buildFixtureA())
  fs.writeFileSync(path.join(REPO_DIR, FILE_B), buildFixtureB())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 导航历史基线'])
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
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
}

/** 光标 1-based 行号：cursor 的 content 坐标 top / 行高（滚出视口也成立） */
async function cursorLine(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('.pane-primary .monaco-editor .cursor').first().evaluate((el) => {
    const h = parseFloat((el as HTMLElement).style.height) || 22
    return Math.round(parseFloat((el as HTMLElement).style.top) / h) + 1
  })
}

/** Ctrl+G 转行落光标（Monaco 快速输入；键盘路径确定性最好）。
 *  click=false 用于 Monaco 已持有焦点的连续跳转——点击会移动光标刷新
 *  停留计时，紧随其后的大跳会被判为路过不入栈 */
async function gotoLine(page: import('@playwright/test').Page, line: number, click = true): Promise<void> {
  if (click) {
    await page.locator('.pane-primary .monaco-editor').click({ position: { x: 250, y: 200 } })
  }
  await page.keyboard.press('Control+G')
  await page.keyboard.type(String(line))
  await page.keyboard.press('Enter')
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(line)
}

/** 光标 1-based 列号：cursor 的 content 坐标 left / 等宽字符宽（P-20261002-148
 *  列级精度断言用）。字符宽取自视口内任一纯 ASCII 行的 span 宽 ÷ 字符数
 *  （Monaco 等宽渲染，单字符 advance 恒定；夹具正文全 ASCII，剔除含 CJK 的
 *  头注释行——注意 Monaco 把空格渲染成 nbsp/U+00A0，ASCII 判定须放行），
 *  平滑光标动画由 expect.poll 收敛到落定值兜底 */
async function cursorColumn(page: import('@playwright/test').Page): Promise<number> {
  return page.locator('.pane-primary .monaco-editor .cursor').first().evaluate((el) => {
    const root = el.closest('.monaco-editor')
    const sample = root
      ? (Array.from(root.querySelectorAll('.view-line span')) as HTMLElement[]).find(
          (s) => s.getBoundingClientRect().width > 0 && /^[\x20-\x7E\u00A0]{8,}$/.test(s.textContent || ''))
      : undefined
    const text = sample?.textContent || ''
    if (!sample || text.length < 8) return 0
    return Math.round(parseFloat((el as HTMLElement).style.left) / (sample.getBoundingClientRect().width / text.length)) + 1
  })
}

/** 后退键：恢复链开文件 + 行定位为轮询异步，轮询断言到目标行 */
async function pressBack(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+Alt+ArrowLeft')
}

async function pressForward(page: import('@playwright/test').Page): Promise<void> {
  await page.keyboard.press('Control+Alt+ArrowRight')
}

test('跨文件跳转链：Quick Open 换文件后后退回原行，前进返回', async ({ page }) => {
  await openProjectAndFiles(page)

  // A 激活并落 100 行（制造锚点：停留够久后的远距跳转）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  // 加载断言锚定文件头（Monaco 虚拟滚动只渲染可见行，顶部视口看不到 100 行的 MARK）
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// nav fixture A', { timeout: 8000 })
  await gotoLine(page, MARK_LINE)

  // Quick Open 开 B（跳转链：换文件入后退栈）
  await page.keyboard.press('Control+P')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(FILE_B)
  await page.locator('.palette-item').filter({ hasText: FILE_B }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toHaveClass(/active/)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
  // 点击编辑器取回焦点（Quick Open 关闭后焦点不确定），并记录 B 的离开行——前进应回到它
  await page.locator('.pane-primary .monaco-editor').click({ position: { x: 250, y: 150 } })
  const bLine = await cursorLine(page)
  expect(bLine).toBeGreaterThan(1)

  // Ctrl+Alt+← 后退：回 A 且行号回到 100 附近
  await pressBack(page)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(MARK_LINE)

  // Ctrl+Alt+→ 前进：回 B 且光标回到离开时的行
  await pressForward(page)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(bLine)
})

test('后退目标已关闭：重开并落回原行', async ({ page }) => {
  await openProjectAndFiles(page)

  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// nav fixture A', { timeout: 8000 })
  await gotoLine(page, MARK_LINE)

  // 切到 B（A 的 100 行入后退栈）再关闭 A
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('b-marker-3', { timeout: 8000 })
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveCount(0)

  // 后退：A 已关 → 重开并恢复 100 行（model 随关闭销毁，viewState 缓存已清，
  // 行号只能来自导航历史自身的定位链）
  await page.locator('.pane-primary .monaco-editor').click({ position: { x: 250, y: 150 } })
  await pressBack(page)
  const aTab = page.locator('.pane-primary .editor-tab', { hasText: FILE_A })
  await expect(aTab).toBeVisible({ timeout: 8000 })
  await expect(aTab).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(MARK_LINE)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(`MARK-A-${MARK_LINE}`, { timeout: 8000 })
})

test('同文件远距跳转可后退/前进；前进空栈按键无副作用', async ({ page }) => {
  await openProjectAndFiles(page)

  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('// nav fixture A', { timeout: 8000 })
  await gotoLine(page, 10)

  // 前进栈为空：按键不切 tab、不报错
  await pressForward(page)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(10)

  // 制造离开列（P-20261002-148 列级精度）：Home 归零后 9 次 → 光标落 10 行 10 列
  await page.keyboard.press('Home')
  for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight')

  // 驻留 10 行 600ms 后连续 Ctrl+G：10→100 锚定 {A,10,col10}；驻留后 100→200 锚定 {A,100,col1}
  await page.waitForTimeout(600)
  await gotoLine(page, MARK_LINE, false)
  await page.waitForTimeout(600)
  await gotoLine(page, 200, false)

  // 后退依次回 100、10（更早的打开序列锚点仍在更深处，不触发）
  await pressBack(page)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(MARK_LINE)
  await pressBack(page)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(10)

  // 列级精度（P-20261002-148 增量）：后退落位列 = 离开列 10——离开前 Home 归零
  // 后 9 次右移把光标停在 10 列，恢复链经 handleSearchOpenFile 的 col 形参
  // setPosition 落回同一列（等宽字符宽校准 DOM 测列，免键入改内容保 repeat 幂等）
  await expect.poll(() => cursorColumn(page), { timeout: 5000 }).toBe(10)

  // 前进镜像回放：10 → 100 → 200
  await pressForward(page)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(MARK_LINE)
  await pressForward(page)
  await expect.poll(() => cursorLine(page), { timeout: 5000 }).toBe(200)
})
