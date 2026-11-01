import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器行内路径链接 E2E（P-20261005-214）：Monaco LinkProvider 阅读态——
 *   1. README 里在册路径 ./src/app.ts:2 渲染链接装饰（Ctrl/Cmd+Click 手势），
 *      点击直达目标文件第 2 行（cursor-pos-badge Ln 2, Col 1 + 内容在场）
 *   2. 模块名（无分隔符）与不在册示意路径不误链：全文仅 1 处链接装饰，
 *      Ctrl+click 死文本不派打开链（不出现 app.ts 标签）
 * 自备临时仓库，afterAll 清理（项目/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-path-links')
const PROJ = 'e2e-path-links'
// 链接宿主：README（markdown，无内建 link provider——链接全数来自本提案 provider）
const HOST_FILE = 'README.md'
const HOST_LINES = [
  '# Links demo',
  '',
  'go: ./src/app.ts:2',
  'module: lodash-utils',
  'ghost: ./ghost/missing.ts:1',
]
// 目标文件：第 2 行为直达落点（断言面 Ln 2, Col 1）
const TARGET_FILE = 'app.ts'
const TARGET_LINES = [
  "export const app = 'entry'",
  "export const target = 'line-two'",
  "export const tail = 'tail'",
]

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
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, HOST_FILE), HOST_LINES.join('\n') + '\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', TARGET_FILE), TARGET_LINES.join('\n') + '\n')
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

test('在册路径 Ctrl+click 直达：./src/app.ts:2 → 开目标文件落 Ln 2, Col 1', async ({ page }) => {
  await openFileInEditor(page, HOST_FILE, 'Links demo')

  // 链接计算按模型版本防抖（首算含清单取数），放宽到 15s
  const link = page.locator('.monaco-editor .detected-link', { hasText: './src/app.ts' })
  await expect(link).toBeVisible({ timeout: 15000 })

  // Monaco 链接默认手势（multiCursorModifier=altKey → 触发键 Ctrl/Cmd）：
  // 按住 Ctrl 点链接 → OPS_OPEN_FILE_AT 既有链开文件 + 行定位
  await link.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText("export const target = 'line-two'", { timeout: 8000 })
  await expect(page.locator('[data-testid="cursor-pos-badge"]')).toHaveText('Ln 2, Col 1', { timeout: 8000 })
})

test('模块名与不在册示意路径不误链：全文仅 1 处装饰，Ctrl+click 死文本不开文件', async ({ page }) => {
  await openFileInEditor(page, HOST_FILE, 'Links demo')

  // 在册的 ./src/app.ts:2 唯一渲染链接；lodash-utils（无分隔符）与
  // ./ghost/missing.ts:1（不在册）保持死文本——在册校验是提案核心约束
  const link = page.locator('.monaco-editor .detected-link', { hasText: './src/app.ts' })
  await expect(link).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-editor .detected-link')).toHaveCount(1)

  // Ctrl+click 不在册路径文本：零链接可激活 → 不派打开链，编辑器仍停在 README
  const ghostLine = page.locator('.monaco-editor .view-line', { hasText: './ghost/missing.ts' })
  await ghostLine.click({ modifiers: ['ControlOrMeta'] })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('ghost: ./ghost/missing.ts:1')
  await expect(page.locator('.monaco-editor .view-lines')).not.toContainText('export const target')
})
