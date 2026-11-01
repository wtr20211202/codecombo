import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Markdown 模式快捷键与偏好记忆 E2E（P-20261003-18）：
 *   ① Ctrl+Shift+M 三态循环 split→source→preview→split（md-mode-bar 活跃按钮
 *      与预览面板显隐随动）
 *   ② 非 md 文件不响应（无模式栏，按键不产生任何视图变化——veto 放行不拦截）
 *   ③ 偏好记忆：切到 preview 后刷新重开同一 .md 恢复 preview（无记录时保留
 *      split 默认，原「每次打开强制重置 split」仅在无记录时生效）
 * 自备临时仓库，afterAll 清理并复位 uiState（editorPrefs 是服务端跨用例全局
 * 状态——beforeAll 先清保证「无记录」基线确定性）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-md-mode')
const PROJ = 'e2e-md-mode'
const MD_FILE = 'notes.md'
const TXT_FILE = 'plain.txt'
const MD_CONTENT = '# 模式标题\n\n正文段落，用于预览断言。\n'
const TXT_CONTENT = 'plain text content\n'

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
  // uiState 复位（含 editorPrefs）：偏好是服务端跨用例/跨运行全局状态，
  // 残留的 preview 记录会破坏用例①「无记录默认 split」基线
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
  fs.writeFileSync(path.join(REPO_DIR, MD_FILE), MD_CONTENT)
  fs.writeFileSync(path.join(REPO_DIR, TXT_FILE), TXT_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: md 模式键位基线'])
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

/** 从首页进项目并经文件树打开指定文件（幂等：已开的只会被激活） */
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
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible({ timeout: 10000 })
}

/** md 模式栏活跃按钮（fixedLocale zh：源码 / 预览 / 源码+预览） */
const activeModeBtn = (page: import('@playwright/test').Page) =>
  page.locator('.pane-primary .md-mode-bar .md-mode-btn.active')

test('md 文件 Ctrl+Shift+M 三态循环：split→source→preview→split', async ({ page }) => {
  await openProjectAndFile(page, MD_FILE)

  // 无记录基线：默认 split（源码+预览活跃，预览面板可见）——原「强制重置 split」
  // 仅在无记录时生效的语义
  await expect(page.locator('.pane-primary .md-mode-bar')).toBeVisible({ timeout: 10000 })
  await expect(activeModeBtn(page)).toHaveText('源码+预览')
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible()

  // 第 1 按：split→source（预览面板撤下，源码独占）
  await page.keyboard.press('Control+Shift+M')
  await expect(activeModeBtn(page)).toHaveText('源码')
  await expect(page.locator('.pane-primary .md-preview')).toHaveCount(0)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible()

  // 第 2 按：source→preview（源码编辑器隐藏，预览全宽）
  await page.keyboard.press('Control+Shift+M')
  await expect(activeModeBtn(page)).toHaveText('预览')
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible()
  await expect(page.locator('.pane-primary .md-preview-content')).toContainText('模式标题', { timeout: 8000 })
  await expect(page.locator('.pane-primary .monaco-container')).not.toBeVisible()

  // 第 3 按：preview→split（回到源码+预览，循环闭环）
  await page.keyboard.press('Control+Shift+M')
  await expect(activeModeBtn(page)).toHaveText('源码+预览')
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible()
})

test('非 md 文件 Ctrl+Shift+M 不响应：无模式栏，视图不变', async ({ page }) => {
  await openProjectAndFile(page, TXT_FILE)

  // 非 md 无模式栏（v-if isMarkdown），按键被 veto 放行不消费
  await expect(page.locator('.pane-primary .md-mode-bar')).toHaveCount(0)
  await page.keyboard.press('Control+Shift+M')
  await expect(page.locator('.pane-primary .md-mode-bar')).toHaveCount(0)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toBeVisible()
  await expect(page.locator('.pane-primary .md-preview')).toHaveCount(0)
})

test('偏好记忆：切 preview 后刷新重开同一 .md 恢复 preview', async ({ page }) => {
  await openProjectAndFile(page, MD_FILE)
  await expect(page.locator('.pane-primary .md-mode-bar')).toBeVisible({ timeout: 10000 })

  // 偏好即时落盘（键级补丁 setter 不等防抖，P-20261002-8 起写方法为 PATCH）：
  // 响应监听必须先于 click 挂上——PATCH 是即时单请求（无旧实现 GET 全量的
  // 前置延迟），监听晚于 click 会在 toHaveText 轮询窗口内错过响应事件
  const prefSaved = page.waitForResponse(
    (r) => r.url().includes('/api/ui-state') && r.request().method() === 'PATCH',
    { timeout: 8000 },
  )

  // 按钮直切到 preview（用户路径二：与快捷键同一 changeMdMode 持久化闭环）
  await page.locator('.pane-primary .md-mode-bar .md-mode-btn', { hasText: '预览' }).first().click()
  await expect(activeModeBtn(page)).toHaveText('预览')
  await prefSaved

  // 刷新后重进项目重开同一 md：恢复 preview 而非重置 split
  await openProjectAndFile(page, MD_FILE)
  await expect(page.locator('.pane-primary .md-mode-bar')).toBeVisible({ timeout: 10000 })
  await expect(activeModeBtn(page)).toHaveText('预览', { timeout: 8000 })
  await expect(page.locator('.pane-primary .md-preview')).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-container')).not.toBeVisible()
})
