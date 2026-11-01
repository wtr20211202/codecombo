import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * agent 长会话正常完成提醒 E2E（P-20261002-140）：
 *   进程退出钩子补位 P-15 上报链——真实拉起过运行时的 agent 会话正常退出
 *   （exitCode 0）且时长达阈值 → 通知中心入账「智能体会话已完成」：
 *   1. 设置契约：longSessionNotifySec 部分合并 + 越界钳制 + 设置页滑块回显
 *   2. 正向链路：自定义运行时会话（注入命令 sleep 后 exit 自退）→ 通知入账
 *      （titleKey 模板 + MsgParams + 通知中心 UI 行）
 *   3. 纯 shell 不打扰：同款自退命令经 runtime=shell 创建 → 无提醒
 *   4. P-15 去重：智能体上报过 task.progress done 的会话退出 → 不双发
 * 模拟自退 = 注册自定义运行时 + agentLaunchCommands 覆盖（resolveAgentLaunch
 * 对「显式注册名 + 命令覆盖」跳过可用性门控按原样启动），命令经 PTY 注入
 * shell 执行「sleep → 写标记文件 → exit」——标记落盘即会话临近退出的确定性
 * 证据（Windows ConPTY 下死会话不从会话表自移除，不能用列表消失判定退出）。
 * 通知/运行时/偏好均为服务端全局状态：每用例先清通知再播种，自清理不残留。
 */

const CUSTOM_AGENT = 'e2e-longsess'
const LS_TITLE_KEY = 'notify.longSession.done.title'
const MARKER = path.join(tmpdir(), `sc-longsess-exit-${Date.now()}.txt`)
// 注入命令按 e2e 机构造（pwsh / bash 同语义）：睡眠达阈值 → 写退出标记 → 退出 shell
const SELF_EXIT_CMD = process.platform === 'win32'
  ? `Start-Sleep -Seconds 12; Set-Content -Path '${MARKER}' -Value done; exit`
  : `sleep 12; echo done > '${MARKER}'; exit`

async function unlockHeaders(request?: APIRequestContext): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function putPrefs(headers: Record<string, string>, body: Record<string, unknown>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/prefs`, { method: 'PUT', headers, body: JSON.stringify(body) })
}

async function getPrefs(headers: Record<string, string>): Promise<Record<string, unknown> & { longSessionNotifySec?: number }> {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, { headers })
  return (await res.json()) as Record<string, unknown> & { longSessionNotifySec?: number }
}

interface NotifItem { titleKey?: string; title?: string; type?: string; category?: string; action?: string; msgParams?: Record<string, unknown> }

async function notifs(headers: Record<string, string>): Promise<NotifItem[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  return ((await res.json()) as { data?: NotifItem[] }).data || []
}

function longSessionCount(list: NotifItem[]): number {
  return list.filter(n => n.titleKey === LS_TITLE_KEY).length
}

async function clearNotifs(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

// 轮询直到条件成立或超时
async function pollUntil<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (ok(v) || Date.now() > deadline) return v
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

// 注册（幂等）自定义运行时 + 同名启动命令覆盖：自定义命令首词（Start-Sleep/sleep）
// 非可用二进制，选型可用性探测必失败回退 auto——必须落 agentLaunchCommands[注册名]
// 才能命中 resolveAgentLaunch 的「显式注册名 + 命令覆盖」跳过门控路径
async function ensureCustomAgent(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/settings/custom-agents/${CUSTOM_AGENT}`, { method: 'DELETE', headers }).catch(() => {})
  const res = await fetch(`${API_BASE}/api/settings/custom-agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: CUSTOM_AGENT, displayName: 'E2E 长会话', command: SELF_EXIT_CMD }),
  })
  if (!res.ok) throw new Error(`register custom agent failed: ${res.status}`)
  const res2 = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ agentLaunchCommands: { [CUSTOM_AGENT]: SELF_EXIT_CMD } }),
  })
  if (!res2.ok) throw new Error(`set agentLaunchCommands failed: ${res2.status}`)
}

// agent 会话直建统一走共享层 createAgentSessionApi（e2e-api，P-20261004-48）；
// dir 显式传 '' 保持原语义（claude/自定义运行时自管 cwd，会话目录不参与）

async function waitMarker(timeoutMs: number): Promise<boolean> {
  return pollUntil(async () => existsSync(MARKER), v => v, timeoutMs)
}

// 退出标记落盘后留出钩子触发 + 通知入账的窗口（waitLoop 派发 + Add 落库为亚秒级，
// 4s 覆盖负载抖动）
const HOOK_GRACE_MS = 4000

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // notifications WS 在 App 挂载即连：留出建立窗口再触发通知链
  await page.waitForTimeout(800)
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清历史终端会话（Windows ConPTY 死会话不从会话表自移除，防僵尸累积撞
  // MaxSessions；同 agent-terminal.spec 的 cleanupAgentTerminals 口径）
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
  }
  await clearNotifs(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  // 偏好/运行时还原 + 通知清场（用例开头各自清场，此处兜底防重试残留）
  await putPrefs(headers, { longSessionNotifySec: 300 })
  await fetch(`${API_BASE}/api/settings/custom-agents/${CUSTOM_AGENT}`, { method: 'DELETE', headers }).catch(() => {})
  await clearNotifs(headers)
  await rm(MARKER, { force: true }).catch(() => {})
})

test('设置契约：longSessionNotifySec 部分合并 + 越界钳制 + 设置页滑块回显', async ({ page }) => {
  const headers = await unlockHeaders()
  // 部分合并：只传新字段，其他偏好保留；回读即写入值
  await putPrefs(headers, { longSessionNotifySec: 90 })
  expect((await getPrefs(headers)).longSessionNotifySec).toBe(90)
  // 越界钳制：1 → 下限 10
  await putPrefs(headers, { longSessionNotifySec: 1 })
  expect((await getPrefs(headers)).longSessionNotifySec).toBe(10)
  await putPrefs(headers, { longSessionNotifySec: 300 })

  // 设置页 UI：通知偏好页签内长会话分组回显默认 5 分钟（存储 300s → 滑块分钟值）
  await enterProject(page)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('通知偏好')
  const group = page.locator('.form-group').filter({ hasText: '长会话完成提醒' })
  await expect(group).toBeVisible()
  await expect(group.locator('.slider-value')).toHaveText('5 分钟')
  await expect(group.locator('input[type="range"]')).toHaveValue('5')
})

test('长 agent 会话正常退出 → 完成提醒入账（模板键 + 通知中心 UI 行）', async ({ page }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  await putPrefs(headers, { longSessionNotifySec: 10 })
  await ensureCustomAgent(headers)
  await rm(MARKER, { force: true }).catch(() => {})
  await clearNotifs(headers)
  await enterProject(page)

  const sessionName = '长会话e2e-正向'
  await createAgentSessionApi(page.request, { name: sessionName, runtime: CUSTOM_AGENT, dir: '' })
  // shell 自退（sleep 12 + 启动耗时 ≥ 阈值 10s）→ 退出钩子入账
  await pollUntil(
    () => notifs(headers),
    list => list.some(n => n.titleKey === LS_TITLE_KEY && n.msgParams?.['name'] === sessionName),
    45000,
  )
  const list = await notifs(headers)
  const entry = list.find(n => n.titleKey === LS_TITLE_KEY)
  expect(entry?.msgParams?.['name']).toBe(sessionName)
  expect(entry?.type).toBe('success')
  expect(entry?.category).toBe('task')
  expect(entry?.action).toBeUndefined() // 会话已退出，terminal 跳转无落点
  expect(entry?.msgParams?.['minutes']).toBeGreaterThanOrEqual(1)

  // 通知中心 UI：titleKey 模板渲染（标题 + 会话名正文）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: '智能体会话已完成' }).filter({ hasText: sessionName }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
})

test('纯 shell 会话同款自退 → 不打扰（runtime 门控）', async ({ page }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  await putPrefs(headers, { longSessionNotifySec: 10 })
  await rm(MARKER, { force: true }).catch(() => {})
  await clearNotifs(headers)
  await enterProject(page)

  // 与正向用例同款自退命令，唯一差异是 runtime=shell——若门控失效本用例必红。
  // 退出标记先落盘（证明注入命令真实跑完），再留出钩子窗口查无提醒
  await createAgentSessionApi(page.request, { name: '长会话e2e-shell', runtime: 'shell', launchArgs: SELF_EXIT_CMD, dir: '' })
  expect(await waitMarker(30000)).toBe(true)
  await page.waitForTimeout(HOOK_GRACE_MS)
  expect(longSessionCount(await notifs(headers))).toBe(0)
})

test('智能体已上报 task.progress done 的会话退出 → P-15 去重不双发', async ({ page }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  await putPrefs(headers, { longSessionNotifySec: 10 })
  await ensureCustomAgent(headers)
  await rm(MARKER, { force: true }).catch(() => {})
  await clearNotifs(headers)
  await enterProject(page)

  const sessionName = '长会话e2e-去重'
  const taskName = 'E2E去重任务'
  const sessionId = (await createAgentSessionApi(page.request, { name: sessionName, runtime: CUSTOM_AGENT, dir: '' })).id
  // 会话存活窗口内经 ops-notify 上报 done（真实前端链路：ops-channel →
  // OpsChannelBridge → 通知中心入账 title=任务名）
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: taskName, status: 'done', terminalId: sessionId } },
  })
  await pollUntil(() => notifs(headers), list => list.some(n => n.title === taskName), 15000)

  // 会话自退：已有终态上报 → 退出钩子沉默（同一完成不双发）
  expect(await waitMarker(30000)).toBe(true)
  await page.waitForTimeout(HOOK_GRACE_MS)
  const list = await notifs(headers)
  expect(longSessionCount(list)).toBe(0)
  expect(list.filter(n => n.title === taskName).length).toBe(1)
})
