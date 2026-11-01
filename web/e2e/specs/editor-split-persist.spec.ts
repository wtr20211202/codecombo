import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 分屏组文件列表持久化 E2E（P-20261002-94）：
 *   ① 分屏开两文件 → 刷新 → 主组与分屏组文件清单、双方活跃态、焦点组全部恢复
 *   ② 删除分屏组文件再刷新 → 降级跳过（一条汇总 toast、不逐文件报错），
 *      持久化清单自愈（自愈后 GET /api/ui-state 复核）
 * 自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-split-persist')
const PROJ = 'e2e-split-persist'
const FILES = [
  { name: 'persist-a.txt', content: 'persist alpha content' },
  { name: 'persist-b.txt', content: 'persist beta content' },
  { name: 'persist-c.txt', content: 'persist gamma content' },
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
  git(REPO_DIR, ['commit', '-m', 'root: 分屏持久化基线'])
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

/** 若上次会话恢复出分屏（空态占位或带文件），先归到单组 */
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

/** 经 tab 右键把文件开进分屏组（幂等：已开只激活） */
async function openInSplitViaTab(page: import('@playwright/test').Page, fileName: string, content: string) {
  await page.locator('.pane-primary .editor-tab', { hasText: fileName }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .editor-tab', { hasText: fileName })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(content, { timeout: 8000 })
}

test('刷新恢复两组：文件清单、活跃态、焦点组全部回位', async ({ page }) => {
  await openProjectAndAllFiles(page)
  await ensureSplitClosed(page)

  // 主组基线：3 签，a 活跃
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  // 分屏组：b、c 依次开进，c 活跃（视线在分屏组）
  await openInSplitViaTab(page, FILES[1]!.name, FILES[1]!.content)
  await openInSplitViaTab(page, FILES[2]!.name, FILES[2]!.content)
  // 主组焦点回 a（焦点组不持久化，恢复后应回主组基线）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)
  await page.waitForTimeout(1800) // uiState 自动保存防抖 500ms + PUT 往返

  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible({ timeout: 15000 })
  // 主组：3 签全回，a 活跃
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(3)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })
  // 分屏组：b、c 按序回位，c 活跃且内容可见
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-split .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-split .editor-tab').nth(0)).toContainText(FILES[1]!.name)
  await expect(page.locator('.pane-split .editor-tab').nth(1)).toContainText(FILES[2]!.name)
  await expect(page.locator('.pane-split .editor-tab').nth(1)).toHaveClass(/active/)
  await expect(page.locator('.pane-split .editor-tab').nth(0)).not.toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[2]!.content, { timeout: 8000 })
  // 焦点组回主组（清单恢复属现场还原，不抢焦点）
  await expect(page.locator('.pane-primary')).toHaveClass(/pane-active/)
})

test('删除分屏组文件再刷新：降级跳过 toast + 清单自愈', async ({ page }) => {
  await openProjectAndAllFiles(page)
  await ensureSplitClosed(page)

  // b、c 依次开进分屏组（此时 c 仍在磁盘）；随后主组关掉 c——共享对象由分屏
  // 组持有，c 只留在分屏清单里，隔离主组恢复面的既有报错行为
  await openInSplitViaTab(page, FILES[1]!.name, FILES[1]!.content)
  await openInSplitViaTab(page, FILES[2]!.name, FILES[2]!.content)
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name }).locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[2]!.name })).toBeVisible()
  // 磁盘删除 c（内存 tab 保留）→ 等防抖落盘（splitFiles=[b, c]）→ 刷新
  fs.unlinkSync(path.join(REPO_DIR, FILES[2]!.name))
  await page.waitForTimeout(1800)

  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab').first()).toBeVisible({ timeout: 15000 })
  // 降级：一条汇总 toast（c 静默跳过，不逐文件弹读取错误）
  await expect(page.locator('.n-message').filter({ hasText: '1 个文件已不可用' })).toBeVisible({ timeout: 15000 })
  // 分屏组只剩 b；主组不受牵连
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[2]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  // 清单自愈：等防抖落盘后复核服务端 uiState（c 已被剔除，splitOpen 保持开）。
  // GET 响应包 { data: <instances> } 外壳（axios 客户端已解包，裸 fetch 手解）
  await page.waitForTimeout(1800)
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers: await unlockHeaders() })
  const all = (await res.json()) as { data?: Record<string, { editor?: { splitOpen?: boolean; splitFiles?: string[] } }> }
  expect(all.data?.local?.editor?.splitOpen).toBe(true)
  expect(all.data?.local?.editor?.splitFiles).toEqual([FILES[1]!.name])
})
