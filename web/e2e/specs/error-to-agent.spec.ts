import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 错误/失败任务「交给智能体修复」（P-20261002-109）E2E：
 *   1. 错误入口：拦截 ahead-behind 种下一条服务端错误 → 错误子标签展开条目 →
 *      「交给智能体修复」→ POST /api/terminals {kind:'agent'} 且 launchArgs
 *      含上下文（请求行标题 + 详情摘要标记），docked 管理页打开
 *   2. 任务入口：自备无远端临时仓库 → Git 面板「拉取」真实失败 → 服务端
 *      git.command 广播落控制台命令子标签 → 行上「交给智能体修复」→ 同上，
 *      launchArgs 含命令行（git pull）与失败输出模板段
 *
 * launchArgs 断言取自 POST 请求体（服务端会话表不回显 launchArgs）；agent 会话
 * 会按设置拉起底层运行时，只断言创建链路不与 TUI 交互。afterEach 清理全部
 * 终端会话（「恰一条 agent 会话」断言基于空白会话表），afterAll 清理项目与夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// ── 错误入口种子 ──
const ERR_MARKER = 'SCSEED-FIX-E91'

// ── 任务入口夹具：无远端仓库（pull 必失败且不触网） ──
const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-error-to-agent')
const PROJ_NAME = 'e2e-error-to-agent'

let projectId = ''

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
  git(REPO_DIR, ['init', '-b', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'error-to-agent fixture\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: fixture'])

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

/** 进项目页后的公共收尾：关默认密码提醒（遮罩拦点击，panel-registry 先例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 打开底部控制台并切子标签（面板可能被持久化布局收起：Ctrl+` 幂等归一） */
async function openConsoleSubTab(page: Page, name: '命令' | '错误'): Promise<void> {
  const consoleTab = page.locator('.bottom-tabs button').filter({ hasText: '控制台' })
  if (!(await consoleTab.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+`')
    await consoleTab.waitFor({ state: 'visible', timeout: 5000 })
  }
  await consoleTab.click()
  await page.locator('.sub-tab').filter({ hasText: name }).click()
}

/** 断言「交给智能体修复」的结果：捕获的 POST /api/terminals 为 agent 会话、
 *  launchArgs 含期望片段，docked 管理页打开，服务端恰一条 agent 会话 */
async function expectFixSession(
  page: Page,
  request: APIRequestContext,
  reqPromise: Promise<import('@playwright/test').Request>,
  launchArgsParts: string[],
): Promise<void> {
  const req = await reqPromise
  expect(req.url()).toContain('/api/terminals')
  const body = req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  for (const part of launchArgsParts) {
    expect(body.launchArgs, `launchArgs 含「${part}」`).toContain(part)
  }
  // docked 管理页打开且激活会话存在
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })
  // 服务端恰一条 agent 会话（beforeEach 已清空会话表）
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  expect(list.filter(s => s.kind === 'agent'), '服务端恰好一个 agent 会话').toHaveLength(1)
}

test('错误条目「交给智能体修复」→ agent 会话创建且 launchArgs 含上下文', async ({ page, request }) => {
  await fixedLocale(page)
  await page.goto('/')
  await page.waitForSelector('body')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.waitForSelector('.project-card', { timeout: 8000 })
  // 首页自身的 ahead-behind 拉取先落地，再注册拦截路由（errorlog-filter 同款）
  await page.waitForTimeout(1000)

  // 单次失败注入：首次 500 带标记，后续放行良性 200（settings/status 多次拉取先例）
  let seeded = false
  await page.route('**/api/ahead-behind', (route) => {
    if (!seeded) {
      seeded = true
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: ERR_MARKER }) })
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })

  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
  await dismissPasswordTip(page)
  await openConsoleSubTab(page, '错误')

  const rows = page.locator('.log-row')
  const srvRow = rows.filter({ hasText: '服务器异常' })
  await expect(srvRow).toHaveCount(1, { timeout: 10000 })

  // 展开条目（点文案区，避开徽标）→ 原始错误可见 → 动作按钮
  const row = srvRow.first()
  await row.locator('.user-msg').click()
  await expect(row.locator('.raw')).toContainText(ERR_MARKER)

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await row.locator('[data-testid="errorlog-fix-agent"]').click()
  await expectFixSession(page, request, reqPromise, [
    '前端请求出错', // prompt 模板段（错误头）
    'GET /ahead-behind → 500', // 标题 = 请求行（method url → status，url 为 axios 相对路径）
    ERR_MARKER, // 详情摘要（尾部）
  ])
})

test('失败 git 命令「交给智能体修复」→ agent 会话创建且 launchArgs 含命令行与输出尾部', async ({ page, request }) => {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
  await dismissPasswordTip(page)

  // 分支卡片「拉取」：仓库无远端 → git pull 非零退出 → 服务端 git.command 失败广播
  const pullBtn = page.locator('button[title="拉取"]').first()
  await expect(pullBtn).toBeVisible({ timeout: 15000 })
  await pullBtn.click()

  await openConsoleSubTab(page, '命令')
  const cmdRow = page.locator('.cmd-row').filter({ hasText: 'pull' })
  await expect(cmdRow).toHaveCount(1, { timeout: 15000 })

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await cmdRow.locator('[data-testid="console-cmd-fix-agent"]').click()
  await expectFixSession(page, request, reqPromise, [
    '以下命令执行失败', // prompt 模板段（任务头）
    '$ git pull', // 命令行
    '失败输出', // 失败输出模板段（尾部摘要，git 报错文案随版本/环境漂移不断言原文）
  ])
})
