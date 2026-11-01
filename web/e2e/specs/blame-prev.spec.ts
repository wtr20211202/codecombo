import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * blame 上一版导航 E2E（P-20261002-65）：
 *   1. blame 徽标右键 → 菜单「看上一版」→ 以该提交父提交为 ref 重拉注解
 *      （注解面板出现「X^ 视图」面包屑，注入 hash 全为父提交段）
 *   2. 面包屑退回当前态 → 注入 hash 恢复混合段、面包屑退出
 *   3. 既有交互回归：徽标左键仍定位底部 Git 面板对应提交
 * 自备临时仓库（lib.ts 经 c1/c2 两提交：c1 时刻 3 行，c2 改首行并追加 sub
 * 函数 3 行——当前态混合段、c1 视图单段，段数断言可区分），
 * afterAll 清理（范式与 git-panel-features 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-blame-prev')
const PROJ = 'e2e-blame-prev'
const LIB = 'src/lib.ts'

let projectId = ''

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

function writeFile(rel: string, content: string) {
  const p = path.join(REPO_DIR, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

let c1 = ''
let c2 = ''

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
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])

  writeFile(LIB, 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init library'])
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  // c2 改写首行并追加 sub 函数（3 行）：c1 时刻 3 行、当前 6 行——
  // 当前态 blame = c2/c1/c1/c2/c2/c2，c1 视图 = c1 单段 3 行
  writeFile(LIB, 'export function add2(a: number, b: number): number {\n  return a + b\n}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: add2 rename + sub'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

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

/** 进项目开 Git 提交面板 → 选中 c2 → 右键 lib.ts「在编辑器中打开」 */
async function openLibInEditor(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  // 选中 c2：点 meta 行（消息区单击是展开 body，不选中）
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first()
    .locator('.commit-meta').click()
  await expect(page.locator('.commits-right .diff-node').first()).toBeVisible({ timeout: 5000 })
  await page.locator('.commits-right .diff-node').filter({ hasText: 'lib.ts' }).first()
    .click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 10000 })
}

function blameSpans(page: import('@playwright/test').Page) {
  return page.locator('.monaco-editor span.sc-blame-ref')
}

/** c2 段徽标取 .last()：当前态 c2 段在首行（全量徽标，可能被右上角按钮区
 *  覆盖）与末行（短 hash 徽标）——末行更远离遮挡区，点击稳定 */
function c2Span(page: import('@playwright/test').Page) {
  return blameSpans(page).filter({ hasText: c2.slice(0, 8) }).last()
}

/** 右键 c2 段徽标并点「看上一版」，等待进入 X^ 视图 */
async function gotoPrevView(page: import('@playwright/test').Page) {
  await c2Span(page).click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu.getByText('看上一版', { exact: true })).toBeVisible({ timeout: 3000 })
  await menu.getByText('看上一版', { exact: true }).click()
  await expect(page.locator('.blame-prev-crumb')).toContainText(
    `${c2.slice(0, 8)}^ 视图`, { timeout: 10000 },
  )
}

test('徽标右键看上一版：X^ 视图面包屑 + 注入 hash 全为父提交', async ({ page }) => {
  await openLibInEditor(page)

  // 开启 blame：当前态为 c2/c1/c2 三段（两种 hash 并存）
  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  await expect(spans.filter({ hasText: c2.slice(0, 8) }).first()).toBeVisible({ timeout: 10000 })
  await expect(spans.filter({ hasText: c1.slice(0, 8) }).first()).toBeVisible()

  // 右键 c2 段徽标 → 项目内菜单（原生菜单被接管）→ 看上一版
  await gotoPrevView(page)

  // 注解面板切到 X^ 视图：面包屑标记 + 注入 hash 全为 c1（c2 段消失）
  await expect(page.locator('.blame-prev-crumb')).toBeVisible()
  await expect(spans.filter({ hasText: c1.slice(0, 8) })).toHaveCount(3, { timeout: 10000 })
  await expect(spans.filter({ hasText: c2.slice(0, 8) })).toHaveCount(0)
})

test('面包屑退回当前态：hash 恢复混合段、面包屑退出', async ({ page }) => {
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  await expect(spans.filter({ hasText: c2.slice(0, 8) }).first()).toBeVisible({ timeout: 10000 })

  // 进入 X^ 视图后退回当前态：面包屑消失，c2 段重新出现（c2/c1/c2 三段）
  await gotoPrevView(page)
  await page.locator('.blame-prev-crumb .blame-prev-back').click()
  await expect(page.locator('.blame-prev-crumb')).toBeHidden({ timeout: 10000 })
  await expect(spans.filter({ hasText: c2.slice(0, 8) }).first()).toBeVisible({ timeout: 10000 })
  await expect(spans.filter({ hasText: c1.slice(0, 8) }).first()).toBeVisible()
})

test('既有交互回归：徽标左键仍定位底部 Git 面板对应提交', async ({ page }) => {
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  await expect(spans.first()).toBeVisible({ timeout: 10000 })

  // 左键 c2 段徽标 → 底部 Git 面板选中 c2（F3 链路不受右键菜单改动影响）
  await c2Span(page).click({ timeout: 5000 })
  const selected = page.locator('.commit-item.selected').first()
  await expect(selected).toBeVisible({ timeout: 5000 })
  await expect(selected).toContainText(c2.slice(0, 8))
})
