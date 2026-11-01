import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器行高倍率 E2E（P-20261006-7，对标 VS Code editor.lineHeight）：
 * lineHeight 不再硬编码 22，生效行高 = 生效字号 × 倍率（缺省 1.5 ≈ 22px/14px
 * 既有观感）。断言锚 = Monaco 渲染行节点的内联 line-height（FastDomNode
 * setLineHeight 直写 style.lineHeight，等价 editor option 语义，不碰像素内幕）：
 *   ① 缺省观感：默认倍率 1.5、字号 14 → 行高 21px
 *   ② 反应式路径：设置·外观「行高」切 2.0 → 已打开的编辑器即时 28px；
 *      localStorage font-settings 落盘，刷新重开仍 28px（持久化）
 *   ③ 字号联动：倍率缺省下编辑器字号 14→16 → 行高联动重算 24px
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-line-height')
const PROJ = 'e2e-line-height'
const FILE = 'line-height-fixture.ts'
const CONTENT = ['line-001', 'line-002', 'line-003', 'line-004', 'line-005', ''].join('\n')

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: line height 基线'])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目并经文件树打开夹具文件，返回编辑器首条渲染行（内联 line-height 断言锚） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  const line = page.locator('.pane-primary .monaco-editor .view-line').first()
  await expect(line).toBeVisible({ timeout: 15000 })
  return line
}

/** 设置 → 外观 → 「行高」行（倍率 select，renderWhitespace 同款控件形态） */
async function lineHeightRow(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('.settings-content .slider-row', { hasText: '行高' })
  await expect(row).toBeVisible({ timeout: 3000 })
  return row
}

test('缺省倍率 1.5：字号 14 → 行高 21px（≈硬编码 22px 既有观感）', async ({ page }) => {
  const line = await openProjectAndFile(page)
  await expect(line).toHaveCSS('line-height', '21px')
})

test('切 2.0 即时生效并持久化：已开标签 28px，刷新重开仍 28px', async ({ page }) => {
  const line = await openProjectAndFile(page)
  await expect(line).toHaveCSS('line-height', '21px')

  // 编辑器行为类选项直写 store 即时生效（不参与设置弹窗脏护栏），无需重开标签
  const row = await lineHeightRow(page)
  await row.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: '2.0' }).first().click()
  await expect(row.locator('.n-select')).toContainText('2.0')
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 反应式路径：已打开的编辑器行高即时放大
  await expect(line).toHaveCSS('line-height', '28px')

  // 持久化落盘：font-settings 记录 lineHeightMultiplier: 2
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { lineHeightMultiplier?: number } }).editor?.lineHeightMultiplier).toBe(2)

  // 刷新后 tab 由 uiState 自动恢复，行高仍 2.0 档（create 路径读 editorLineHeight 出口）
  await page.reload()
  const lineAfter = page.locator('.pane-primary .monaco-editor .view-line').first()
  await expect(lineAfter).toBeVisible({ timeout: 15000 })
  await expect(lineAfter).toHaveCSS('line-height', '28px')
})

test('字号变更联动重算：倍率缺省 1.5 下编辑器字号 14→16 → 行高 24px', async ({ page }) => {
  const line = await openProjectAndFile(page)
  await expect(line).toHaveCSS('line-height', '21px')

  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  // 字体大小分区「编辑器」滑条（layout.editorFont）：range input 走原生 input 事件
  const slider = page.locator('.settings-content .font-sliders .slider-row', { hasText: '编辑器' }).locator('input[type="range"]')
  await expect(slider).toBeVisible({ timeout: 3000 })
  await slider.evaluate((el) => {
    el.value = '16'
    el.dispatchEvent(new Event('input'))
  })
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 行高 = round(16 × 1.5) = 24：字号联动链（editorLineHeight 出口）随动
  await expect(line).toHaveCSS('line-height', '24px')
})
