import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Quick Open Ctrl+Enter 分屏打开 E2E（P-20261002-106）：
 *   - 文件模式 Ctrl/Cmd+Enter：选中文件在右侧分屏组打开并关面板（「搜到即对照」一步到位）
 *   - 普通 Enter 语义不变：仍进主组（预览 tab），不开分屏
 *   - 命令模式 Ctrl+Enter 无分屏语义：照常执行命令
 *   - 底部键位提示注明修饰键（文件模式显示「Ctrl ↵ 分屏打开」，命令模式不显示）
 * 自备临时仓库（两个文件，验证「选中的那个」而非任意文件进分屏），
 * 分屏用例置于末位防 uiState splitOpen 恢复串扰前序用例，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-quick-open-split')
const PROJ = 'e2e-quick-open-split'
const FILE_A = { name: 'alpha-one.md', content: 'alpha one content for quick open split' }
const FILE_B = { name: 'alpha-two.md', content: 'alpha two content for quick open split' }

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
  fs.writeFileSync(path.join(REPO_DIR, FILE_A.name), FILE_A.content + '\n')
  fs.writeFileSync(path.join(REPO_DIR, FILE_B.name), FILE_B.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: quick open 分屏基线'])
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

/** 打开项目 + 归到单组基线 + 呼出 Quick Open（文件模式） */
async function openQuickOpen(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // 上次会话恢复出分屏（空态占位/带文件）先归单组——键位语义的基线
  if (await page.locator('.pane-split').isVisible().catch(() => false)) {
    const emptyClose = page.locator('.split-empty-close')
    if (await emptyClose.isVisible().catch(() => false)) {
      await emptyClose.click()
    } else {
      await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '关闭分屏' }).click()
    }
    await expect(page.locator('.pane-split')).toHaveCount(0)
  }
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('底部键位提示：文件模式注明 Ctrl+↵ 分屏打开，命令模式不显示', async ({ page }) => {
  const input = await openQuickOpen(page)

  // 文件模式：修饰键提示可见
  const hint = page.locator('.palette-hint')
  await expect(hint).toContainText('分屏打开')
  await expect(hint.locator('kbd').filter({ hasText: 'Ctrl' })).toHaveCount(1)

  // 命令模式：无分屏语义，提示不显示
  await input.fill('>')
  await expect(page.locator('.palette-item').first()).toBeVisible()
  await expect(hint).not.toContainText('分屏打开')

  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-card')).toHaveCount(0)
})

test('普通 Enter 仍进主组：不开分屏（回归守卫）', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill('two')
  await expect(page.locator('.palette-item', { hasText: FILE_B.name })).toBeVisible()

  await page.keyboard.press('Enter')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B.name })).toBeVisible()
  await expect(page.locator('.pane-split')).toHaveCount(0)
})

test('命令模式 Ctrl+Enter：照常执行命令，不开分屏', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill('>切换主题')
  await expect(page.locator('.palette-item').first()).toBeVisible()

  await page.keyboard.press('Control+Enter')
  // 命令被执行（面板关闭），且未触发分屏
  await expect(page.locator('.palette-card')).toHaveCount(0)
  await expect(page.locator('.pane-split')).toHaveCount(0)
})

test('文件模式 Ctrl+Enter：选中文件分屏打开 + 面板关', async ({ page }) => {
  const input = await openQuickOpen(page)
  // 查询词过滤到唯一命中：selectedIndex=0 即 FILE_A——验证「选中的那个」进分屏
  await input.fill('one')
  await expect(page.locator('.palette-item', { hasText: FILE_A.name })).toBeVisible()
  await expect(page.locator('.palette-item')).toHaveCount(1)

  await page.keyboard.press('Control+Enter')

  // 面板关 + 分屏组打开选中文件（主组不留标签：进的是分屏组而非活跃组）
  await expect(page.locator('.palette-card')).toHaveCount(0)
  const split = page.locator('.pane-split')
  await expect(split).toBeVisible()
  await expect(split).toHaveClass(/pane-active/)
  await expect(split.locator('.editor-tab', { hasText: FILE_A.name })).toHaveClass(/active/)
  await expect(split.locator('.editor-tab', { hasText: FILE_B.name })).toHaveCount(0)
  await expect(split.locator('.monaco-editor .view-lines')).toContainText(FILE_A.content, { timeout: 8000 })
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0)
})
