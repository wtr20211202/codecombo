import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * agent 会话「重新发起」（P-20261003-146）E2E：
 *   1. 创建路径全路核对：API 带 prompt 建会话（kind=agent 经服务端
 *      LaunchAgentSession 唯一漏斗）→ 创建响应同步携 initialPrompt（meta 异步
 *      落库竞态窗口的先行面）→ meta 落库后 GET /terminals 快照同携（持久面）；
 *      无 prompt 建的会话快照缺 key（缺 key = 无记录契约）
 *   2. UI 闭环：会话行右键「重新发起」→ 新建对话框任务指令预填 = 原 prompt、
 *      工作目录预填 = 源会话 dir → 直接「创建」→ 拦截创建请求断言 launchArgs
 *      = 原 prompt（重新注入，闭环）
 *   3. 降级形态：无 prompt 会话「重新发起」同样可用——对话框打开、目录预填、
 *      指令区不出现（无内容不虚构空框）
 * runtime=shell 一等选项（确定性可跑，agent-review-baseline 同款取向）：prompt
 * 经 launchArgs 通道注入后作为命令写入 PTY，shell 报 command not found 不影响
 * 断言面（只断言会话表/对话框，不断言终端内容）。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-relaunch')
const PROJ_NAME = 'e2e-agent-relaunch'
const SESSION_WITH_PROMPT = 'relaunch-with-prompt'
const SESSION_NO_PROMPT = 'relaunch-no-prompt'
const PROMPT = '对项目做依赖审计，输出过时依赖清单（relaunch e2e）'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

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

interface SessionRow {
  id: string
  name: string
  kind?: string
  initialPrompt?: string
}

async function listSessions(): Promise<SessionRow[]> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const body = (await res.json()) as { data?: SessionRow[] }
  return body.data || []
}

async function deleteSession(id: string, headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/terminals/${id}`, { method: 'DELETE', headers }).catch(() => {})
}

async function createAgentSession(name: string, launchArgs?: string): Promise<{ id: string; data: Record<string, unknown> }> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST', headers,
    body: JSON.stringify({ kind: 'agent', name, runtime: 'shell', dir: serverPath(REPO_DIR), ...(launchArgs ? { launchArgs } : {}) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } & Record<string, unknown> }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  // data 原样返回：响应键集本身是被断言对象（缺 key = 无记录契约），不得中间映射
  return { id, data: body.data || {} }
}

/** 等 meta 异步落库传导到快照（saveAgentSessionMeta goroutine 竞态窗口） */
async function waitSnapshotInitialPrompt(id: string): Promise<void> {
  const deadline = Date.now() + 15000
  for (;;) {
    const row = (await listSessions()).find(s => s.id === id)
    if (row?.initialPrompt === PROMPT) return
    if (Date.now() > deadline) throw new Error(`snapshot initialPrompt not ready in 15s (session ${id})`)
    await sleep(300)
  }
}

/** 进项目页并打开 docked 管理页（agent-session-name 同款入口与防御） */
async function openAgentDocked(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免 docked 管理页残留态影响入口点击
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

let projectId = ''
let withPromptId = ''
let noPromptId = ''
/** UI 闭环用例经对话框再创建的会话（服务端派生名，按 id 兜底清理） */
const relaunchedIds: string[] = []

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名/会话名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const s of await listSessions()) {
    if (s.name === SESSION_WITH_PROMPT || s.name === SESSION_NO_PROMPT) {
      await deleteSession(s.id, headers)
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'relaunch fixture\n')
  git(REPO_DIR, ['add', '.'])
  try {
    git(REPO_DIR, ['commit', '-m', 'root: relaunch fixture'])
  } catch {
    // 重跑残留：上轮夹具目录被 Windows 句柄延迟扣住（本 spec 会话 shell 的
    // cwd 在其中）删失败时，仓库带提交存活——nothing to commit 形态等价，放行
  }

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')

  // 带 prompt 建（走服务端 LaunchAgentSession 创建漏斗——「全路写入」的被测路）
  const withPrompt = await createAgentSession(SESSION_WITH_PROMPT, PROMPT)
  withPromptId = withPrompt.id
  // 创建响应同步携带（响应先行的竞态窗口面）
  expect(withPrompt.data.initialPrompt).toBe(PROMPT)
  await waitSnapshotInitialPrompt(withPromptId)

  // 无 prompt 建（对照组：缺 key = 无记录）
  const noPrompt = await createAgentSession(SESSION_NO_PROMPT)
  noPromptId = noPrompt.id
  expect(noPrompt.data, '无 prompt 创建响应不应携 initialPrompt 键').not.toHaveProperty('initialPrompt')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  for (const id of [withPromptId, noPromptId, ...relaunchedIds]) {
    if (id) await deleteSession(id, headers)
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  const token = headers['X-Lock-Token']
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('API/meta 层：带 prompt 创建全路落库（响应先行 + 快照持久面），无 prompt 缺 key', async () => {
  // 快照持久面：带 prompt 会话 initialPrompt = 原 prompt
  const withPrompt = (await listSessions()).find(s => s.id === withPromptId)
  expect(withPrompt?.initialPrompt).toBe(PROMPT)
  // 无 prompt 会话：键不携带（缺 key = 无记录，前端空显不虚构）
  const noPrompt = (await listSessions()).find(s => s.id === noPromptId)
  expect(noPrompt, '无 prompt 会话应在会话表中').toBeTruthy()
  expect(noPrompt!, '无 prompt 会话快照不应携 initialPrompt 键').not.toHaveProperty('initialPrompt')
})

test('UI：会话行「重新发起」→ 对话框预填 prompt/dir → 创建再注入 launchArgs 闭环', async ({ page }) => {
  test.setTimeout(90000)
  const view = await openAgentDocked(page)

  // 右键带 prompt 的会话行 → 「重新发起」
  const row = view.locator('.ats-item').filter({ hasText: SESSION_WITH_PROMPT })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: '重新发起' }).click()

  // 对话框打开：任务指令预填 = 原 prompt；工作目录预填 = 源会话 dir
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toHaveValue(PROMPT, { timeout: 5000 })
  const dirInput = dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input')
  await expect(dirInput).toHaveValue(serverPath(REPO_DIR))

  // 摘要随行（P-176）默认勾选会把 git 摘要拼在指令后——取消勾选锁纯指令闭环
  const attach = dlg.locator('[data-testid="agent-attach-git-status"]')
  if (await attach.count() > 0) {
    await attach.click()
    await expect(attach).toHaveAttribute('aria-checked', 'false')
  }

  // 直接创建：请求体 launchArgs = 原 prompt（重新注入闭环）
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()
  const req = await createReq
  const reqBody = req.postDataJSON() as { kind?: string; launchArgs?: string; dir?: string }
  expect(reqBody.kind).toBe('agent')
  expect(reqBody.launchArgs).toBe(PROMPT)
  expect(reqBody.dir).toBe(serverPath(REPO_DIR))
  await expect(dlg).toBeHidden({ timeout: 15000 })
  // 记录产物 id 兜底清理（服务端派生名对不上清理名单）
  const resp = await req.response()
  const created = (await resp!.json()) as { data?: { id?: string } }
  if (created.data?.id) relaunchedIds.push(created.data.id)

  // 新会话进服务端会话表且带同款 initialPrompt（重新发起产物可再发起——链式可用）
  const newList = (await listSessions()).filter(s => s.kind === 'agent' && s.initialPrompt === PROMPT)
  expect(newList.length).toBeGreaterThanOrEqual(2)
})

test('UI：无 prompt 会话「重新发起」降级可用——对话框打开、目录预填、指令区不出现', async ({ page }) => {
  test.setTimeout(90000)
  const view = await openAgentDocked(page)

  const row = view.locator('.ats-item').filter({ hasText: SESSION_NO_PROMPT })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: '重新发起' }).click()

  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  // 无记录不虚构：任务指令表单项不出现（选中模板才出现——既有行为不回归）
  await expect(dlg.locator('[data-testid="agent-template-prompt"]')).toHaveCount(0)
  const dirInput = dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input')
  await expect(dirInput).toHaveValue(serverPath(REPO_DIR))
  await dlg.locator('button').filter({ hasText: '取消' }).click()
  await expect(dlg).toBeHidden({ timeout: 5000 })
})
