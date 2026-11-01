import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 分屏键盘闭环 E2E（P-20261002-93）：Ctrl+\ 开关分屏 + Ctrl+Shift+\ 切活跃组
 *   ① Ctrl+\：无分屏时以当前活跃文件开右侧分屏（与「在右侧分屏打开」同链路，
 *      共享同一 buffer——主组标签原样保留）
 *   ② Ctrl+Shift+\：活跃组 0<->1 互切（pane-active 在两组间移动）；未分屏 no-op
 *   ③ 再按 Ctrl+\ 关闭分屏（分屏组文件并回主组不重复）
 *   ④ 无活跃文件（欢迎页）时 Ctrl+\ 为 no-op
 * Shift+\ 的移位字符变体（真实键盘/Playwright 上报 '|'，同 Shift+` 报 '~'）由
 * useLayoutKeyboard shiftedKeyTolerant 兜底命中——本 spec 即真实键序回归。
 * 自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-split-hotkey')
const PROJ = 'e2e-split-hotkey'
const FILE = { name: 'hotkey-a.txt', content: 'hotkey alpha content' }

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
  fs.writeFileSync(path.join(REPO_DIR, FILE.name), FILE.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 分屏键位基线'])
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

/** 打开项目并经文件树打开唯一文件（幂等：已开的只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE.name }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE.name })).toBeVisible()
}

/** 若上次会话恢复出分屏（空态占位或带文件），先归到单组（键位闭环的基线） */
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

test('Ctrl+\\ 开分屏 → Ctrl+Shift+\\ 切组 → 再 Ctrl+\\ 关：键盘闭环', async ({ page }) => {
  await openProjectAndFile(page)
  await ensureSplitClosed(page)

  // Ctrl+\：无分屏 → 以当前活跃文件开右侧分屏（共享 buffer，打开即切活跃组）
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-split')).toHaveClass(/pane-active/)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILE.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILE.content, { timeout: 8000 })
  // 主组标签原样保留（同一共享对象），主组让出 pane-active
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE.name })).toBeVisible()
  await expect(page.locator('.pane-primary')).not.toHaveClass(/pane-active/)

  // Ctrl+Shift+\：活跃组切回主组（分屏保持打开）
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)
  await expect(page.locator('.pane-split')).not.toHaveClass(/pane-active/)
  await expect(page.locator('.pane-split')).toBeVisible()

  // 再切回分屏组（0<->1 双向）
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-split')).toHaveClass(/pane-active/)

  // Ctrl+\：已分屏 → 关闭，分屏组文件并回主组不重复
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE.name })).toHaveCount(1)
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILE.content, { timeout: 8000 })
})

test('边界 no-op：未分屏切组不生效；无活跃文件 Ctrl+\\ 不开分屏', async ({ page }) => {
  await openProjectAndFile(page)
  await ensureSplitClosed(page)

  // 归零到无标签基线（前序用例/uiState 恢复可能留下打开的 tab）
  while (await page.locator('.pane-primary .editor-tab .tab-close').count() > 0) {
    await page.locator('.pane-primary .editor-tab .tab-close').first().click()
    await page.waitForTimeout(200)
  }
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0)

  // 未分屏：Ctrl+Shift+\ no-op（不把活跃组指到不可见空组）
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)

  // 无活跃文件（欢迎页）：Ctrl+\ no-op
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)

  // 开文件后：Ctrl+Shift+\ 仍 no-op（未分屏），Ctrl+\ 才开分屏
  await page.locator('.file-tree .item-name', { hasText: FILE.name }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE.name })).toBeVisible()
  await page.keyboard.press('Control+Shift+\\')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await page.keyboard.press('Control+\\')
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILE.name })).toBeVisible()
})
