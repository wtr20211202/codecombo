import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 长会话审阅基线标记 E2E（P-20261003-217）：
 *   1. API 层：POST /terminals/:id/review-mark 把当前时点记为阶段审阅基线；
 *      activity?since=<标记> 的 diff 范围只含标记后的产出（标记前的提交态与
 *      未跟踪文件均排除），不带 since 仍为整段 startHead..工作区。
 *   2. UI 层：产出面板基线切换器——切到标记后文件清单只剩标记后产出，
 *      切回「会话起点」恢复整段。
 * agent 会话经 API 直建 kind=agent + runtime=shell（一等选项，确定性可跑，
 * 产物归属链与 claude 会话同源）。自备临时仓库，afterAll 清理。
 * 时序纪律：git 提交时间戳只有秒精度——标记前后的事件各跨 1s+ 再落下一
 * 步，同秒提交按秒粒度归标记前（服务端 reviewMarkBase 边界注记）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-review-baseline')
const PROJ_NAME = 'e2e-review-baseline'
const README = 'readme-baseline.md'
// 标记前产出（提交态 a + 未跟踪 pre）、标记后产出（提交态 b + 未跟踪 post）
const PRE_COMMIT = 'pre-commit.txt'
const PRE_UNTRACKED = 'pre-untracked.txt'
const POST_COMMIT = 'post-commit.txt'
const POST_UNTRACKED = 'post-untracked.txt'
const SESSION_NAME = 'baseline-agent'
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
 *  文件才确定落在 diff 窗口内 */
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
    await sleep(300)
  }
}

interface ActivityResp {
  data?: {
    base?: string
    startHead?: string
    marks?: { ts: string; head?: string }[]
    files?: { status: string; path: string }[] | null
  }
}

async function getActivity(headers: Record<string, string>, id: string, since?: string): Promise<ActivityResp> {
  const url = `${API_BASE}/api/terminals/${id}/activity${since ? `?since=${encodeURIComponent(since)}` : ''}`
  const res = await fetch(url, { headers })
  expect(res.ok).toBeTruthy()
  return (await res.json()) as ActivityResp
}

const pathsOf = (resp: ActivityResp) => new Set((resp.data?.files || []).map(f => f.path))

let projectId = ''
let sessionId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名/会话名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  const terms = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((terms?.data || []) as { id: string; name: string }[])) {
    if (s.name === SESSION_NAME) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  // 仓库基线（首个提交）+ 项目 + agent 会话
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, README), 'review baseline root\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 审阅基线'])
  projectId = await (async () => {
    const created = await fetch(`${API_BASE}/api/projects`, {
      method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
    })
    expect([200, 201]).toContain(created.status)
    const body = (await created.json()) as { data?: { id?: string } }
    expect(body.data?.id || '').not.toBe('')
    return body.data!.id!
  })()
  sessionId = await createAgentSession(headers, SESSION_NAME, REPO_DIR)
  await waitActivityBaseline(headers, sessionId)

  // —— 标记前产出：提交态 PRE_COMMIT + 未跟踪 PRE_UNTRACKED ——
  fs.writeFileSync(path.join(REPO_DIR, PRE_COMMIT), 'pre committed work\n')
  git(REPO_DIR, ['add', PRE_COMMIT])
  git(REPO_DIR, ['commit', '-m', 'pre-mark commit'])
  fs.writeFileSync(path.join(REPO_DIR, PRE_UNTRACKED), 'pre untracked work\n')
  // 跨秒再标记：git 提交时间戳秒精度，同秒边界按秒归标记前
  await sleep(1100)

  // 标记审阅基线
  const marked = await fetch(`${API_BASE}/api/terminals/${sessionId}/review-mark`, { method: 'POST', headers })
  expect(marked.status).toBe(200)
  const markBody = (await marked.json()) as ActivityResp
  expect((markBody.data?.marks || []).length).toBeGreaterThanOrEqual(1)
  // 跨秒再产出：标记视角只收标记后的完整秒
  await sleep(1100)

  // —— 标记后产出：提交态 POST_COMMIT + 未跟踪 POST_UNTRACKED ——
  fs.writeFileSync(path.join(REPO_DIR, POST_COMMIT), 'post committed work\n')
  git(REPO_DIR, ['add', POST_COMMIT])
  git(REPO_DIR, ['commit', '-m', 'post-mark commit'])
  fs.writeFileSync(path.join(REPO_DIR, POST_UNTRACKED), 'post untracked work\n')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  if (sessionId) await fetch(`${API_BASE}/api/terminals/${sessionId}`, { method: 'DELETE', headers }).catch(() => {})
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  const token = headers['X-Lock-Token']
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('API：review-mark 落库，activity?since 只含标记后产出，整段视图不变', async () => {
  const headers = await unlockHeaders()

  const full = await getActivity(headers, sessionId)
  // 整段视图：标记前后产出俱在（含 untracked）
  const fullPaths = pathsOf(full)
  expect(fullPaths.has(PRE_COMMIT)).toBe(true)
  expect(fullPaths.has(PRE_UNTRACKED)).toBe(true)
  expect(fullPaths.has(POST_COMMIT)).toBe(true)
  expect(fullPaths.has(POST_UNTRACKED)).toBe(true)
  // activity 响应带 marks 供切换器渲染
  expect((full.data?.marks || []).length).toBeGreaterThanOrEqual(1)

  // 标记视角：标记前产出（提交态 + 未跟踪）排除，标记后产出俱在
  const since = full.data!.marks![full.data!.marks!.length - 1].ts
  const marked = await getActivity(headers, sessionId, since)
  const markedPaths = pathsOf(marked)
  expect(markedPaths.has(PRE_COMMIT)).toBe(false)
  expect(markedPaths.has(PRE_UNTRACKED)).toBe(false)
  expect(markedPaths.has(POST_COMMIT)).toBe(true)
  expect(markedPaths.has(POST_UNTRACKED)).toBe(true)
  // base = 按时间戳解析出的标记基点（≠ startHead——标记前有新提交）
  expect(marked.data?.base).toBeTruthy()
  expect(marked.data?.base).not.toBe(full.data?.startHead)
})

test('UI：产出面板基线切换器——切到标记只剩标记后产出，切回起点恢复整段', async ({ page }) => {
  test.setTimeout(90000)
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  // 选中夹具会话（行定位按会话名，全仓唯一）
  const row = view.locator('.ats-item').filter({ hasText: SESSION_NAME })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click()

  // 打开产出面板（头部「会话产出」按钮）
  await view.locator('.atv-header button[title="会话产出"]').click()
  const panel = page.locator('.aap-root')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // 整段视图：四件产出俱在
  const fileRow = (name: string) => panel.locator('.aap-file').filter({ hasText: name })
  await expect(fileRow(PRE_COMMIT)).toBeVisible({ timeout: 10000 })
  await expect(fileRow(PRE_UNTRACKED)).toBeVisible()
  await expect(fileRow(POST_COMMIT)).toBeVisible()
  await expect(fileRow(POST_UNTRACKED)).toBeVisible()

  // 切换器切到标记（「基线 1 …」选项）→ 标记前两件消失，标记后两件保留
  await panel.locator('[data-testid="activity-baseline-switch"]').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '基线 1' }).click()
  await expect(fileRow(PRE_COMMIT)).toHaveCount(0)
  await expect(fileRow(PRE_UNTRACKED)).toHaveCount(0)
  await expect(fileRow(POST_COMMIT)).toBeVisible()
  await expect(fileRow(POST_UNTRACKED)).toBeVisible()

  // 切回「会话起点」→ 整段恢复
  await panel.locator('[data-testid="activity-baseline-switch"]').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '会话起点' }).click()
  await expect(fileRow(PRE_COMMIT)).toBeVisible({ timeout: 10000 })
  await expect(fileRow(POST_UNTRACKED)).toBeVisible()
})
