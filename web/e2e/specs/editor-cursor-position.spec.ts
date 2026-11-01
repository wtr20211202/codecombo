import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Ln/Col 光标位置徽标 E2E（P-20261004-141）：Breadcrumb 槽尾徽标随光标移动
 * 即时刷新（点击第 12 行 → Ln 12）→ 选区非空追加「(N selected)」（键盘 Shift+
 * Arrow 选 3 字符）→ 点击徽标弹 Monaco 内建 gotoLine quick access（Ctrl+G 同
 * 入口）→ 切文件徽标重取落位（新文件 Ln 1、切回恢复上次行列）。纯前端行为，
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-cursor')
const PROJ = 'e2e-editor-cursor'
// 20 行 fixture：光标定位到中部行（第 12 行）验证行号跟随
const FILE_A = 'cursor-a.txt'
const A_LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1} content`)
// 第二个文件：切签刷新断言面（打开即 Ln 1, Col 1）
const FILE_B = 'cursor-b.txt'
const B_LINES = ['alpha', 'beta', 'gamma']

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
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), A_LINES.join('\n') + '\n')
  fs.writeFileSync(path.join(REPO_DIR, FILE_B), B_LINES.join('\n') + '\n')
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

/** 进项目并从文件树打开指定文件（编辑器就绪：monaco 渲染出内容） */
async function openFileInEditor(page: import('@playwright/test').Page, file: string, sample: string) {
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
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(sample, { timeout: 8000 })
}

test('光标移动徽标跟随：首开 Ln 1 → 点击第 12 行 Ln 12 → 选 3 字符追加 selected', async ({ page }) => {
  await openFileInEditor(page, FILE_A, 'line1 content')
  const badge = page.locator('[data-testid="cursor-pos-badge"]')

  // 首发即正确：编辑器挂载后不等首次光标事件，默认落位 1:1
  await expect(badge).toHaveText('Ln 1, Col 1')

  // 点击第 12 行：行号跟随（列随点击落点，不断言具体列）
  await page.locator('.monaco-editor .view-lines .view-line').nth(11).click()
  await expect(badge).toContainText('Ln 12')

  // Home 归列 1 → 精确断言 Ln 12, Col 1
  await page.keyboard.press('Home')
  await expect(badge).toHaveText('Ln 12, Col 1')

  // Shift+ArrowRight ×3 选 3 字符：追加 selected 段，光标列随选区头移动到 4
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowRight')
  await expect(badge).toContainText('(已选 3 字符)')
  await expect(badge).toContainText('Ln 12, Col 4')

  // 选区收起（左箭头）：selected 段消失回到纯位置形态
  await page.keyboard.press('ArrowLeft')
  await expect(badge).toHaveText('Ln 12, Col 1')
})

test('点击徽标弹 gotoLine quick access（Ctrl+G 同入口），Esc 关闭', async ({ page }) => {
  await openFileInEditor(page, FILE_A, 'line1 content')
  const badge = page.locator('[data-testid="cursor-pos-badge"]')
  await expect(badge).toHaveText('Ln 1, Col 1')

  // 点击徽标 → Monaco 内建 quick access 弹出（editor.action.gotoLine）
  await badge.click()
  const quickInput = page.locator('.quick-input-widget')
  await expect(quickInput).toBeVisible()
  await expect(quickInput.locator('input')).toBeVisible()

  // Esc 关闭（与 Ctrl+G 弹层同一退出语义），徽标仍在
  await page.keyboard.press('Escape')
  await expect(quickInput).not.toBeVisible()
  await expect(badge).toBeVisible()
})

test('切文件徽标重取落位：新文件 Ln 1 → 切回恢复上次行列（视图状态恢复即首发）', async ({ page }) => {
  await openFileInEditor(page, FILE_A, 'line1 content')
  const badge = page.locator('[data-testid="cursor-pos-badge"]')
  await expect(badge).toHaveText('Ln 1, Col 1')

  // A 文件落到第 12 行，随后切 B
  await page.locator('.monaco-editor .view-lines .view-line').nth(11).click()
  await page.keyboard.press('Home')
  await expect(badge).toHaveText('Ln 12, Col 1')

  await page.locator('.file-tree .item-name', { hasText: FILE_B }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('gamma', { timeout: 8000 })
  // 换签重取：setModel 后首发新落位，不残留 A 的行列
  await expect(badge).toHaveText('Ln 1, Col 1')

  // 切回 A：视图状态恢复的落位即徽标值（行 12 保持）
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('line12 content', { timeout: 8000 })
  await expect(badge).toContainText('Ln 12')
})
