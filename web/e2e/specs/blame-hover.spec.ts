import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * blame 悬停提交摘要卡 E2E（P-20261003-318）：
 *   1. 悬停段首徽标 → 300ms 后摘要卡出现，含 Summary 文本 + 作者 + 完整时间戳
 *   2. 悬停连续行裸 hash → 摘要卡显示所属段（同一提交）的摘要
 *   3. 移出即隐 + 回归：hover 不拦截点击，左键仍定位底部 Git 面板提交
 * 自备临时仓库（c1 时刻 3 行，c2 改首行并追加 sub 函数 3 行——当前态 blame
 * 为 c2/c1/c1/c2/c2/c2：c1 段第 2 行为段首全量徽标、第 3 行为裸 hash），
 * afterAll 清理（范式与 blame-prev 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-blame-hover')
const PROJ = 'e2e-blame-hover'
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])

  writeFile(LIB, 'export function add(a: number, b: number): number {\n  return a + b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init library'])
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  // c2 改写首行并追加 sub 函数（3 行）：当前态 blame = c2/c1/c1/c2/c2/c2，
  // c1 段第 2 行为段首（作者+日期全量徽标）、第 3 行为裸 hash 徽标
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

/** 悬停 blame 徽标并等摘要卡出现（300ms 悬停延迟） */
async function hoverAndExpectCard(page: import('@playwright/test').Page, span: import('@playwright/test').Locator, summary: string) {
  await span.hover()
  const pop = page.locator('[data-testid="blame-pop"]')
  await expect(pop).toBeVisible({ timeout: 3000 })
  await expect(pop).toContainText(summary)
  return pop
}

test('悬停段首徽标：摘要卡含 Summary + 作者 + 完整时间戳', async ({ page }) => {
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  await expect(spans.filter({ hasText: c1.slice(0, 8) }).first()).toBeVisible({ timeout: 10000 })

  // c1 段首（当前态第 2 行，作者+日期全量徽标）
  const pop = await hoverAndExpectCard(page, spans.filter({ hasText: c1.slice(0, 8) }).first(), 'c1: init library')
  await expect(pop).toContainText('e2e')
  await expect(pop.locator('.blame-pop-time')).toHaveText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  await expect(pop).toContainText(c1.slice(0, 8))
})

test('悬停连续行裸 hash：摘要卡显示所属段（同一提交）摘要', async ({ page }) => {
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  await expect(spans.filter({ hasText: c1.slice(0, 8) }).first()).toBeVisible({ timeout: 10000 })

  // c1 段裸 hash（.last() = 当前态第 3 行，无作者/日期后缀）→ 卡定位到所属段
  await hoverAndExpectCard(page, spans.filter({ hasText: c1.slice(0, 8) }).last(), 'c1: init library')
})

test('移出即隐 + hover 不拦截点击：左键仍定位提交', async ({ page }) => {
  await openLibInEditor(page)

  await page.locator('.blame-toggle-btn').click()
  const spans = blameSpans(page)
  const c2Span = spans.filter({ hasText: c2.slice(0, 8) }).last()
  await expect(c2Span).toBeVisible({ timeout: 10000 })

  // 悬停出卡 → 鼠标移到编辑器空白正文 → 卡立即隐藏
  const pop = page.locator('[data-testid="blame-pop"]')
  await hoverAndExpectCard(page, c2Span, 'c2: add2 rename + sub')
  await page.mouse.move(640, 400)
  await expect(pop).toBeHidden({ timeout: 3000 })

  // 回归：左键点击徽标仍定位底部 Git 面板对应提交（hover 只读不拦截点击）
  await c2Span.click({ timeout: 5000 })
  const selected = page.locator('.commit-item.selected').first()
  await expect(selected).toBeVisible({ timeout: 5000 })
  await expect(selected).toContainText(c2.slice(0, 8))
})
