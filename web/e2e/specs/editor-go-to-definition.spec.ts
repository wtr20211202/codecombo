import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器跨文件跳转 E2E（P-20261004-45 TS 项目上下文按需注入）：
 *   1. A import B、B 未打开 → 光标落在使用行 `helper()` 上 F12 → 目标文件经
 *      OPS_OPEN_FILE_AT 既有打开链作为 tab 打开并定位到定义行（注入即打开语义）
 *   2. 裸包名 F12 维持原「找不到定义」不误开（MVP 诚实边界锚）
 *   3. Shift+F12 references：零结果注入后 peek 列出跨文件条目，点选跨文件条目
 *      同链路开 tab
 * 自备临时仓库，afterAll 清理（项目/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-go-to-definition')
const PROJ = 'e2e-go-to-definition'
const MAIN_FILE = 'src/main.ts'
// 定义行=4（F12 定位断言锚：cursor top = 8px 容器顶距 + 3 行 × 21px 行高 = 71px；
// 行高 P-20261006-7 起生效值 = round(缺省字号 14 × 缺省倍率 1.5) = 21px，原硬编码 22）
const HELPER_FILE = 'src/util/helper.ts'
const MAIN_CONTENT = [
  "import { helper } from './util/helper'",
  '',
  'export function run() {',
  '  helper()',
  '}',
  '',
  "import { ghost } from 'ghost-never-exists'",
  '',
  'export function needGhost() {',
  '  return ghost',
  '}',
  '',
].join('\n')
const HELPER_CONTENT = [
  '/** helper 说明 */',
  'const VERSION = 42',
  '',
  'export function helper() {',
  '  return VERSION',
  '}',
  '',
].join('\n')

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function registerProject(): Promise<void> {
  const res = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(res.status)
}

async function cleanupProject(): Promise<void> {
  const list = await api('GET', '/api/projects')
  for (const p of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await api('DELETE', `/api/projects/${p.id}`)
  }
}

async function cleanupRepo(): Promise<void> {
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

/** 树行精确匹配（editor-locate-tree 同款：item-name 全等，防 src 撞 src/util） */
function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 树行点击（自愈重试）：boot 布局恢复异步落地会把面板 v-show 藏掉——每次
 *  尝试前先归一面板可见（rail-files toggle 语义）再点（editor-locate-tree 同款） */
async function clickTreeItem(page: Page, loc: import('@playwright/test').Locator, attempts = 8) {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (!(await page.locator('.file-tree .item-name').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="rail-files"]').click().catch(() => {})
      await page.waitForTimeout(600)
    }
    try { await loc.click({ timeout: 2000 }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
  }
  throw lastErr
}

/** 展开 src 目录（幂等：树展开表随 uiState 跨用例持久——已展开时再点会收起） */
async function ensureSrcExpanded(page: Page): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await itemByName(page, 'main.ts').isVisible().catch(() => false)) return
    await clickTreeItem(page, itemByName(page, 'src'))
    await page.waitForTimeout(500)
  }
  await expect(itemByName(page, 'main.ts')).toBeVisible({ timeout: 8000 })
}

async function openMainFile(page: Page): Promise<void> {
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await ensureSrcExpanded(page)
  await clickTreeItem(page, itemByName(page, 'main.ts'))
  await expect(page.locator('.editor-tab', { hasText: 'main.ts' })).toBeVisible({ timeout: 8000 })
}

/** 光标从文档首导航到 line 行 column 列（键盘导航，落点确定） */
async function moveCursor(page: Page, line: number, column: number): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
  for (let i = 1; i < line; i++) await page.keyboard.press('ArrowDown')
  for (let i = 1; i < column; i++) await page.keyboard.press('ArrowRight')
}

test.beforeAll(async () => {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  await cleanupProject()
  await cleanupRepo()
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'util'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, MAIN_FILE), MAIN_CONTENT)
  fs.writeFileSync(path.join(REPO_DIR, HELPER_FILE), HELPER_CONTENT)
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync('git', ['commit', '-m', 'root: 跨文件跳转夹具'], { cwd: REPO_DIR })
  await registerProject()
})

test.afterAll(async () => {
  await cleanupProject()
  await cleanupRepo()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ local: null }),
  })
})

test('A import B 未打开：使用行 F12 → B 打开为 tab 并定位定义行', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openMainFile(page)
  // 只有 main.ts 一个 tab：B 尚未打开
  expect(await page.locator('.editor-tab').count()).toBe(1)

  // 光标落使用行 `  helper()` 的 helper 词上（行4列5）
  await moveCursor(page, 4, 5)
  await page.keyboard.press('F12')

  // 注入即打开：helper.ts 成为 tab（打开链 readFile→openFileByPath→预览位）
  const helperTab = page.locator('.editor-tab', { hasText: 'helper.ts' })
  await expect(helperTab).toBeVisible({ timeout: 15000 })
  // 编辑器内容切到 helper.ts
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText('export function helper', { timeout: 10000 })
  // 定位定义行（第 4 行）：光标竖直位置 = 8px 顶距 + (4-1)×21px 行高（短文件
  // 居中 reveal 不产生滚动；行高 21 = P-20261006-7 的 round(14×1.5) 缺省生效值）。
  // 光标平滑动画（cursorSmoothCaretAnimation）有过渡帧
  // ——poll 到稳定终值再断言
  await expect.poll(async () =>
    page.locator('.monaco-editor .cursor').first().evaluate((el) => Number.parseFloat(getComputedStyle(el).top)),
  { timeout: 5000 }).toBe(71)
})

test('裸包名 F12 维持原「找不到」不误开', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openMainFile(page)
  expect(await page.locator('.editor-tab').count()).toBe(1)

  // 光标落裸包名导入子句的 ghost 词上（行7列10）
  await moveCursor(page, 7, 10)
  await page.keyboard.press('F12')
  // 等过注入重试窗口（provider 内部 ~1s 封顶）后仍无新 tab：不误开
  await page.waitForTimeout(2500)
  expect(await page.locator('.editor-tab').count()).toBe(1)
  await expect(page.locator('.editor-tab', { hasText: 'helper.ts' })).toHaveCount(0)
  // 编辑器仍显示 main.ts
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText("import { ghost } from 'ghost-never-exists'")
})

test('Shift+F12 references：零结果注入后 peek 列出跨文件条目，点选开 tab', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openMainFile(page)
  await moveCursor(page, 4, 5)
  await page.keyboard.press('Shift+F12')

  // peek 引用浮层出现（helper.ts 声明 + main.ts 使用/导入）
  const peek = page.locator('.zone-widget.reference-zone-widget, .zone-widget', { hasText: 'helper' }).first()
  await expect(peek).toBeVisible({ timeout: 15000 })
  // 跨文件条目在列：helper.ts 文件行（默认折叠，点击展开出声明叶行）
  const fileRow = peek.locator('.monaco-list-row', { hasText: 'helper.ts' }).first()
  await expect(fileRow).toBeVisible({ timeout: 10000 })
  await fileRow.click()
  // 声明叶行（行内容预览自引用列起，形如「function helper() {」）展开可见后
  // 双击打开（peek 单击=预览、双击=打开）→ 经跳转路由开 tab
  const declarationRow = peek.locator('.monaco-list-row', { hasText: 'function helper()' }).first()
  await expect(declarationRow).toBeVisible({ timeout: 10000 })
  await declarationRow.dblclick()
  await expect(page.locator('.editor-tab', { hasText: 'helper.ts' })).toBeVisible({ timeout: 10000 })
})
