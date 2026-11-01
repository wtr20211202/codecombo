import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更面板「生成 PR 描述」（P-20261003-177）E2E：
 *   1. agent 会话产出（cwd=项目根）在案 → 点「生成 PR 描述」→ POST /terminals
 *      请求体 launchArgs 含文件清单（marks 路径）、diffstat 行、近期提交主题
 *      与 PR 模板四节结构（kind=agent、dir=项目根）→ docked 管理页打开
 *   2. 无 marks（无 agent 会话）→ 照常发起：launchArgs 无清单节，仍有模板
 *      结构与近期提交（有项目根即可发起语义）
 * 断言请求体即断言前端组装产物；会话创建断言终端链路真到达服务端。marks
 * 数据面走 changes-agent-marks 同款配方（API 直建 runtime=shell 会话，产出
 * 归属链与真实智能体会话同源）。自备临时仓库，beforeEach/afterEach 清理全部
 * 终端会话（防跨用例污染计数），afterAll 清理项目与夹具
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-pr-desc-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-pr-desc-b')
const PROJ_A = 'e2e-pr-desc'
const PROJ_B = 'e2e-pr-desc-nomarks'
// 夹具名刻意短：500 字节 launchArgs 配额下模板+双文件清单+双提交主题合计
// ~484 字节——全量装配不触装箱，断言可稳定要求三数据面全在场（装箱路径由
// usePrDescription 单测覆盖，e2e 不复刻字节边界）
const README = 'b-pr.md'
const AGENT_NEW = 'a-pr.txt'
const COMMIT_OLD = 'root: base'
const COMMIT_NEW = 'feat: ready'
const SESSION_A = 'pr-desc-agent-a'

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

/** 清理全部终端会话：会话表残留会污染 marks 聚合与 docked 会话视图 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

function initRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  fs.writeFileSync(path.join(dir, README), 'pr desc baseline\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', COMMIT_OLD])
}

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

/** 经 API 直建 agent 会话（runtime=shell 一等选项，确定性可跑） */
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

let projectIdA = ''
let projectIdB = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 清理历史残留（失败重跑时项目名/会话名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }

  // 项目 A：两条近期提交（marks 会话在用例内创建——beforeEach 清会话会删掉
  // beforeAll 建的，且产出文件须等基线落库后再写，时序属用例）
  initRepo(REPO_A)
  fs.appendFileSync(path.join(REPO_A, README), 'second commit line\n')
  git(REPO_A, ['add', '.'])
  git(REPO_A, ['commit', '-m', COMMIT_NEW])
  projectIdA = await registerProject(headers, PROJ_A, REPO_A)

  // 项目 B：只有提交历史，无 agent 会话 → marks 恒空
  initRepo(REPO_B)
  fs.writeFileSync(path.join(REPO_B, 'human-note.txt'), 'human note\n')
  projectIdB = await registerProject(headers, PROJ_B, REPO_B)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  for (const id of [projectIdA, projectIdB]) {
    if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers: { 'X-Lock-Token': headers['X-Lock-Token'] } })
  }
  await cleanupTerminals(request)
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  const token = headers['X-Lock-Token']
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

async function enterProject(page: Page, projectName: string, waitForFile: string) {
  await fixedLocale(page)
  // agent 终端开合状态是 localStorage（每用例新 context 天然干净），防御性清一次
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: waitForFile })).toBeVisible({ timeout: 15000 })
}

test('有 marks/提交 → 生成 → launchArgs 含文件清单、diffstat 与 PR 模板结构', async ({ page }) => {
  test.setTimeout(120000)
  // 用例内自建 marks 会话（beforeEach 清会话后的空白表上）：改 tracked 文件给
  // numstat 非 0 + 新建 untracked 文件给清单——marks/diffstat/近期提交三数据面齐备
  const headers = await unlockHeaders(page.request)
  const sessionId = await createAgentSession(headers, SESSION_A, REPO_A)
  await waitActivityBaseline(headers, sessionId)
  fs.appendFileSync(path.join(REPO_A, README), 'appended by agent session\n')
  fs.writeFileSync(path.join(REPO_A, AGENT_NEW), `${AGENT_NEW} by agent session\n`)

  await enterProject(page, PROJ_A, AGENT_NEW)
  const panel = page.locator('.commit-panel')

  // 等 marks 聚合（面板侧引导拉会话列表 → 3s 防抖 → activity 聚合）：
  // 两个 agent 产出文件各一枚点标，清单与 diffstat 非零的前置
  await expect(panel.locator('[data-testid="cp-agent-dot"]')).toHaveCount(2, { timeout: 20000 })

  // 点「生成 PR 描述」→ 断言 POST /terminals 组装产物
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await panel.locator('[data-testid="generate-pr-desc"]').click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_A))
  const prompt = body.launchArgs || ''
  // PR 模板结构：四节指令逐一在场（模板语义在组装头，i18n 改文案会在此显形）
  expect(prompt).toContain('PR 描述')
  expect(prompt).toContain('## 改了什么')
  expect(prompt).toContain('## 为什么')
  expect(prompt).toContain('## 怎么测')
  expect(prompt).toContain('## 风险')
  // 文件清单：marks 两个 agent 产出路径逐行在场
  expect(prompt).toContain('智能体改动清单')
  expect(prompt).toContain(AGENT_NEW)
  expect(prompt).toContain(README)
  // diffstat 行：tracked 追加 1 行 → +1 / -0（untracked 不入 numstat，git 语义）
  expect(prompt).toContain('+1 / -0')
  // 近期提交：最新提交主题在场（短哈希 + 主题）
  expect(prompt).toContain(COMMIT_NEW)
  // 服务端 launchArgs 500 字节上限：场景小不触发装箱，原样收进气泡即过
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现（会话创建链路真到达，dock 打开激活）
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})

test('无 marks（无 agent 会话）→ 照常发起：无清单节，仍有模板与近期提交', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page, PROJ_B, 'human-note.txt')
  const panel = page.locator('.commit-panel')

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await panel.locator('[data-testid="generate-pr-desc"]').click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_B))
  const prompt = body.launchArgs || ''
  expect(prompt).toContain('## 改了什么')
  expect(prompt).toContain('## 风险')
  expect(prompt).not.toContain('智能体改动清单') // 空节整省略
  expect(prompt).toContain('+0 / -0')
  expect(prompt).toContain(COMMIT_OLD)
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})
