import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树右键「在此目录新建 agent 会话」（P-20261003-55）E2E：
 *   1. 右键目录 → 会话创建且 cwd=该目录（服务端会话表 + docked 侧栏 cwd 徽标可验）
 *   2. 右键子目录内文件 → 取父目录为 cwd
 *   3. 右键项目根文件 → 父目录为空串落项目根（缺省根语义）
 *   4. 定位前言（P-20261003-102）：子目录会话 launchArgs 在任务行后附
 *      「项目根/当前工作目录（相对 rel）」一行；根目录会话不含（零变化）。
 *      断言对 POST /api/terminals 请求体（agent-git-status-summary 同款口径）
 * 断言会话创建（服务端 dir 字段）与 docked 激活，不与 TUI 交互；自备临时仓库，
 * afterEach 清理全部终端会话（会话表残留会污染计数），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-dir-agent')
const PROJ_NAME = 'e2e-dir-agent'
const SUB_DIR = 'packages'
const SUB_FILE = 'inner.ts'
const ROOT_FILE = 'README.md'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
// 目录会话任务模板首行（launchArgs 断言事实源，agentTerminal.dirAsk.prompt zh）
const DIR_PROMPT = '请先熟悉当前目录的代码结构，然后等待我的具体任务。'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 服务端 agent 会话表（kind=agent 的 id/path 清单） */
async function agentSessions(request: APIRequestContext): Promise<{ id: string; path?: string }[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  return list.filter(s => s.kind === 'agent')
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, SUB_DIR), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, ROOT_FILE), '# demo\n')
  fs.writeFileSync(path.join(REPO_DIR, SUB_DIR, SUB_FILE), `export const inner = 1\n`)
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: fixture'])

  // 注册项目：本地路径交服务端一律 serverPath() 包裹（跨拓扑双路径口径）
  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并等文件树就绪（editor-ask-agent 同款就绪等待/点击重试口径） */
async function openProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住文件树
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 工具栏轮询重渲染会让元素瞬时失效：右键一律带重试
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout, button: 'right' }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  return { clickRetry }
}

/** 断言会话动作结果：docked 管理页出现、恰好一个会话且激活、侧栏 cwd 徽标
 *  显示目标目录尾段（cwdTag 语义）、服务端会话表该会话 dir=预期路径 */
async function expectDirSession(page: Page, request: APIRequestContext, expectedDir: string, cwdBadge: string) {
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)
  // tab/侧栏 tooltip 可验面：cwd 徽标尾段（title 沿 agentTerminal.cwdTip 完整目录）
  await expect(view.locator('.ats-item-cwd')).toHaveText(cwdBadge, { timeout: 15000 })

  const agents = await agentSessions(request)
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0].path, '会话工作目录 = 目标目录').toBe(serverPath(expectedDir))
}

/** 右键目标行并点菜单项，返回创建请求 promise（launchArgs 断言事实源——
 *  等待必须先于触发点击挂上，agent-git-status-summary 同款口径）：文件树右键
 *  菜单是 NDropdown（无 role=menuitem，editor-ask-agent 的 getByRole 口径不
 *  适用），走 file-tree-context 同款 .n-dropdown-menu + 文本定位 */
async function openDirAgentMenu(page: Page, row: import('@playwright/test').Locator, clickRetry: (loc: import('@playwright/test').Locator, timeout?: number, attempts?: number) => Promise<void>) {
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await clickRetry(row.first())
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible({ timeout: 10000 })
  await menu.getByText('在此目录新建 agent 会话', { exact: true }).click()
  return createReq
}

/** 目录会话创建请求体（kind=agent 断言 + launchArgs 事实源） */
async function createBody(createReq: Promise<import('@playwright/test').Request>) {
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  return body
}

/** 定位前言断言（P-20261003-102）：首行=任务模板，第二行=「项目根/当前工作
 *  目录（相对 rel）」。根=项目注册路径（服务端存储即前端所见，跨拓扑确定），
 *  分隔符按前端同款规则（base 含 \ 用 \ 否则 /）从根形态推导——两拓扑各自
 *  确定性；git 摘要（P-176）可能追加在前言之后，只锚定前两行不锚全文 */
function expectLocatePreface(launchArgs: string, root: string, rel: string) {
  const lines = launchArgs.split('\n')
  expect(lines[0]).toBe(DIR_PROMPT)
  const base = root.replace(/[\\/]+$/, '')
  const sep = base.includes('\\') ? '\\' : '/'
  const dir = rel ? base + sep + rel.replace(/\//g, sep) : base
  expect(lines[1]).toBe(`项目根：${base}；当前工作目录：${dir}（相对 ${rel}）`)
  expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(500)
}

test('树右键目录「在此目录新建 agent 会话」→ 会话 cwd=该目录', async ({ page, request }) => {
  const { clickRetry } = await openProject(page)
  const subRow = page.locator('.tree-item').filter({ hasText: SUB_DIR })
  await expect(subRow).toBeVisible()
  const createReq = await openDirAgentMenu(page, subRow, clickRetry)
  await expectDirSession(page, request, path.join(REPO_DIR, SUB_DIR), SUB_DIR)
  // 定位前言（P-20261003-102）：子目录会话 launchArgs 第二行=根/当前目录/相对位置
  const body = await createBody(createReq)
  expectLocatePreface(body.launchArgs || '', serverPath(REPO_DIR), SUB_DIR)
})

test('树右键子目录内文件 → 取父目录为会话 cwd', async ({ page, request }) => {
  const { clickRetry } = await openProject(page)
  // 展开目标目录让子文件可见
  await page.locator('.tree-item').filter({ hasText: SUB_DIR }).first().click()
  const fileRow = page.locator('.tree-item').filter({ hasText: SUB_FILE })
  await expect(fileRow).toBeVisible({ timeout: 10000 })
  const createReq = await openDirAgentMenu(page, fileRow, clickRetry)
  await expectDirSession(page, request, path.join(REPO_DIR, SUB_DIR), SUB_DIR)
  // 父目录会话同附定位前言（rel=父目录）
  const body = await createBody(createReq)
  expectLocatePreface(body.launchArgs || '', serverPath(REPO_DIR), SUB_DIR)
})

test('树右键项目根文件 → 父目录为空串落项目根（缺省根语义）', async ({ page, request }) => {
  const { clickRetry } = await openProject(page)
  const rootRow = page.locator('.tree-item').filter({ hasText: ROOT_FILE })
  await expect(rootRow).toBeVisible()
  const createReq = await openDirAgentMenu(page, rootRow, clickRetry)
  // cwd 徽标 = 目录尾段（项目根即仓库名）
  await expectDirSession(page, request, REPO_DIR, path.basename(REPO_DIR))
  // 根目录会话不附定位前言（零变化）：首行=任务模板，无「项目根：」标记行
  const body = await createBody(createReq)
  expect(body.launchArgs!.split('\n')[0]).toBe(DIR_PROMPT)
  expect(body.launchArgs).not.toContain('项目根：')
})
