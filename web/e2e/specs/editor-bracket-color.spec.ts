import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 括号对彩色化开关 E2E（P-20261006-9）：
 *   ① 默认开启：TS 文件嵌套括号经 colorizedBracketPairsDecorationProvider 渲染为
 *      .bracket-highlighting-* 着色 span（彩色括号是存量行为），设置项呈勾选态
 *   ② 关闭即时生效（作用于已打开的编辑器，无需重开文件/标签）并持久化：
 *      localStorage font-settings 落盘，刷新重开仍关；再打开恢复着色
 *   ③ markdown 域差异化保持：开关开时 md 文件源码视图括号仍不着色（语言差异与
 *      开关正交组合），切回 TS 文件着色随设置恢复
 * 自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-bracket-color')
const PROJ = 'e2e-bracket-color'
const TS_FILE = 'bracket-fixture.ts'
const MD_FILE = 'bracket-notes.md'

// TS 夹具：行内三层嵌套括号（() [] 混合），着色开时多层不同色（层级 span 存在即可断言）
function buildTsFixture(): string {
  return [
    '// bracket color fixture',
    'export function outer(x: number): number {',
    '  return inner(deep([x, 2]))',
    '}',
    '',
    'function inner(v: number): number {',
    '  return v + 1',
    '}',
    '',
    'function deep(arr: number[]): number {',
    '  return arr[0] ?? 0',
    '}',
    '',
  ].join('\n')
}

// md 夹具：散文括号——markdown 语言配置定义了 () [] {} 括号对，差异化关闭时不着色
const MD_CONTENT = '# 括号注记\n\n参考 (parentheses) 与 [square brackets] 说明。\n'

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
  fs.writeFileSync(path.join(REPO_DIR, TS_FILE), buildTsFixture())
  fs.writeFileSync(path.join(REPO_DIR, MD_FILE), MD_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: bracket color 基线'])
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

/** 打开项目并经文件树打开指定文件（幂等：已开只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page, file: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: file })).toBeVisible()
}

/** 着色 span（colorizedBracketPairsDecorationProvider 的 inlineClassName，层级 0–29） */
function colorizedBrackets(page: import('@playwright/test').Page) {
  return page.locator('.pane-primary .monaco-editor .view-lines [class*="bracket-highlighting"]')
}

/** 打开设置 → 外观分区，返回括号彩色化开关行 */
async function bracketToggleRow(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('[data-testid="settings-bracket-color"]')
  await expect(row).toBeVisible({ timeout: 3000 })
  return row
}

test('默认开启：嵌套括号着色 span 在场，设置项勾选', async ({ page }) => {
  await openProjectAndFile(page, TS_FILE)

  // 着色 span 随 tokenization/bracket AST 异步出现，放宽超时
  await expect(colorizedBrackets(page).first()).toBeVisible({ timeout: 15000 })

  // 设置 → 外观：开关默认勾选
  const row = await bracketToggleRow(page)
  await expect(row.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('开关关闭即时生效并持久化：刷新重开仍关，再打开恢复着色', async ({ page }) => {
  await openProjectAndFile(page, TS_FILE)
  await expect(colorizedBrackets(page).first()).toBeVisible({ timeout: 15000 }) // 基线：默认开着色

  // 关闭开关（编辑器行为类选项直写 store 即时生效，不参与设置弹窗脏护栏）
  const row = await bracketToggleRow(page)
  await row.locator('.n-checkbox').click()
  await expect(row.locator('.n-checkbox')).not.toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 即时生效：已打开的编辑器着色 span 消失（editor 深度 watch → updateOptions）
  await expect(colorizedBrackets(page)).toHaveCount(0)

  // 持久化落盘：font-settings 记录 bracketColor:false
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { bracketColor?: boolean } }).editor?.bracketColor).toBe(false)

  // 刷新后：tab 由 uiState 自动恢复，仍关闭
  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: TS_FILE })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 15000 })
  await expect(colorizedBrackets(page)).toHaveCount(0)

  // 再打开开关：着色 span 恢复
  const row2 = await bracketToggleRow(page)
  await row2.locator('.n-checkbox').click()
  await expect(row2.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  await expect(colorizedBrackets(page).first()).toBeVisible({ timeout: 15000 })
})

test('markdown 域差异化保持：开关开时 md 源码括号不着色，切回 TS 恢复', async ({ page }) => {
  await openProjectAndFile(page, MD_FILE)

  // 默认 split 态源码编辑器在场；切源码态独占（排除预览侧干扰）。
  // 每用例独立 context，开关经默认值回「开」——md 差异化与用例间状态无关
  const sourceBtn = page.locator('.pane-primary .md-mode-bar .md-mode-btn').filter({ hasText: /^源码$/ })
  await sourceBtn.click({ timeout: 10000 })
  const viewLines = page.locator('.pane-primary .monaco-editor .view-lines')
  await expect(viewLines).toBeVisible({ timeout: 15000 })
  // 源码内容确已渲染（诚实断言：编辑器在场且有行，排除「编辑器未挂载导致 vacuous 通过」）
  await expect(viewLines).toContainText('parentheses', { timeout: 15000 })

  // 开关为开（默认），md 域差异化关闭 → 无着色 span
  await expect(colorizedBrackets(page)).toHaveCount(0)

  // 切回 TS 文件：着色随设置恢复（开关与语言差异正交组合）
  await openProjectAndFile(page, TS_FILE)
  await expect(colorizedBrackets(page).first()).toBeVisible({ timeout: 15000 })
})
