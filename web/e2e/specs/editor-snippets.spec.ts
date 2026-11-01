import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器代码片段库 E2E（P-20261002-44）：
 *   1. Monaco 右键菜单注册「保存为片段 / 插入片段」两项（headless 下 Monaco 菜单
 *      点击不可驱动——失焦即关、点击落空壳 DOM，同 git-panel-features 先例——
 *      此处断言注册面；动作主体经用例 2/3 的管理分区与命令面板链路覆盖）
 *   2. SnippetManager Kind 页签分区：代码片段页签新建（kind/language 落库经 API 复核），
 *      命令片段页签不串列
 *   3. 命令面板「插入片段」：语言过滤（typescript 片段在 .py 文件不列出）+ 点选插入
 *      另一 .ts 文件后内容与片段一致
 * 自备临时仓库，afterAll 清理（项目/自建片段/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-snippets')
const PROJ = 'e2e-editor-snippets'
const TS_FILE = 'widget.ts'
const PY_FILE = 'util.py'
const INSERT_TS_FILE = 'note.ts'

const SNIP_TITLE = 'e2e-snip-widget-template'
const SNIP_LINE = "const e2eSnippetMarker = 'inserted-by-editor-snippets'"

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function registerProject(): Promise<void> {
  const res = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(res.status)
}

async function cleanupProject(): Promise<void> {
  const list = await api('GET', '/api/projects')
  for (const p of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await api('DELETE', `/api/projects/${p.id}`)
  }
}

async function cleanupSnippets(): Promise<void> {
  const list = await api('GET', '/api/snippets')
  for (const s of ((list.json?.data || []) as { id: string; title: string }[])) {
    if (s.title === SNIP_TITLE) await api('DELETE', `/api/snippets/${s.id}`)
  }
}

async function cleanupRepo(): Promise<void> {
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

/** 侧栏文件树打开文件（rail 关着时先点开；同 editor-save 的重试形态） */
async function openFile(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: name }).first().click()
  await expect(page.locator('.editor-tab', { hasText: name })).toBeVisible({ timeout: 8000 })
}

/** 命令面板 → 「插入片段」命令 → 打开选择器弹窗 */
async function openInsertPickerViaPalette(page: Page): Promise<void> {
  // 焦点须先移出 Monaco（Monaco 会吞 Ctrl+K 弦，同 editor-reopen-tab 先例）；
  // 必须点「当前激活」标签——点 first() 会切到最早打开的标签，改变语言过滤上下文
  await page.locator('.editor-tab.active').click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>插入片段')
  const item = page.locator('.palette-item').filter({ hasText: '插入片段' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('[data-testid="snippet-insert-modal"]')).toBeVisible({ timeout: 5000 })
}

test.beforeAll(async () => {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  await cleanupProject()
  await cleanupSnippets()
  await cleanupRepo()
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, TS_FILE), "const existing = 'widget-impl'\n")
  fs.writeFileSync(path.join(REPO_DIR, PY_FILE), "def greet():\n    return 'py'\n")
  fs.writeFileSync(path.join(REPO_DIR, INSERT_TS_FILE), '')
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync('git', ['commit', '-m', 'root: 编辑器片段夹具'], { cwd: REPO_DIR })
  await registerProject()
})

test.afterAll(async () => {
  await cleanupProject()
  await cleanupSnippets()
  await cleanupRepo()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ local: null }),
  })
})

test('Monaco 右键菜单注册「保存为片段 / 插入片段」两项', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, TS_FILE)
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('widget-impl', { timeout: 8000 })

  // 选中第一行（Home → Shift+End）后右键：两项注册在 Monaco 菜单里
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+End')
  await page.locator('.monaco-editor .view-lines').first().click({ button: 'right' })
  // headless 下 Monaco 菜单动作点击不可驱动（失焦即关），断言注册面（git-panel-features 先例）
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  await expect(menu.getByText('保存为片段', { exact: true })).toBeAttached()
  await expect(menu.getByText('插入片段', { exact: true })).toBeAttached()
  await page.keyboard.press('Escape')
})

test('SnippetManager 代码片段页签新建（kind/language 落库）且不串命令页签', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 设置 → 终端 → 命令片段区块
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '终端' }).click()

  // Kind 页签切到「代码片段」→ 新建（语言 typescript）
  const tabs = page.locator('[data-testid="snippet-kind-tabs"]')
  await tabs.locator('.n-tabs-tab').filter({ hasText: '代码片段' }).click()
  await page.locator('.snippet-manager').getByRole('button', { name: '新建片段' }).click()
  await page.locator('.snippet-form input').first().fill(SNIP_TITLE)
  await page.locator('.snippet-form textarea').fill(SNIP_LINE)
  await page.locator('[data-testid="snippet-form-language"] input').fill('typescript')
  await page.locator('.snippet-form').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '片段已保存' })).toBeVisible({ timeout: 5000 })

  // 代码片段页签出现该行（带语言徽标）
  const tabsAfter = page.locator('[data-testid="snippet-kind-tabs"]')
  const row = page.locator('.snippet-row').filter({ hasText: SNIP_TITLE })
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row.locator('[data-testid="snippet-row-language"]')).toHaveText('typescript')

  // 分区生效：命令片段页签下不列该片段
  await tabsAfter.locator('.n-tabs-tab').filter({ hasText: '命令片段' }).click()
  await expect(page.locator('.snippet-row').filter({ hasText: SNIP_TITLE })).toHaveCount(0)

  // API 落库形态复核：kind=code / language=typescript / 内容一致
  const list = await api('GET', '/api/snippets')
  const mine = ((list.json?.data || []) as { title: string; kind: string; language: string; command: string }[])
    .find(s => s.title === SNIP_TITLE)
  expect(mine, 'snippet persisted').toBeTruthy()
  expect(mine!.kind).toBe('code')
  expect(mine!.language).toBe('typescript')
  expect(mine!.command).toBe(SNIP_LINE)
})

test('命令面板「插入片段」：语言过滤生效 + 插入内容一致', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // .py 文件：typescript 片段被语言过滤，选择器不列出
  await openFile(page, PY_FILE)
  await openInsertPickerViaPalette(page)
  await expect(page.locator('[data-testid="snippet-insert-item"]').filter({ hasText: SNIP_TITLE })).toHaveCount(0)
  await page.keyboard.press('Escape')

  // 另开 .ts 文件：同一片段可选，点选后在光标处插入且内容一致
  await openFile(page, INSERT_TS_FILE)
  await openInsertPickerViaPalette(page)
  const entry = page.locator('[data-testid="snippet-insert-item"]').filter({ hasText: SNIP_TITLE })
  await expect(entry).toBeVisible({ timeout: 5000 })
  await entry.click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(SNIP_LINE, { timeout: 5000 })
})
