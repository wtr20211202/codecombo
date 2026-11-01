import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 面包屑符号段 E2E（P-20261005-195）：TS 文件符号层随光标常驻显示（开文件
 * 即 alphaOne → 点进 alphaTwo 尾段跟随 → 点进类方法出双层链 AlphaGreeter/greet）
 * → 尾段下拉同层符号列表（greet/farewell，当前项高亮）→ 点 farewell 定点跳转
 * （Ln/Col 徽标落 Ln 15, Col 1 + 尾段变 farewell）。Go 文件（basic-languages 族
 * 无符号 provider）面包屑止于文件层，零空段。纯前端行为，自备临时仓库，
 * afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-symbol-crumb')
const PROJ = 'e2e-symbol-crumb'
// TS fixture：alphaOne 1-4 / alphaTwo 6-9 / AlphaGreeter 11-18（greet 12-14、
// farewell 15-17）；行号即断言面（跳转落点 Ln 15 = farewell 签名行）
const FILE_TS = 'alpha.ts'
const TS_LINES = [
  'export function alphaOne() {',
  '  const a = 1',
  '  return a',
  '}',
  '',
  'export function alphaTwo() {',
  '  const b = 2',
  '  return b',
  '}',
  '',
  'export class AlphaGreeter {',
  '  greet() {',
  "    return 'hi'",
  '  }',
  '  farewell() {',
  "    return 'bye'",
  '  }',
  '}',
]
// Go fixture：basic-languages 族无 DocumentSymbol provider，面包屑止于文件层
const FILE_GO = 'beta.go'
const GO_LINES = [
  'package beta',
  '',
  'func BetaOne() int {',
  '\treturn 1',
  '}',
  '',
  'func BetaTwo() int {',
  '\treturn 2',
  '}',
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
  fs.mkdirSync(REPO_DIR, { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, FILE_TS), TS_LINES.join('\n') + '\n')
  fs.writeFileSync(path.join(REPO_DIR, FILE_GO), GO_LINES.join('\n') + '\n')
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

test('TS 符号段随光标更新：开文件 alphaOne → alphaTwo → 类方法双层链', async ({ page }) => {
  await openFileInEditor(page, FILE_TS, 'alphaOne')
  const tail = page.locator('[data-testid="symbol-crumb-tail"]')

  // 开文件即有符号段：光标默认落第 1 行（alphaOne 签名行），首个收集完成后
  // 尾段 = alphaOne（TS worker 首转冷启，放宽超时）
  await expect(tail).toHaveText('alphaOne', { timeout: 15000 })

  // 点进 alphaTwo（第 8 行 return 语句行——注意第 7 行 const b 是 TS 导航树里
  // 的函数内局部符号，链会是 [alphaTwo, b]，VS Code 同款不滤局部符号）
  await page.locator('.monaco-editor .view-lines .view-line').nth(7).click()
  await expect(tail).toHaveText('alphaTwo', { timeout: 8000 })

  // 点进类方法 greet（第 13 行）：祖先链双层——AlphaGreeter + greet
  await page.locator('.monaco-editor .view-lines .view-line').nth(12).click()
  await expect(tail).toHaveText('greet', { timeout: 8000 })
  await expect(page.locator('.sym-crumb')).toHaveCount(2)
  await expect(page.locator('.sym-crumb').first()).toHaveText('AlphaGreeter')
})

test('尾段下拉同层跳转：点 farewell 定点落 Ln 15, Col 1，尾段跟随', async ({ page }) => {
  await openFileInEditor(page, FILE_TS, 'alphaOne')
  const tail = page.locator('[data-testid="symbol-crumb-tail"]')
  await expect(tail).toHaveText('alphaOne', { timeout: 15000 })

  // 进到 greet：下拉列同层符号（greet/farewell）
  await page.locator('.monaco-editor .view-lines .view-line').nth(12).click()
  await expect(tail).toHaveText('greet', { timeout: 8000 })
  await tail.click()
  const menu = page.locator('[data-testid="symbol-crumb-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.sym-item', { hasText: 'farewell' })).toBeVisible()
  // 当前项高亮：greet 带 .current（同层列表含尾段自身，VS Code 同形态）
  await expect(menu.locator('.sym-item.current', { hasText: 'greet' })).toBeVisible()

  // 点 farewell：定点跳转（revealLine 落签名行 15 列 1），菜单收起、尾段跟随
  await menu.locator('.sym-item', { hasText: 'farewell' }).click()
  await expect(menu).not.toBeVisible()
  await expect(page.locator('[data-testid="cursor-pos-badge"]')).toHaveText('Ln 15, Col 1', { timeout: 8000 })
  await expect(tail).toHaveText('farewell', { timeout: 8000 })
})

test('Go 文件止于文件层：无符号段（无 provider 语言零空段）', async ({ page }) => {
  await openFileInEditor(page, FILE_GO, 'package beta')

  // 路径层在（文件段），符号层不渲染：链空 = provider 缺席，不显示空段
  await expect(page.locator('.breadcrumb-scroll .crumb', { hasText: FILE_GO })).toBeVisible()
  await expect(page.locator('[data-testid="symbol-crumb-tail"]')).toHaveCount(0)
  await expect(page.locator('.sym-crumb')).toHaveCount(0)
})
