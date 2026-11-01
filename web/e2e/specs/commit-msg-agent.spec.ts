import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更面板「生成提交信息」（P-20261002-138）E2E：
 *   1. 暂存两文件 → 点「生成提交信息」→ POST /terminals 请求体 launchArgs 含
 *      两个文件名（kind=agent、dir=项目根）→ docked 管理页出现且会话创建
 *   2. 勾选子集口径：只勾选其一 → prompt 只含勾选文件（与提交 filesParam 同口径）
 *   3. 暂存区非空才可用：无暂存时按钮禁用，重新暂存后恢复
 *   4. marks 归属行（P-20261005-172）：agent 会话改 2 文件 + 人工 1 → prompt
 *      含「其中 2 个文件来自 agent 会话改动」，人工文件不计入
 *   5. 纯人工改动（无 agent 会话）→ prompt 无归属行
 * prompt 内容经 createAgentTerminal 既有链路注入（launchArgs），断言请求体即
 * 断言了前端组装产物；会话创建断言终端链路真到达服务端。自备临时仓库，
 * afterEach 清理全部终端会话（会按设置拉起底层运行时，只断言创建链路不与
 * TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-msg-agent')
const PROJ = 'e2e-commit-msg-agent'
const F1 = 'alpha-msg.txt'
const F2 = 'beta-msg.txt'
// 归属行用例夹具（P-20261005-172）：人工改动文件 / agent 新建文件 / 播种会话名
const HUMAN = 'gamma-human.txt'
const AGENT_NEW = 'delta-agent.txt'
const SESSION_NAME = 'commit-msg-marks-agent'

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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'commit msg agent baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 生成提交信息基线'])
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

async function enterProject(page: Page, waitForFile: string = F1) {
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
  await expect(page.locator('.cp-node').filter({ hasText: waitForFile })).toBeVisible({ timeout: 10000 })
}

function generateBtn(page: Page) {
  return page.locator('.commit-panel [data-testid="generate-commit-msg"]')
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

/** 断言「生成」动作的结果：launchArgs 含给定文件（不含不给定的）+ docked
 *  管理页出现 + 服务端恰好一个 agent 会话（dir=项目根） */
async function expectAgentDraftLaunched(
  page: Page,
  request: APIRequestContext,
  expectFiles: string[],
  absentFiles: string[] = [],
) {
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await generateBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  // prompt 组装产物：暂存文件名逐个在场（超限截断不该发生在两文件场景）
  for (const f of expectFiles) expect(body.launchArgs).toContain(f)
  for (const f of absentFiles) expect(body.launchArgs).not.toContain(f)

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

test('暂存两文件 → 生成 → agent 会话创建且 prompt 含两个文件名', async ({ page, request }) => {
  await enterProject(page)
  await expect(generateBtn(page)).toBeEnabled()
  await expectAgentDraftLaunched(page, request, [F1, F2])
})

test('勾选子集口径：只勾选其一 → prompt 只含勾选文件', async ({ page, request }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☑')
  await expectAgentDraftLaunched(page, request, [F1], [F2])
})

test('暂存区非空才可用：无暂存禁用 → 重新暂存恢复', async ({ page, request }) => {
  // 自归一基线：无论上轮残留（失败重试/上例遗留），先收敛到「两文件已暂存」
  git(REPO_DIR, ['reset'])
  git(REPO_DIR, ['add', '.'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(2)
  await enterProject(page)
  await expect(generateBtn(page)).toBeEnabled()

  // 全部取消暂存（CLI 侧改状态）：等服务端 status 收敛后重进页面（不依赖
  // WS 推送时序，也不撞 3s TTL 缓存窗口）
  git(REPO_DIR, ['reset'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(0)
  await page.reload()
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
  await expect(generateBtn(page)).toBeDisabled()

  // 重新暂存：按钮恢复可用（禁用态无从发起请求，此处只断言状态恢复）
  git(REPO_DIR, ['add', '.'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(2)
  await page.reload()
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
  await expect(generateBtn(page)).toBeEnabled()
})

// ============== marks 归属行（P-20261005-172） ==============

/** 经 API 直建 agent 会话（runtime=shell 一等选项，确定性可跑；
 *  changes-agent-marks 同款配方——产出归属链与真实智能体会话同源） */
async function createAgentSession(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST', headers, body: JSON.stringify({ kind: 'agent', name, runtime: 'shell', dir: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

/** 等会话产出基线落库（saveAgentSessionMeta 异步）：startHead 就位后写入的
 *  文件才确定落在 diff 窗口内（changes-agent-marks 同款竞态消除） */
async function waitActivityBaseline(headers: Record<string, string>, id: string): Promise<void> {
  const deadline = Date.now() + 15000
  for (;;) {
    try {
      const res = await fetch(`${API_BASE}/api/terminals/${id}/activity`, { headers })
      if (res.ok) {
        const body = (await res.json()) as { data?: { baseline?: boolean } }
        if (body.data?.baseline === true) return
      }
    } catch { /* 轮询忽略 */ }
    if (Date.now() > deadline) throw new Error(`activity baseline not ready in 15s (session ${id})`)
    await new Promise(r => setTimeout(r, 300))
  }
}

test('agent 会话改 2 文件 + 人工 1 → 归属行只数 agent 改动（人工不计入）', async ({ page, request }) => {
  test.setTimeout(120000)
  // 自归一：夹具暂存先落库（worktree 清零），在其上铺混改场景
  git(REPO_DIR, ['reset'])
  git(REPO_DIR, ['add', '-A'])
  git(REPO_DIR, ['commit', '-m', 'fixture: base'])
  const headers = await unlockHeaders(request)
  // 人工改动：新建并提交（内容进 HEAD）——会话 startHead 记在该提交上，
  // diff 窗不含其内容 → 不被归属；随后 soft reset 把它退回暂存区参与清单
  fs.writeFileSync(path.join(REPO_DIR, HUMAN), 'human change\n')
  git(REPO_DIR, ['add', HUMAN])
  git(REPO_DIR, ['commit', '-m', 'human: note'])
  // agent 会话就位后 agent 再写：tracked 追加 + untracked 新建（都落 diff 窗口）
  const sessionId = await createAgentSession(headers, SESSION_NAME, REPO_DIR)
  await waitActivityBaseline(headers, sessionId)
  fs.appendFileSync(path.join(REPO_DIR, F1), 'appended by agent session\n')
  fs.writeFileSync(path.join(REPO_DIR, AGENT_NEW), 'created by agent session\n')
  // 人工文件退回暂存区（HEAD 退一提交、index 保留）+ agent 产出全部入暂存：
  // 生成提交信息清单 = 3 staged 文件（人工 1 + agent 2）
  git(REPO_DIR, ['reset', '--soft', 'HEAD~1'])
  git(REPO_DIR, ['add', '-A'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(3)

  await enterProject(page, HUMAN)
  const panel = page.locator('.commit-panel')
  // 等 marks 聚合（面板侧引导拉会话列表 → 3s 防抖 → activity 聚合）：恰 2 枚点标
  //（F1 + AGENT_NEW；人工文件不在归属内，fixture 三文件不齐不点）
  await expect(panel.locator('[data-testid="cp-agent-dot"]')).toHaveCount(2, { timeout: 30000 })

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await generateBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  // 三文件清单完整在场（归属行只在清单完整时出现的前提）；F2 已随基线提交、
  // 不在工作区变更集，不在清单
  for (const f of [F1, HUMAN, AGENT_NEW]) expect(prompt).toContain(f)
  // 归属行：恰 2 个 agent 文件、runtime=shell（人工文件不在计数内）
  expect(prompt).toContain('其中 2 个文件来自 agent 会话改动（runtimes: shell）')
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现；服务端恰好两个 agent 会话（播种会话 + 起草会话）
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  expect(list.filter(s => s.kind === 'agent'), '播种 + 起草两个 agent 会话').toHaveLength(2)
})

test('纯人工改动（无 agent 会话）→ prompt 无归属行', async ({ page, request }) => {
  test.setTimeout(60000)
  // 自归一：回到干净基线再铺两文件纯人工暂存（上例的提交/软退全部清掉）
  git(REPO_DIR, ['reset', '--hard'])
  fs.appendFileSync(path.join(REPO_DIR, F1), 'human edit 1\n')
  fs.appendFileSync(path.join(REPO_DIR, F2), 'human edit 2\n')
  git(REPO_DIR, ['add', '-A'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(2)

  await enterProject(page)
  await expect(generateBtn(page)).toBeEnabled()
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await generateBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt).toContain(F1)
  expect(prompt).toContain(F2)
  expect(prompt).not.toContain('来自 agent 会话改动') // 无 marks 数据 → 无归属行
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})
