import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器误关找回 E2E（P-20261001-10）：关闭标签入最近关闭栈 →
 *   ① 标签右键菜单「重新打开已关闭的标签」依序恢复（栈空时菜单项禁用）
 *   ② 命令面板同命令兜底（标签全部关闭后右键菜单无宿主，面板入口仍可达）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-reopen')
const PROJ = 'e2e-editor-reopen'
const FILES = [
  { name: 'reopen-a.txt', content: 'reopen alpha content' },
  { name: 'reopen-b.txt', content: 'reopen beta content' },
  { name: 'reopen-c.txt', content: 'reopen gamma content' },
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
  git(REPO_DIR, ['commit', '-m', 'root: 误关找回基线'])
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

/** 打开项目并经文件树打开全部 3 个文件（幂等：已开的只会被激活） */
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
}

test('标签右键菜单：重开已关闭标签依序恢复，栈空时菜单项禁用', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 栈空时菜单项呈禁用态（不消费点击）
  await page.locator('.editor-tab', { hasText: FILES[0]!.name }).click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: '重新打开已关闭的标签' })).toHaveAttribute('aria-disabled', 'true')
  await page.locator('.editor-tabs').click() // 点标签栏空白处收起菜单

  // 关闭 c → 右键 b → 重开 → c 恢复且激活
  await page.locator('.editor-tab', { hasText: FILES[2]!.name }).locator('.tab-close').click()
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveCount(0)
  await page.locator('.editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  const item = page.getByRole('menuitem', { name: '重新打开已关闭的标签' })
  await expect(item).toHaveAttribute('aria-disabled', 'false')
  await item.click()

  const cTab = page.locator('.editor-tab', { hasText: FILES[2]!.name })
  await expect(cTab).toBeVisible()
  await expect(cTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[2]!.content, { timeout: 8000 })
})

test('命令面板：重开命令兜底恢复连续误关的多个标签', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 连续关闭 c、b（栈序：b 在顶）；仅剩 a 的标签提供 Ctrl+K 的非 Monaco 焦点落点
  await page.locator('.editor-tab', { hasText: FILES[2]!.name }).locator('.tab-close').click()
  await page.locator('.editor-tab', { hasText: FILES[1]!.name }).locator('.tab-close').click()
  await expect(page.locator('.editor-tab', { hasText: FILES[1]!.name })).toHaveCount(0)

  await page.locator('.editor-tab', { hasText: FILES[0]!.name }).click() // 焦点移出 Monaco（Monaco 会吞 Ctrl+K 弦）
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>重新打开已关闭')
  const item = page.locator('.palette-item').filter({ hasText: '重新打开已关闭的标签' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 第一次重开恢复 b，第二次恢复 c（依序弹栈）
  const bTab = page.locator('.editor-tab', { hasText: FILES[1]!.name })
  await expect(bTab).toBeVisible()
  await expect(bTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })

  // Alt+Shift+T 同效（快捷键入口）：先点标签把焦点移出 Monaco 隐藏 textarea
  // （全局快捷键对输入框门控，与 Ctrl+W 同惯例，Monaco/xterm 的隐藏输入框不透传）
  await bTab.click()
  await page.keyboard.press('Alt+Shift+t')
  const cTab = page.locator('.editor-tab', { hasText: FILES[2]!.name })
  await expect(cTab).toBeVisible()
  await expect(cTab).toHaveClass(/active/)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FILES[2]!.content, { timeout: 8000 })
})
