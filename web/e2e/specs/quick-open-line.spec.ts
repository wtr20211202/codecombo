import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Quick Open 文件名:行号直达 E2E（P-20261003-302）：
 *   - 文件模式查询 `name:80`（及 `name:80:12`）：命中条目子标题显示「→ 第 80 行」，
 *     Enter 打开并定位到锚点行（revealLineInCenter 后锚点行才会在虚拟化 view-lines
 *     里渲染——文件 120 行、锚点在 80 行，普通打开停在首屏断言不到）
 *   - 无行号后缀：不显示行提示（回归守卫）
 *   - 后缀剥离后零命中：`zzq:42` 走既有降级搜索，且行号后缀不带入检索词
 * 自备临时仓库（120 行文件），afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-quick-open-line')
const PROJ = 'e2e-quick-open-line'
const FILE = 'line-target.md'
const ANCHOR_LINE = 80
const ANCHOR = `sc-line-anchor-${ANCHOR_LINE}`
const FIRST_LINE = 'line-target first line'

function fileContent(): string {
  const lines = [FIRST_LINE]
  for (let i = 2; i <= 120; i++) {
    lines.push(i === ANCHOR_LINE ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  return lines.join('\n') + '\n'
}

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), fileContent())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: quick open 行号直达基线'])
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

/** 打开项目 + 呼出 Quick Open（文件模式） */
async function openQuickOpen(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('文件名:行号直达：name:80 打开并定位到锚点行', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill(`${FILE.replace('.md', '')}:${ANCHOR_LINE}`)

  // 命中条目子标题显示去向行
  const item = page.locator('.palette-item', { hasText: FILE })
  await expect(item).toBeVisible()
  await expect(item.locator('.palette-item-linehint')).toHaveText(`→ 第 ${ANCHOR_LINE} 行`)

  await page.keyboard.press('Enter')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  // 虚拟化渲染下锚点行可见即证明 revealLineInCenter 生效（首屏渲染不到 80 行）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})

test('name:80:12 列形态同样直达行（列号经解析链落到光标）', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill(`${FILE.replace('.md', '')}:${ANCHOR_LINE}:12`)
  const item = page.locator('.palette-item', { hasText: FILE })
  await expect(item).toBeVisible()
  await expect(item.locator('.palette-item-linehint')).toHaveText(`→ 第 ${ANCHOR_LINE} 行`)

  await page.keyboard.press('Enter')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
})

test('无行号后缀：不显示行提示，打开行为不变（回归守卫）', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill(FILE.replace('.md', ''))
  await expect(page.locator('.palette-item', { hasText: FILE })).toBeVisible()
  await expect(page.locator('.palette-item-linehint')).toHaveCount(0)

  await page.keyboard.press('Enter')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  // 普通打开停在文件顶部：首行可见即可
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(FIRST_LINE, { timeout: 15000 })
})

test('后缀剥离后零命中：降级搜索且行号不带入检索词', async ({ page }) => {
  const input = await openQuickOpen(page)
  await input.fill('zzq-no-such-file:42')
  const empty = page.locator('.palette-empty-fallback')
  await expect(empty).toBeVisible()

  await page.keyboard.press('Enter')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  // 检索词是剥离后的文件名（内容搜索里 `:42` 是位置指令不是检索词）
  await expect(card.locator('.ps-input-row input').first()).toHaveValue('zzq-no-such-file')
})
