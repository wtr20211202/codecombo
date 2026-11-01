import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 主页项目删除流 E2E：自备仓库注册 → 卡片「移除」→ 确认弹窗（含项目名）
 * → 列表消失 + API 列表不含（磁盘目录保留——移除注册不删文件）。
 * UI 确认流此前零覆盖（各 spec 的 afterEach 都直接走 API 删除）。
 * 级联会话知会（P-20261003-145）：确认弹窗追加「将终止 N 个终端会话（M 个
 * 正在运行）」——会话经 API 播种，「运行中」经 ops-notify task.progress
 * （agent 上报原语，X-Session-ID 归属）点亮；无会话时不出现知会行。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-remove-proj')
const PROJ = 'e2e-remove-proj'

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

/** 该项目下开一个终端会话（API 播种，返回会话 id） */
async function seedSession(headers: Record<string, string>, projId: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectId: projId, kind: 'shell' }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body?.data?.id || ''
}

/** agent 运行上报原语（ops 手册 task.progress 约定：X-Session-ID 携带 CC_TERMINAL_ID，
 *  terminalId 入 payload 供前端归属；经 ops WS 广播点亮页面内 assistantTask store） */
async function reportTaskRunning(headers: Record<string, string>, sessionId: string) {
  await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST',
    headers: { ...headers, 'X-Session-ID': sessionId },
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e task', status: 'running', terminalId: sessionId } }),
  })
}

/** agent 会话播种（P-20261006-36 驻留形态）：runtime=shell 一等选项免 CLI 依赖，
 *  dir=服务端口径的项目根 → kind=agent 免项目绑定但 Path 驻留项目 */
async function seedAgentSession(headers: Record<string, string>, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', runtime: 'shell', dir }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body?.data?.id || ''
}

async function listSessions(headers: Record<string, string>): Promise<Array<{ id: string; kind: string; path: string }>> {
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const body = (await res.json()) as { data?: Array<{ id: string; kind: string; path: string }> }
  return body?.data || []
}

async function closeSession(headers: Record<string, string>, id: string): Promise<void> {
  if (!id) return
  await fetch(`${API_BASE}/api/terminals/${id}`, { method: 'DELETE', headers })
}

/** 驻留残留清扫（agent 会话不随项目删除级联——默认保留正是本提案语义，
 *  失败重跑的残留会污染后续用例的驻留计数） */
async function sweepAgentLeftovers(headers: Record<string, string>, projDir: string): Promise<void> {
  for (const s of await listSessions(headers)) {
    if (s.kind === 'agent' && s.path && s.path.replace(/\\/g, '/') === projDir) {
      await closeSession(headers, s.id)
    }
  }
}

let projId = ''

test.beforeEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const stale = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'remove project e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root'])
  const create = await request.post(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    headers, data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  expect(create.ok()).toBeTruthy()
  const created = (await (await request.get(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  projId = ((created?.data || []).find(p => p.name === PROJ))?.id || ''
  expect(projId, '夹具项目应注册成功').not.toBe('')
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('主页移除项目：确认弹窗 → 列表消失 → 磁盘目录保留', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = page.locator('.project-card').filter({ hasText: PROJ })
  await expect(card).toBeVisible({ timeout: 5000 })

  // 卡片上的「移除」入口（确认弹窗含项目名防误删）
  // 移除入口是 hover 才显示的纯图标按钮（.project-remove-btn）
  await card.locator('.project-remove-btn').click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  // 无会话项目：级联会话知会行不出现（普通文案）
  await expect(confirmDlg.locator('[data-testid="remove-session-impact"]')).toHaveCount(0)
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: /删除|移除/ }).click()

  // 卡片消失
  await expect(card).toBeHidden({ timeout: 5000 })

  // API 列表不含；磁盘目录保留（移除注册 ≠ 删文件）
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  expect(((list?.data || []) as Array<{ name: string }>).some(p => p.name === PROJ)).toBe(false)
  expect(fs.existsSync(path.join(REPO_DIR, 'readme.md')), '磁盘目录应保留').toBe(true)
})

test('级联会话知会：2 个会话 → 确认框附「将终止 2 个终端会话」（无运行中不升级）', async ({ page }) => {
  const headers = await unlockHeaders()
  // API 播种 2 个该项目会话（service 端列表即知会数据源）
  expect(await seedSession(headers, projId)).not.toBe('')
  expect(await seedSession(headers, projId)).not.toBe('')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = page.locator('.project-card').filter({ hasText: PROJ })
  await expect(card).toBeVisible({ timeout: 5000 })

  await card.locator('.project-remove-btn').click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })

  const impact = confirmDlg.locator('[data-testid="remove-session-impact"]')
  await expect(impact).toContainText('将终止该项目的 2 个终端会话', { timeout: 5000 })
  // M=0：不升级红色警示，也不出「正在运行」段
  await expect(impact).not.toHaveClass(/remove-session-impact-running/)
  await expect(impact).not.toContainText('正在运行')
})

test('级联会话知会：agent 运行中 → 警示升级红色强调 + 「1 个正在运行」', async ({ page }) => {
  const headers = await unlockHeaders()
  const sid = await seedSession(headers, projId)
  expect(sid).not.toBe('')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = page.locator('.project-card').filter({ hasText: PROJ })
  await expect(card).toBeVisible({ timeout: 5000 })

  // agent 上报原语点亮运行态（经页面已连接的 ops WS 广播进 assistantTask store）
  await reportTaskRunning(headers, sid)
  await page.waitForTimeout(1000) // 等 ops 广播落进页面（本地链路 <100ms，留余量）

  await card.locator('.project-remove-btn').click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })

  const impact = confirmDlg.locator('[data-testid="remove-session-impact"]')
  await expect(impact).toContainText('1 个正在运行', { timeout: 5000 })
  await expect(impact).toHaveClass(/remove-session-impact-running/)
})

// ── 驻留智能体会话（P-20261006-36）：确认框知情补计 + 可选级联关闭 ──

const projDir = () => serverPath(REPO_DIR).replace(/\\/g, '/')

test('驻留智能体会话知情：确认框显驻留计数 + 处置勾选项默认不勾 → 不勾选删除后会话存活', async ({ page }) => {
  const headers = await unlockHeaders()
  await sweepAgentLeftovers(headers, projDir())
  // 项目内启动 agent 会话（驻留）+ 项目外 agent 会话（不驻留，知情面反例）
  const residentId = await seedAgentSession(headers, projDir())
  expect(residentId).not.toBe('')
  const outsideId = await seedAgentSession(headers, serverPath(os.tmpdir()))
  expect(outsideId).not.toBe('')

  try {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    const card = page.locator('.project-card').filter({ hasText: PROJ })
    await expect(card).toBeVisible({ timeout: 5000 })

    await card.locator('.project-remove-btn').click()
    const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
    await expect(confirmDlg).toBeVisible({ timeout: 3000 })

    // 驻留知会行：仅计驻留本项目 1 个（项目外 agent 会话不计），不带运行态
    const resident = confirmDlg.locator('[data-testid="remove-resident-agents"]')
    await expect(resident).toContainText('1 个驻留本项目的智能体会话', { timeout: 5000 })
    // 处置勾选项在场且默认不勾（保守保留档）。naive-ui checkbox 是无原生
    // <input> 的 div[role=checkbox]，勾选态由 aria-checked 承载
    const checkbox = confirmDlg.locator('[data-testid="remove-close-resident-agents"]')
    await expect(checkbox).toBeVisible({ timeout: 3000 })
    await expect(checkbox).toHaveAttribute('aria-checked', 'false')

    // 不勾选直接确认 → 项目移除，驻留会话保留存活
    await confirmDlg.locator('.n-dialog__action button').filter({ hasText: /删除|移除/ }).click()
    await expect(card).toBeHidden({ timeout: 5000 })
    const ids = (await listSessions(headers)).map(s => s.id)
    expect(ids).toContain(residentId)
  } finally {
    await closeSession(headers, residentId)
    await closeSession(headers, outsideId)
  }
})

test('驻留智能体会话级联处置：勾选「一并关闭」→ 删除后会话列表无该会话', async ({ page }) => {
  const headers = await unlockHeaders()
  await sweepAgentLeftovers(headers, projDir())
  const residentId = await seedAgentSession(headers, projDir())
  expect(residentId).not.toBe('')

  try {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    const card = page.locator('.project-card').filter({ hasText: PROJ })
    await expect(card).toBeVisible({ timeout: 5000 })

    await card.locator('.project-remove-btn').click()
    const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
    await expect(confirmDlg).toBeVisible({ timeout: 3000 })

    const checkbox = confirmDlg.locator('[data-testid="remove-close-resident-agents"]')
    await expect(checkbox).toBeVisible({ timeout: 5000 })
    await checkbox.click()
    // naive-ui checkbox 无原生 <input>：勾选态经 div[role=checkbox] 的 aria-checked 断言
    await expect(checkbox).toHaveAttribute('aria-checked', 'true')

    await confirmDlg.locator('.n-dialog__action button').filter({ hasText: /删除|移除/ }).click()
    await expect(card).toBeHidden({ timeout: 5000 })
    // 勾选档级联 CloseSession：会话列表不再有该会话
    await expect.poll(async () => (await listSessions(headers)).map(s => s.id), {
      timeout: 5000,
      message: '驻留 agent 会话应随勾选级联关闭',
    }).not.toContain(residentId)
  } finally {
    await closeSession(headers, residentId)
  }
})
