import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * agent 会话以 prompt 摘要命名（P-20261003-12）E2E：
 *   1. 带 prompt 创建（编辑器「就此文件询问智能体」链路）→ 服务端以 prompt
 *      首行派生会话名（>24 rune 截断加省略号），侧栏显示摘要名而非序号默认名
 *   2. 显式命名（新建对话框填会话名）→ 名字不被覆盖（req.Name 优先级不变）
 *   3. 未带 prompt 且未命名（新建对话框留空）→ 维持序号默认名（终端 N，
 *      locale zh-CN；跨实例外部会话可混入计数，断言形态不断言具体序号）
 * 派生发生在服务端 LaunchAgentSession（HTTP 与定时任务链共用核心；定时任务
 * 显式传任务名不被覆盖由 agent-cron.spec 的 name===任务名断言守卫）。派生名
 * 期望值从拦截到的 create 请求体 launchArgs 现算——与 locale 文案/行号变体
 * 解耦，断言的是服务端对真实 prompt 的派生产物。自备临时仓库，afterEach
 * 清理全部终端会话，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-session-name')
const PROJ_NAME = 'e2e-agent-session-name'
// 长文件名：prompt 首行必超 24 rune，验证截断加省略号
const FILE = 'very-long-filename-for-session-name-truncation.ts'
const EXPLICIT_NAME = 'e2e-显式命名不受影响'

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  // 文件在仓库根（文件树默认不展开子目录，嵌套路径会让行节点不可见）
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'export function hello(): string {\n  return "hello"\n}\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add long-named file'])

  // 注册项目：本地路径交服务端一律 serverPath() 包裹（跨拓扑双路径口径）
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** 进项目页并打开夹具文件（editor-git-tools 同款就绪等待/重试口径） */
async function openFile(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免上例的 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // 树加载就绪：加载指示消失且首个条目可见（而非盲目固定等待）
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 工具栏轮询重渲染会让元素瞬时失效：点击一律带重试
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await clickRetry(page.getByText(FILE).first(), 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

/** prompt 首行的服务端派生名期望值：与 LaunchAgentSession 同规则（≤24 rune
 *  截断加省略号）；调用方只传单行首行 */
function expectedDerivedName(firstLine: string): string {
  const runes = [...firstLine]
  return runes.length > 24 ? runes.slice(0, 24).join('') + '…' : firstLine
}

test('带 prompt 创建：会话名 = prompt 首行摘要（截断加省略号），非序号名', async ({ page, request }) => {
  await openFile(page)
  const tab = page.locator('.editor-tab').filter({ hasText: FILE })
  await expect(tab).toBeVisible()

  // 拦截创建请求：期望名从真实 launchArgs 首行现算（与 locale 文案/行号变体解耦）
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: '就此文件询问智能体' }).click()
  const body = (await createReq).postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  const promptFirstLine = (body.launchArgs || '').split('\n')[0]
  expect([...promptFirstLine].length, '夹具文件名应使首行超 24 rune（触发截断分支）').toBeGreaterThan(24)
  const expected = expectedDerivedName(promptFirstLine)

  // 服务端创建响应：会话名 = 摘要名（非「终端 N/Terminal N」序号名）
  const resp = await (await createReq).response()
  const created = (await resp.json()) as { data?: { name?: string } }
  expect(created.data?.name).toBe(expected)

  // docked 侧栏行显示摘要名
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item').filter({ hasText: expected }).first()).toBeVisible({ timeout: 15000 })

  // 服务端会话表复核：本夹具目录的 agent 会话名 = 摘要名
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { kind?: string; path?: string; name?: string }[] }).data || []
  const mine = list.find(s => s.kind === 'agent' && s.path === serverPath(REPO_DIR))
  expect(mine?.name, '服务端会话表里的名字 = prompt 摘要').toBe(expected)
})

/** 进项目页并打开 docked 管理页（活动栏入口；活动栏在 Layout，home 无此钮） */
async function openAgentDocked(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免上例的 docked 管理页残留态影响入口点击
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

test('显式命名不受影响：对话框填会话名 → 名字原样保留', async ({ page, request }) => {
  const view = await openAgentDocked(page)

  // 头部「新建会话」→ 对话框填显式名（运行时留 auto、目录填夹具便于辨识）
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input').fill(EXPLICIT_NAME)
  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(REPO_DIR)
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  // 服务端创建响应：显式名不被覆盖（req.Name 优先级不变）
  const resp = await (await createReq).response()
  const created = (await resp.json()) as { data?: { name?: string } }
  expect(created.data?.name).toBe(EXPLICIT_NAME)
  await expect(view.locator('.ats-item').filter({ hasText: EXPLICIT_NAME }).first()).toBeVisible({ timeout: 15000 })
})

test('未带 prompt 且未命名：维持序号默认名（终端 N 形态）', async ({ page }) => {
  const view = await openAgentDocked(page)

  // 对话框会话名留空、不带 prompt：请求体无 launchArgs → 不派生，序号默认名
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await view.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(REPO_DIR)
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  expect(body.launchArgs, '对话框创建不带 prompt').toBeUndefined()
  const resp = await (await createReq).response()
  const created = (await resp.json()) as { data?: { name?: string } }
  // 序号 = 同槽位现存 agent 会话数 + 1（并行实例的外部会话可混入计数）：
  // 断言默认名形态而非具体序号
  expect(created.data?.name).toMatch(/^(终端|Terminal) \d+$/)
})
