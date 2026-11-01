import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器分屏（双组 MVP）E2E（P-20261001-13）：
 *   ① tab 右键「在右侧分屏打开」→ 左右两组并排，同一文件可同时开在两组
 *   ② 两组各自切换 tab 互不影响（组内状态独立）
 *   ③ 关闭分屏 → 组 2 文件并回组 1 尾部（共享对象不重复）
 *   ④ uiState 记忆分屏开合与分屏组文件清单（P-20261002-94）：刷新后分屏组文件回位
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-split')
const PROJ = 'e2e-editor-split'
const FILES = [
  { name: 'split-a.txt', content: 'split alpha content' },
  { name: 'split-b.txt', content: 'split beta content' },
  { name: 'split-c.txt', content: 'split gamma content' },
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
  git(REPO_DIR, ['commit', '-m', 'root: 分屏基线'])
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
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name })).toBeVisible()
}

/** 若上次会话恢复出分屏（空态占位或带文件），先一键关闭归到单组 */
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

test('分屏打开两组各自切换 tab，内容互不串组', async ({ page }) => {
  await openProjectAndAllFiles(page)
  await ensureSplitClosed(page)

  // 右键 b → 在右侧分屏打开：分屏组出现，b 激活且内容可见
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-split')).toHaveClass(/pane-active/) // 打开即切活跃组
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  // 左组标签原样保留（b 是共享对象，两组各一签）
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(3)

  // 再分屏打开 c：分屏组两个标签，c 激活
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)

  // 左组切到 a：左内容变 a，右内容保持 c（组内状态独立）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[2]!.content, { timeout: 8000 })

  // 点右组编辑器区 → 活跃组切回分屏组
  await page.locator('.pane-split .monaco-editor .view-lines').click()
  await expect(page.locator('.pane-split')).toHaveClass(/pane-active/)
  await expect(page.locator('.pane-primary')).not.toHaveClass(/pane-active/)
})

test('关闭分屏：分屏组文件并回主组尾部，共享对象不重复', async ({ page }) => {
  await openProjectAndAllFiles(page)
  await ensureSplitClosed(page)

  // 归零到 [a, b]：关掉可能残留的第三个标签
  while (await page.locator('.pane-primary .editor-tab').count() > 2) {
    await page.locator('.pane-primary .editor-tab').last().locator('.tab-close').click()
    await page.waitForTimeout(200)
  }
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(2)

  // 分屏打开 a（与主组共享同一 buffer）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()

  // 关主组的 a：分屏组标签仍在（共享对象由另一组持有），且不入关闭栈语义
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()

  // 右键分屏组标签 → 关闭分屏：a 并回主组尾部，主组激活标签不变
  await page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '关闭分屏' }).click()
  await expect(page.locator('.pane-split')).toHaveCount(0)
  const tabs = page.locator('.pane-primary .editor-tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(0)).toContainText(FILES[1]!.name)
  await expect(tabs.nth(1)).toContainText(FILES[0]!.name) // 并回尾部
  await expect(tabs.nth(0)).toHaveClass(/active/) // 激活标签不因并回跳变
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
})

test('刷新恢复分屏开合与分屏组文件清单（P-20261002-94）', async ({ page }) => {
  await openProjectAndAllFiles(page)
  await ensureSplitClosed(page)

  // 开分屏 → 等防抖持久化落盘 → 刷新
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  await page.waitForTimeout(1800) // uiState 自动保存防抖 500ms + PUT 往返

  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible({ timeout: 15000 })
  // 分屏开合 + 分屏组文件清单一并恢复：b 回到分屏组（不再是空态占位）
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  // 关最后一签 → 组空即收组（关闭入口随清单恢复继续可达）
  await page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name }).locator('.tab-close').click()
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible()
})
