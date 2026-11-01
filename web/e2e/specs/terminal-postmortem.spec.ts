import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 失败会话一键验尸 E2E（P-20261004-60）：agent 会话异常退出（exitCode != 0）
 * → 通知携验尸摘要 + postmortem 动作 → 弹层含退出码与输出现场 → 一键转存
 * 问询（新会话 prompt 携现场）。全链覆盖：
 *   1. API：异常退出通知（titleKey/action= postmortem/正文 exit=3+尾部）→
 *      GET /terminals/:id/postmortem JSON（exitCode/尾部）+ 敏感闸门
 *      warnings→override 放行
 *   2. UI：通知卡行点击 → 验尸弹层（exit 徽标 + 尾部现场）→「询问智能体」
 *      → 新会话 initialPrompt 携现场（转存闭环落点）
 * 模拟异常退出 = 注册自定义运行时 + agentLaunchCommands 覆盖（同
 * long-session-notify.spec 口径）：命令经 PTY 注入 shell 执行「写唯一标记行 →
 * 写退出标记 → exit 3」。Windows ConPTY 死会话不从会话表自移除，退出确认用
 * 标记文件；通知/运行时均为服务端全局状态，用例开头清场不残留。
 */

const CUSTOM_AGENT = 'e2e-postmortem'
const PM_TITLE_KEY = 'terminal.postmortem.notify.title'
const OUT_MARK = `PMMARKER-${Date.now()}-fatal-boom`
const MARKER = path.join(tmpdir(), `sc-postmortem-exit-${Date.now()}.txt`)
// 注入命令按 e2e 机构造（pwsh / bash 同语义）：输出唯一标记行（验尸尾部现场）
// → 写退出标记（确定性退出证据）→ 以非零码退出（异常退出闸门）
const CRASH_CMD = process.platform === 'win32'
  ? `Write-Output '${OUT_MARK}'; Set-Content -Path '${MARKER}' -Value done; exit 3`
  : `echo '${OUT_MARK}'; echo done > '${MARKER}'; exit 3`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface NotifItem { titleKey?: string; title?: string; body?: string; action?: string; actionPayload?: string; msgParams?: Record<string, unknown> }

async function notifs(headers: Record<string, string>): Promise<NotifItem[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  return ((await res.json()) as { data?: NotifItem[] }).data || []
}

async function clearNotifs(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

async function ensureCustomAgent(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/settings/custom-agents/${CUSTOM_AGENT}`, { method: 'DELETE', headers }).catch(() => {})
  const res = await fetch(`${API_BASE}/api/settings/custom-agents`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: CUSTOM_AGENT, displayName: 'E2E 验尸', command: CRASH_CMD }),
  })
  if (!res.ok) throw new Error(`register custom agent failed: ${res.status}`)
  const res2 = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ agentLaunchCommands: { [CUSTOM_AGENT]: CRASH_CMD } }),
  })
  if (!res2.ok) throw new Error(`set agentLaunchCommands failed: ${res2.status}`)
}

async function createAgentSession(headers: Record<string, string>, name: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', name, runtime: CUSTOM_AGENT, dir: '' }),
  })
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!res.ok || !data?.id) throw new Error(`create agent session failed: ${res.status}`)
  return data.id
}

interface TermSnapshot { id: string; name?: string; initialPrompt?: string }

async function terminals(headers: Record<string, string>): Promise<TermSnapshot[]> {
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: TermSnapshot[] }).data || []
}

async function waitMarker(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(MARKER)) return true
    if (Date.now() > deadline) return false
    await new Promise(resolve => setTimeout(resolve, 500))
  }
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

// 退出标记落盘后留出钩子触发 + 通知入账窗口（waitLoop 派发 + 尾读 + Add 落库，
// 同步链亚秒级，4s 覆盖负载抖动）
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
  // MaxSessions；同 long-session-notify.spec 口径）
  const list = await terminals(headers)
  for (const s of list) {
    await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
  }
  await clearNotifs(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/settings/custom-agents/${CUSTOM_AGENT}`, { method: 'DELETE', headers }).catch(() => {})
  await clearNotifs(headers)
  await rm(MARKER, { force: true }).catch(() => {})
})

test('异常退出 → 通知携验尸摘要 + 报告端点（JSON/敏感闸门）', async () => {
  test.setTimeout(120000)
  const headers = await unlockHeaders()
  await ensureCustomAgent(headers)
  await rm(MARKER, { force: true }).catch(() => {})
  await clearNotifs(headers)

  const sessionId = await createAgentSession(headers, '验尸e2e-崩溃')
  // shell 注入命令跑完（标记行已输出、exit 3 已执行）→ 退出钩子入账
  expect(await waitMarker(45000)).toBe(true)
  const entry = await pollUntil(
    async () => (await notifs(headers)).find(n => n.titleKey === PM_TITLE_KEY && n.actionPayload === sessionId),
    n => !!n,
    20000,
  )
  expect(entry, 'postmortem notification should arrive').toBeTruthy()
  // 验尸摘要（语言中立明细）：退出码 + 尾部现场
  expect(entry!.body).toContain('exit=3')
  expect(entry!.body).toContain(OUT_MARK)
  expect(entry!.msgParams?.['name']).toBe('验尸e2e-崩溃')
  // 留出落库窗口后核对退出记录随之落 meta（报告端点的数据面）
  await new Promise(resolve => setTimeout(resolve, HOOK_GRACE_MS))

  // 报告端点 JSON：退出码 + 尾部现场（Windows ConPTY 死会话在册 → alive=true
  // 且尾部来自实时缓冲；其他平台自移除时尾部可退化 transcript/不可得——
  // exitCode 与标记行断言对两形态都成立）
  const rep = await fetch(`${API_BASE}/api/terminals/${sessionId}/postmortem`, { headers })
  expect(rep.status).toBe(200)
  const repBody = ((await rep.json()) as { data?: { exitCode?: number; alive?: boolean; outputTail?: string; outputSource?: string; name?: string } }).data
  expect(repBody?.exitCode).toBe(3)
  expect(repBody?.name).toBe('验尸e2e-崩溃')
  if (repBody?.outputTail) expect(repBody.outputTail).toContain(OUT_MARK)

  // 敏感出域闸门（P-20261003-155 同契约）：标记敏感 → warnings 拦截 → override 放行
  await fetch(`${API_BASE}/api/terminals/${sessionId}/sensitive`, {
    method: 'POST', headers, body: JSON.stringify({ sensitive: true }),
  })
  const gated = await fetch(`${API_BASE}/api/terminals/${sessionId}/postmortem`, { headers })
  const gatedBody = (await gated.json()) as { warnings?: string[]; data?: unknown }
  expect(Array.isArray(gatedBody.warnings) && gatedBody.warnings.length > 0).toBe(true)
  const overridden = await fetch(`${API_BASE}/api/terminals/${sessionId}/postmortem?override=1`, { headers })
  expect(((await overridden.json()) as { data?: { exitCode?: number } }).data?.exitCode).toBe(3)
  await fetch(`${API_BASE}/api/terminals/${sessionId}/sensitive`, {
    method: 'POST', headers, body: JSON.stringify({ sensitive: false }),
  })
})

test('通知卡 → 验尸弹层（退出码+现场）→ 一键转存问询（新会话 prompt 携现场）', async ({ page }) => {
  test.setTimeout(150000)
  const headers = await unlockHeaders()
  await ensureCustomAgent(headers)
  await rm(MARKER, { force: true }).catch(() => {})
  await clearNotifs(headers)
  await enterProject(page)

  const sessionId = await createAgentSession(headers, '验尸e2e-UI闭环')
  expect(await waitMarker(45000)).toBe(true)
  await pollUntil(
    async () => (await notifs(headers)).some(n => n.titleKey === PM_TITLE_KEY && n.actionPayload === sessionId),
    ok => ok,
    20000,
  )

  // 通知中心：行内主动作按钮「验尸报告」可见（titleKey 模板渲染标题）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: '会话异常退出' }).filter({ hasText: '验尸e2e-UI闭环' }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  // 行点击 = 主动作（pendingAction 分发）→ App 层验尸弹层
  await row.click()
  const modal = page.locator('[data-testid="postmortem-modal"]')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('[data-testid="postmortem-exit"]')).toHaveText(/exit\s*3/, { timeout: 8000 })
  // 尾部现场（服务端已遮蔽的原文）就地可读
  await expect(modal.locator('[data-testid="postmortem-tail"]')).toContainText(OUT_MARK, { timeout: 8000 })

  // 一键转存问询：gist 预填新 agent 会话（launchArgs 通道）
  await modal.locator('[data-testid="postmortem-ask"]').click()
  await expect(modal).toBeHidden({ timeout: 15000 })
  // 新会话的 initialPrompt 携验尸现场（退出码 + 标记行）——闭环落点；
  // meta 异步落库，快照轮询直至可见
  await pollUntil(async () => terminals(headers), list =>
    list.some(s => s.initialPrompt?.includes('exit 3') && s.initialPrompt.includes(OUT_MARK)), 20000)
  const list = await terminals(headers)
  const transferred = list.find(s => s.initialPrompt?.includes('exit 3') && s.initialPrompt.includes(OUT_MARK))
  expect(transferred, 'transferred session with postmortem prompt should exist').toBeTruthy()
  expect(transferred!.id).not.toBe(sessionId)
})
