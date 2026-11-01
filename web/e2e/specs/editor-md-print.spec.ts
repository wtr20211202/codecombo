import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * md 预览打印 / 导出 PDF E2E（P-20261003-244）：
 *   ① 打印按钮触发 window.print 且打印标记类在位（<html> md-printing + 本组
 *      md-printing-pane）；afterprint（打印窗关闭，含取消）摘除标记
 *   ② @media print 样式经标记类门控：无标记时打印介质下 chrome 原样（浏览器
 *      Ctrl+P 原生路径零变化）；有标记时去 chrome（顶栏/状态栏/底栏/页签条/
 *      模式条/源码侧隐藏，仅预览容器）+ 亮色翻转（--text-primary 落到打印色）
 *   ③ 按钮显隐：预览可见（split/preview 态）才渲染；源码态与非 md 文件无
 * 自备临时仓库，afterAll 清理并复位 uiState（editorPrefs 是服务端跨用例全局
 * 状态——beforeAll 先清保证「无记录默认 split」基线确定性）。
 * window.print 用页内 stub 断言（真实调用会阻塞用例等打印对话框，不可控；
 * afterprint 经显式 dispatch 模拟打印窗关闭）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-md-print')
const PROJ = 'e2e-md-print'
const README_FILE = 'README.md'
const NOTES_FILE = 'notes.txt'
const README_CONTENT = [
  '# 打印导出验证',
  '',
  '正文段落，用于打印样式断言。',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
].join('\n')
const NOTES_CONTENT = 'const plain = 1 // 非 md 文件无预览工具条\n'

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
  // uiState 复位（含 editorPrefs）：残留的 md 模式偏好会破坏「默认 split」基线
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
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
  fs.writeFileSync(path.join(REPO_DIR, README_FILE), README_CONTENT)
  fs.writeFileSync(path.join(REPO_DIR, NOTES_FILE), NOTES_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: md 预览打印基线'])
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
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 从首页进项目并经文件树打开 md 文件（默认 split 模式，预览可见） */
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
  if (file.endsWith('.md')) {
    await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 10000 })
    // 模式归一化：uiState editorPrefs 跨用例/跨 spec 持久（残留 source/preview
    // 偏好会让预览不可见），断言前显式归一到 split（预览可见基线）
    const bar = page.locator('.pane-primary .md-mode-bar')
    if (await bar.isVisible().catch(() => false)) {
      await bar.locator('.md-mode-btn').filter({ hasText: /^源码\+预览$/ }).click()
    }
    await expect(page.locator('.pane-primary .md-preview')).toBeVisible({ timeout: 10000 })
  } else {
    await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 10000 })
  }
}

/** window.print 页内 stub：记录调用次数与调用瞬间打印标记类是否在位 */
async function stubWindowPrint(page: import('@playwright/test').Page) {
  await page.evaluate(() => {
    const w = window as unknown as {
      __printCalls?: number
      __printHadHtmlMark?: boolean
      __printHadPaneMark?: boolean
    }
    w.__printCalls = 0
    w.__printHadHtmlMark = false
    w.__printHadPaneMark = false
    window.print = () => {
      w.__printCalls = (w.__printCalls || 0) + 1
      w.__printHadHtmlMark = document.documentElement.classList.contains('md-printing')
      w.__printHadPaneMark = document.querySelector('.editor-pane.md-printing-pane') !== null
    }
  })
}

const printBtn = (page: import('@playwright/test').Page) => page.locator('[data-testid="md-print-btn"]')
/** 模拟打印窗关闭（真实链路里浏览器在 print 对话框关闭后派发，含取消） */
const fireAfterPrint = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('afterprint')))

test('打印按钮触发 window.print 且打印标记在位，afterprint 摘除', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await stubWindowPrint(page)

  await printBtn(page).click()
  const st = await page.evaluate(() => {
    const w = window as unknown as { __printCalls?: number; __printHadHtmlMark?: boolean; __printHadPaneMark?: boolean }
    return { calls: w.__printCalls, htmlMark: w.__printHadHtmlMark, paneMark: w.__printHadPaneMark }
  })
  expect(st.calls).toBe(1)
  // 调用瞬间标记在位（打印渲染面拿到的是「仅预览」形态）
  expect(st.htmlMark).toBe(true)
  expect(st.paneMark).toBe(true)

  // 打印窗关闭（含取消）：标记摘除，Ctrl+P 原生路径恢复
  await fireAfterPrint(page)
  const marks = await page.evaluate(() => ({
    html: document.documentElement.classList.contains('md-printing'),
    pane: document.querySelector('.editor-pane.md-printing-pane') !== null,
  }))
  expect(marks.html).toBe(false)
  expect(marks.pane).toBe(false)
})

test('@media print 样式经标记类门控：无标记 chrome 原样，有标记去 chrome + 亮色翻转', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await stubWindowPrint(page)

  // 打印介质但无标记类：chrome 原样——浏览器 Ctrl+P 不经打印按钮，行为零变化
  await page.emulateMedia({ media: 'print' })
  const headerDisplay = await page.locator('.ide-header').evaluate(el => getComputedStyle(el).display)
  expect(headerDisplay).not.toBe('none')

  // 挂标记（走真实按钮链路）：chrome 退场、仅预览容器、变量翻打印色
  await printBtn(page).click()
  await expect(page.locator('.ide-header')).toHaveCSS('display', 'none')
  for (const sel of ['.status-bar', '.bottom-panel', '.editor-tabs-row', '.md-mode-bar', '.editor-with-blame']) {
    await expect(page.locator(sel).first()).toHaveCSS('display', 'none')
  }
  // 预览容器成为打印主体：滚动约束放开 + 亮色（--text-primary 打印值 #1f2328）
  await expect(page.locator('.pane-primary .md-preview')).toHaveCSS('overflow', 'visible')
  await expect(page.locator('.pane-primary .md-preview')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.locator('.pane-primary .md-preview-content')).toHaveCSS('color', 'rgb(31, 35, 40)')

  await fireAfterPrint(page)
  // 标记摘除后同一打印介质下 chrome 回归
  await expect(page.locator('.ide-header')).not.toHaveCSS('display', 'none')
  await page.emulateMedia({ media: null })
})

test('打印按钮显隐：预览可见（split/preview）才渲染，源码态与非 md 文件无', async ({ page }) => {
  await openProjectAndFile(page, README_FILE)
  await expect(printBtn(page)).toBeVisible()

  // 源码态：无预览渲染内容，打印按钮退场（精确匹配「源码」——hasText 子串会
  // 双中「源码+预览」；首钮恒为 source，与 DOM 序互为双保险）
  await page.locator('.pane-primary .md-mode-bar .md-mode-btn').first().filter({ hasText: /^源码$/ }).click()
  await expect(printBtn(page)).toHaveCount(0)

  // 非 md 文件：整个 md 模式条不存在
  await openProjectAndFile(page, NOTES_FILE)
  await expect(page.locator('.pane-primary .md-mode-bar')).toHaveCount(0)
  await expect(printBtn(page)).toHaveCount(0)
})
