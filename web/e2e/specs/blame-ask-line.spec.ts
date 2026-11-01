import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * blame 行「询问智能体此行来历」（P-20261004-40）E2E：
 *   blame 开 → 右键行注解徽标 → 菜单「询问智能体此行来历」→ 新 agent 会话
 *   创建（dir=项目根）且 launchArgs 含拼装上下文——路径+行号定位问句头、
 *   blame 元数据行（短 hash/作者/提交摘要）与该行内容（POST /api/terminals
 *   请求体直断言，agent-git-status-summary 同款截获口径）。
 * 自备临时仓库（blame-prev 同款 c1/c2 两提交：当前态 c2/c1/c1/c2/c2/c2 六行），
 * afterAll 清理项目与夹具；终端会话每例前后清空（会按设置拉起底层运行时，
 * 只断言创建链路不与 TUI 交互）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-blame-ask-line')
const PROJ = 'e2e-blame-ask-line'
const LIB = 'src/lib.ts'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：ask 发起会真实创建会话，残留会污染后续用例的请求断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

function writeFile(rel: string, content: string) {
  const p = path.join(REPO_DIR, rel)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
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
  git(REPO_DIR, ['rev-parse', 'HEAD'])

  // c2 改写首行并追加 sub 函数（3 行）：当前态 blame = c2/c1/c1/c2/c2/c2，
  // 第 4 行（sub 签名行）是 c2 段非首行徽标——右键它断言行内容与注解对位
  writeFile(LIB, 'export function add2(a: number, b: number): number {\n  return a + b\n}\nexport function sub(a: number, b: number): number {\n  return a - b\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: add2 rename + sub'])
  git(REPO_DIR, ['rev-parse', 'HEAD'])

  const res = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目开 Git 提交面板 → 选中 c2 → 右键 lib.ts「在编辑器中打开」（blame-prev 同款口径） */
async function openLibInEditor(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  const c2Short = git(REPO_DIR, ['rev-parse', 'HEAD']).slice(0, 8)
  await page.locator('.commit-item').filter({ hasText: c2Short }).first()
    .locator('.commit-meta').click()
  await expect(page.locator('.commits-right .diff-node').first()).toBeVisible({ timeout: 5000 })
  await page.locator('.commits-right .diff-node').filter({ hasText: 'lib.ts' }).first()
    .click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 10000 })
  return c2Short
}

test('blame 徽标右键「询问智能体此行来历」：会话创建（dir=项目根）且 prompt 含拼装上下文', async ({ page }) => {
  const c2Short = await openLibInEditor(page)

  // 开启 blame：c2 段徽标可见（行 1/4/5/6，段内非首行是短 hash 徽标）
  await page.locator('.blame-toggle-btn').click()
  const c2Spans = page.locator('.monaco-editor span.sc-blame-ref').filter({ hasText: c2Short })
  await expect(c2Spans.first()).toBeVisible({ timeout: 10000 })

  // 右键第 4 行徽标（DOM 序第 2 个 c2 徽标=sub 签名行；首个在行 1 可能被右上
  // 角按钮区覆盖，blame-prev 同款避让）。原生菜单被项目内菜单接管
  const menu = page.locator('.n-dropdown-menu')
  await c2Spans.nth(1).click({ button: 'right' })
  await expect(menu.getByText('看上一版', { exact: true })).toBeVisible({ timeout: 3000 })
  await expect(menu.getByText('定位提交', { exact: true })).toBeVisible()

  // 截获创建请求后点「询问智能体此行来历」，断言拼装上下文与发起链
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await menu.getByText('询问智能体此行来历', { exact: true }).click()

  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  // 定位问句头：路径 + 行号（第 4 行 = sub 签名行）
  expect(prompt.startsWith('请解释 src/lib.ts 第 4 行为什么这样写：\n')).toBe(true)
  // blame 元数据行：短 hash + 作者 + 提交摘要
  expect(prompt).toContain(`该行由提交 ${c2Short}（e2e · `)
  expect(prompt).toContain('c2: add2 rename + sub')
  // 该行内容
  expect(prompt).toContain('export function sub(a: number, b: number): number {')
  // 装配契约：总额 ≤ 服务端 launchArgs 500 字节上限
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // 发起链终点：docked 管理页打开（降级纯 shell 也开，editor-ask-agent 同口径）
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})
