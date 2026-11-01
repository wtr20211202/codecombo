import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 线性切换 E2E（P-20261002-135）：Ctrl+PgUp/PgDn 在活跃组内按序
 * 切换上一/下一标签（activeFileIndex ±1 环绕，与 Ctrl+Tab 循环分工）——
 *   ① 3 个 tab 线性行走：PgDn 依序下一个、PgUp 依序上一个原路返回
 *   ② 首尾环绕：末尾 PgDn 回到首个、首个 PgUp 回到末尾
 *   ③ 快捷键备忘单编辑器组条目（键帽取 keymap 实时生效值）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-linear-switch')
const PROJ = 'e2e-tab-linear-switch'
const FILES = [
  { name: 'linear-a.txt', content: 'linear alpha content' },
  { name: 'linear-b.txt', content: 'linear beta content' },
  { name: 'linear-c.txt', content: 'linear gamma content' },
]

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
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 线性切换基线'])
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

/** 打开项目并经文件树按序打开全部 3 个文件（幂等：已开的只会被激活） */
async function openProjectAndAllFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toBeVisible()
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
}

test('Ctrl+PgDn/PgUp 活跃组线性行走：依序下一标签、原路返回', async ({ page }) => {
  await openProjectAndAllFiles(page)

  const aTab = page.locator('.editor-tab', { hasText: FILES[0]!.name })
  const bTab = page.locator('.editor-tab', { hasText: FILES[1]!.name })
  const cTab = page.locator('.editor-tab', { hasText: FILES[2]!.name })
  // 打开序 a,b,c 激活 c；点首个标签把焦点移出 Monaco 隐藏 textarea（同 reopen
  // spec 惯例：全局键不在 Monaco 隐藏输入区上断言），从 a 开始线性行走
  await aTab.click()

  // PgDn 依序下一个：a → b → c
  await page.keyboard.press('Control+PageDown')
  await expect(bTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  await page.keyboard.press('Control+PageDown')
  await expect(cTab).toHaveClass(/active/)

  // PgUp 依序上一个：c → b → a 原路返回
  await page.keyboard.press('Control+PageUp')
  await expect(bTab).toHaveClass(/active/)
  await page.keyboard.press('Control+PageUp')
  await expect(aTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })
})

test('Ctrl+PgDn/PgUp 首尾环绕：末尾 PgDn 回首个、首个 PgUp 回末尾', async ({ page }) => {
  await openProjectAndAllFiles(page)

  const aTab = page.locator('.editor-tab', { hasText: FILES[0]!.name })
  const cTab = page.locator('.editor-tab', { hasText: FILES[2]!.name })
  // 焦点移出 Monaco 隐藏 textarea（同上例惯例）
  await cTab.click()

  // 末尾 c：PgDn 环绕回首个 a（±1 环绕语义，区别于到头停住的纯线性）
  await page.keyboard.press('Control+PageDown')
  await expect(aTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })

  // 首个 a：PgUp 环绕回末尾 c
  await page.keyboard.press('Control+PageUp')
  await expect(cTab).toHaveClass(/active/)
})

test('快捷键备忘单：编辑器组线性切换条目展示键帽', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // ? 单键不对输入框焦点响应：先点标签移出 Monaco 隐藏 textarea
  await page.locator('.editor-tab', { hasText: FILES[0]!.name }).click()
  await page.keyboard.press('?')

  const prevRow = page.locator('.sc-help-row').filter({ hasText: '切换上一个编辑器标签' })
  await expect(prevRow).toBeVisible()
  await expect(prevRow.locator('kbd')).toHaveText(['Ctrl', 'PageUp'])
  const nextRow = page.locator('.sc-help-row').filter({ hasText: '切换下一个编辑器标签' })
  await expect(nextRow).toBeVisible()
  await expect(nextRow.locator('kbd')).toHaveText(['Ctrl', 'PageDown'])

  await page.locator('.sc-help-close').click()
})
