import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更面板「拆分建议」（P-20261003-186）E2E（commit-msg-agent.spec.ts 同款结构）：
 *   1. 暂存两文件 → 点「拆分建议」→ POST /terminals 请求体 launchArgs 含两个
 *      文件名 + 分组方案输出格式指令（组名/commit 主题/勿执行 git add 的安全
 *      注记）（kind=agent、dir=项目根）→ docked 管理页出现且会话创建
 *   2. 勾选子集口径：只勾选其一 → prompt 只含勾选文件（与 P-138/提交 filesParam
 *      同口径）
 *   3. 暂存区非空才可用：无暂存时按钮禁用，重新暂存后恢复
 * 输出为「纯建议」由 prompt 固定头保证（launchArgs 断言其在场）；会话创建断言
 * 终端链路真到达服务端。自备临时仓库，beforeEach/afterEach 清空终端会话（会按
 * 设置拉起底层运行时，只断言创建链路不与 TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-split-suggest')
const PROJ = 'e2e-commit-split-suggest'
const F1 = 'alpha-split.txt'
const F2 = 'beta-split.txt'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的计数，残留会话会污染 */
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
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'commit split suggest baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 拆分建议基线'])
  // 造 2 个 staged 变更（注册项目使服务端 status 缓存失效，进项目首拉即含）
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged content\n`)
  fs.writeFileSync(path.join(REPO_DIR, F2), `${F2} staged content\n`)
  git(REPO_DIR, ['add', '.'])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(2)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住变更面板
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
}

function splitBtn(page: Page) {
  return page.locator('.commit-panel [data-testid="suggest-commit-split"]')
}

/** 服务端 status 的暂存计数：CLI 侧 git 改状态后，/status 走 3s TTL 缓存
 *  （server/api/gitops/status_cache.go，应用外变更自愈口径）——先等服务端
 *  收敛到 CLI 现实再刷页面，不让 UI 断言撞缓存窗口 */
async function serverStagedCount(request: APIRequestContext): Promise<number> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/status`, { headers })
  const files = ((await res.json()) as { data?: { staged?: boolean }[] }).data || []
  return files.filter(f => f.staged).length
}

/** 断言「拆分建议」动作的结果：launchArgs 含给定文件（不含不给定的）+ 分组
 *  方案输出格式指令 + 勿执行安全注记；docked 管理页出现 + 服务端恰好一个
 *  agent 会话（dir=项目根） */
async function expectSplitSuggestLaunched(
  page: Page,
  request: APIRequestContext,
  expectFiles: string[],
  absentFiles: string[] = [],
) {
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await splitBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  // prompt 组装产物：暂存文件名逐个在场（超限截断不该发生在两文件场景）
  for (const f of expectFiles) expect(body.launchArgs).toContain(f)
  for (const f of absentFiles) expect(body.launchArgs).not.toContain(f)
  // 输出为分组建议格式：固定头携带输出格式指令（组名/文件清单/commit 主题）
  // 与安全边界注记（仅建议，勿执行 git add/commit——自动执行不做）
  expect(body.launchArgs).toContain('组名')
  expect(body.launchArgs).toContain('commit 主题')
  expect(body.launchArgs).toContain('勿执行 git add/commit')

  // docked 管理页出现、恰好一个会话且激活
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)

  // 服务端会话表：恰好一个 agent 会话，工作目录 = 项目根
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0]!.path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
}

test('暂存两文件 → 拆分建议 → agent 会话创建且 prompt 含文件名与分组方案指令', async ({ page, request }) => {
  await enterProject(page)
  await expect(splitBtn(page)).toBeEnabled()
  await expectSplitSuggestLaunched(page, request, [F1, F2])
})

test('勾选子集口径：只勾选其一 → prompt 只含勾选文件', async ({ page, request }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☑')
  await expectSplitSuggestLaunched(page, request, [F1], [F2])
})

test('暂存区非空才可用：无暂存禁用 → 重新暂存恢复', async ({ page, request }) => {
  // 自归一基线：无论上轮残留（失败重试/上例遗留），先收敛到「两文件已暂存」
  git(REPO_DIR, ['reset'])
  git(REPO_DIR, ['add', '.'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(2)
  await enterProject(page)
  await expect(splitBtn(page)).toBeEnabled()

  // 全部取消暂存（CLI 侧改状态）：等服务端 status 收敛后重进页面（不依赖
  // WS 推送时序，也不撞 3s TTL 缓存窗口）
  git(REPO_DIR, ['reset'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(0)
  await page.reload()
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
  await expect(splitBtn(page)).toBeDisabled()

  // 重新暂存：按钮恢复可用（禁用态无从发起请求，此处只断言状态恢复）
  git(REPO_DIR, ['add', '.'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(2)
  await page.reload()
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
  await expect(splitBtn(page)).toBeEnabled()
})
