import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 片段变量最小子集 E2E（P-20261006-1）：片段库存原文，插入时客户端替换
 * ${CLIPBOARD}/${DATE}/${TIME} 与 $0（utils/snippetVars）。
 *   1. 编辑器域：命令面板插含 ${DATE}/${FOO}/$0 的代码片段 → ${DATE} 当日替换、
 *      未识别 ${FOO} 原样保留、$0 从文本剔除且光标落该处（键入字符落在 $0 位即证）
 *   2. 终端域：${CLIPBOARD} 点选替换为剪贴板文本（Chromium 授予剪贴板权限）；
 *      ${DATE} 替换；$0 终端无光标概念原样保留
 * 自备临时仓库/项目/片段，afterAll 清理（项目/片段/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-snippet-vars')
const PROJ = 'e2e-snippet-vars'
const TS_FILE = 'vars.ts'
const EMPTY_TS_FILE = 'insert-vars.ts'

const CODE_SNIP_TITLE = 'e2e-code-vars'
// ${FOO} 未识别变量须原样保留；$0 为光标终位（剔除后光标落该处）
const CODE_SNIP_BODY = "const vars = { day: '${DATE}', keep: '${FOO}' }\nmount([]$0)"

// 片段标题前缀加运行戳：实例 DB 跨用例存活，避免上轮残留干扰列表定位
const RUN = Date.now().toString(36)
const TERM_VAR_TITLE = `e2e终端变量${RUN}`
const TERM_VAR_CMD = 'echo day-${DATE} keep-$0'
const TERM_CLIP_TITLE = `e2e终端剪贴板${RUN}`
const TERM_CLIP_CMD = 'echo clip-${CLIPBOARD}'
const CLIP_TEXT = 'CBTEXT'

const now = new Date()
const TODAY = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`

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
    if (s.title === CODE_SNIP_TITLE || s.title.startsWith('e2e终端变量') || s.title.startsWith('e2e终端剪贴板')) {
      await api('DELETE', `/api/snippets/${s.id}`)
    }
  }
}

async function cleanupRepo(): Promise<void> {
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

/** 侧栏文件树打开文件（rail 关着时先点开；同 editor-snippets 的重试形态） */
async function openFile(page: Page, name: string): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: name }).first().click()
  await expect(page.locator('.editor-tab', { hasText: name })).toBeVisible({ timeout: 8000 })
}

/** 命令面板 → 「插入片段」命令 → 打开选择器弹窗（同 editor-snippets 先例） */
async function openInsertPickerViaPalette(page: Page): Promise<void> {
  // 焦点须先移出 Monaco（Monaco 会吞 Ctrl+K 弦）；点「当前激活」标签保语言上下文
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

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  // 清掉历史会话防串扰，再开新终端
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  return xterm
}

async function openSnippetPanel(page: Page) {
  await page.locator('.term-toolbar button[title="命令片段"]').click()
  const panel = page.locator('.snippet-panel')
  await expect(panel).toBeVisible()
  return panel
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
  fs.writeFileSync(path.join(REPO_DIR, TS_FILE), "const existing = 'vars-impl'\n")
  fs.writeFileSync(path.join(REPO_DIR, EMPTY_TS_FILE), '')
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync('git', ['commit', '-m', 'root: 片段变量夹具'], { cwd: REPO_DIR })
  await registerProject()

  const code = await api('POST', '/api/snippets', {
    title: CODE_SNIP_TITLE, command: CODE_SNIP_BODY, kind: 'code', language: 'typescript', description: 'e2e',
  })
  expect([200, 201], `create code snippet → ${code.status}`).toContain(code.status)
  const termVar = await api('POST', '/api/snippets', { title: TERM_VAR_TITLE, command: TERM_VAR_CMD, description: 'e2e' })
  expect([200, 201]).toContain(termVar.status)
  const termClip = await api('POST', '/api/snippets', { title: TERM_CLIP_TITLE, command: TERM_CLIP_CMD, description: 'e2e' })
  expect([200, 201]).toContain(termClip.status)
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

test('编辑器：插 ${DATE} 替换当日、未识别 ${FOO} 原样、$0 剔除且光标落终位', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, EMPTY_TS_FILE)
  await openInsertPickerViaPalette(page)
  const entry = page.locator('[data-testid="snippet-insert-item"]').filter({ hasText: CODE_SNIP_TITLE })
  await expect(entry).toBeVisible({ timeout: 5000 })
  await entry.click()

  const view = page.locator('.monaco-editor .view-lines').first()
  // ${DATE} 替换为当日本地日期；未识别 ${FOO} 原样保留（宽容不炸）
  await expect(view).toContainText(`day: '${TODAY}'`, { timeout: 5000 })
  await expect(view).toContainText("keep: '${FOO}'")
  // $0 已剔除（mount([] 后无占位）；键入字符落在 $0 终位——插入后编辑器持焦，
  // 直接键入即可（无需点击坐标）
  await expect(view).toContainText('mount([])')
  await page.keyboard.type('X')
  await expect(view).toContainText('mount([X])')
})

test('终端：${CLIPBOARD} 替换剪贴板文本、${DATE} 替换当日、$0 原样保留', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  // Chromium 授予剪贴板读写（localhost 是 secure context，readText 可用）；
  // 预写已知文本，点选片段后断言替换为该文本
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ)
  const xterm = await openFreshTerminal(page)
  await xterm.click()

  // 剪贴板变量：写入已知文本 → 点选片段 → 替换为该文本
  await page.bringToFront()
  await page.evaluate((t) => navigator.clipboard.writeText(t), CLIP_TEXT)
  const panel = await openSnippetPanel(page)
  const clipItem = panel.locator('.snippet-item').filter({ hasText: TERM_CLIP_TITLE }).first()
  await expect(clipItem).toBeVisible({ timeout: 10000 })
  await clipItem.click()
  await expect(xterm).toContainText(`echo clip-${CLIP_TEXT}`, { timeout: 5000 })

  // 日期变量替换 + $0 终端无光标概念原样保留（防 shell 位置参数被误吃）
  await xterm.click()
  await page.keyboard.press('Control+c')
  const varItem = panel.locator('.snippet-item').filter({ hasText: TERM_VAR_TITLE }).first()
  await expect(varItem).toBeVisible({ timeout: 10000 })
  await varItem.click()
  await expect(xterm).toContainText(`echo day-${TODAY} keep-$0`, { timeout: 5000 })
})
