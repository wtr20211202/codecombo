import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器「就此文件询问智能体」（P-20261001-28）E2E：
 *   1. tab 右键菜单「就此文件询问智能体」→ 新 agent 会话创建并在 docked 管理页激活
 *   2. 编辑器右上角工具条「询问智能体」按钮 → 同上
 * 断言终端创建（会话列表/服务端会话表，dir=项目根）而非终端内容——prompt 经
 * launchArgs 注入属服务端既有链路（resolveAgentLaunch 追加在运行时命令后）。
 * 自备临时仓库，afterEach 清理全部终端会话（会按设置拉起底层运行时，只断言
 * 创建链路不与 TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-ask')
const PROJ_NAME = 'e2e-editor-ask'
const FILE = 'app.ts'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

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
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), `export function hello(name: string): string {\n  return \`hello \${name}\`\n}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add app'])

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

/** 进入项目页并打开夹具文件（editor-git-tools 同款就绪等待/重试口径） */
async function openFile(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
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

/** 断言「询问」动作的结果：docked 管理页出现、恰好一个会话且激活、
 *  服务端会话表里该 agent 会话 dir=项目根（prompt 注入本身不断言内容） */
async function expectAgentSessionCreated(page: Page, request: APIRequestContext) {
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)

  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0].path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
}

test('tab 右键「就此文件询问智能体」→ 新 agent 会话创建并激活', async ({ page, request }) => {
  await openFile(page)
  const tab = page.locator('.editor-tab').filter({ hasText: FILE })
  await expect(tab).toBeVisible()
  await tab.click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: '就此文件询问智能体' }).click()
  await expectAgentSessionCreated(page, request)
})

test('工具条「询问智能体」按钮 → 新 agent 会话创建并激活', async ({ page, request }) => {
  await openFile(page)
  const askBtn = page.locator('.ega-anchor button').filter({ hasText: '询问智能体' })
  await expect(askBtn).toBeVisible()
  await askBtn.click()
  await expectAgentSessionCreated(page, request)
})
