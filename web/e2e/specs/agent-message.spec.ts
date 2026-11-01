import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话间定向消息 E2E（P-20261004-68）：
 * 限流/环形容量/TTL/审计脱敏由 Go 单测锁定（server/api/opsmessage + server/store），
 * 本用例锁真实服务端全链路 + 前端感知面：
 *   1. agent 令牌（同解锁令牌鉴权面）A 发 B → B GET 收件箱拉到（投递序、含发送方）
 *      + 通知中心入账（Action 直达目标会话）+ 读取后 B 的 tab 未读徽标熄灭
 *   2. 拉取即读 drain：再拉为空；目标会话不在册 404（稳定 code）；缺发送方头 400
 *
 * 徽标口径注记：管理页仅「当前渲染 pane 的会话」登记宿主可见（P-310 口径），
 * 用例先点选 A 的行让 A 占住 pane，B 恒为后台——terminal.message 点亮 /
 * terminal.message.read 熄灭两端都经真实 ops-channel 广播驱动。
 * 会话经共享实例 API 清理，不残留。
 */

const PREFIX = 'e2e-am'

interface SessionInfo { id?: string; name?: string; kind?: string }
interface InboxMessage { id?: string; from?: string; body?: string; read?: boolean }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(headers: Record<string, string>): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: SessionInfo[] }).data || []
}

async function cleanup() {
  const headers = await unlockHeaders()
  for (const s of await listSessions(headers)) {
    if (s.name?.includes(PREFIX) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

/** 建 agent 会话（shell 运行时，prompt 即会话摘要名，供断言定位） */
async function createSession(headers: Record<string, string>, prompt: string): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', runtime: 'shell', launchArgs: prompt }),
  })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: SessionInfo }).data || {}
}

/** 投递定向消息（sender 为发送方会话 id；sender=null 缺 X-Session-ID 头） */
async function sendMessage(
  headers: Record<string, string>,
  sender: string | null,
  to: string,
  body: string,
): Promise<{ status: number; code?: string; message?: string }> {
  const h: Record<string, string> = { ...headers }
  if (sender) h['X-Session-ID'] = sender
  const res = await fetch(`${API_BASE}/api/ops-message`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ to, body }),
  })
  const json = (await res.json()) as { message?: string; code?: string }
  return { status: res.status, code: json.code, message: json.message }
}

async function fetchInbox(headers: Record<string, string>, sessionID: string): Promise<InboxMessage[]> {
  const res = await fetch(`${API_BASE}/api/ops-message`, {
    headers: { ...headers, 'X-Session-ID': sessionID },
  })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: InboxMessage[] }).data || []
}

test.describe('agent directed message', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('投递→拉取即读→通知入账→404/400 校验面', async () => {
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const a = await createSession(headers, `echo ${PREFIX}1a-${stamp}`)
    const b = await createSession(headers, `echo ${PREFIX}1b-${stamp}`)
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()

    // 校验面先行（不落库不广播）：目标不在册 404 稳定码 + 缺发送方头 400
    const ghost = await sendMessage(headers, a.id!, 'agent-ghost-id', 'x')
    expect(ghost.status).toBe(404)
    expect(ghost.code).toBe('ops.message_target_not_found')
    const noSender = await sendMessage(headers, null, b.id!, 'x')
    expect(noSender.status).toBe(400)
    expect(noSender.code).toBe('ops.message_payload_invalid')

    // A → B 投递成功
    const sent = await sendMessage(headers, a.id!, b.id!, `${PREFIX}1-${stamp} 配置在 scripts/test.env`)
    expect(sent.status).toBe(200)
    expect(sent.message).toBe('message delivered')

    // B 拉取即读：投递序返回、发送方归属正确
    const inbox = await fetchInbox(headers, b.id!)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.from).toBe(a.id)
    expect(inbox[0]!.body).toContain(`${PREFIX}1-${stamp}`)
    expect(inbox[0]!.read).toBe(true)

    // drain：再拉为空
    expect(await fetchInbox(headers, b.id!)).toHaveLength(0)

    // 通知中心弱条目：opsmessage.notify.title + Action 直达目标会话 B
    await expect.poll(async () => {
      const res = await fetch(`${API_BASE}/api/notifications`, { headers })
      const items = ((await res.json()) as { data?: Array<{ titleKey?: string; actionPayload?: string }> }).data || []
      const hit = items.find(n => n.titleKey === 'opsmessage.notify.title' && n.actionPayload === b.id)
      return hit ? hit.actionPayload : ''
    }).toBe(b.id)
  })

  test('UI：接收会话 tab 未读徽标点亮，读取后熄灭', async ({ page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const a = await createSession(headers, `echo ${PREFIX}2a-${stamp}`)
    const b = await createSession(headers, `echo ${PREFIX}2b-${stamp}`)
    expect(a.id).toBeTruthy()
    expect(b.id).toBeTruthy()

    await fixedLocale(page)
    await page.addInitScript(() => {
      localStorage.removeItem('sc.agentTerminal.openState')
    })
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: 'simple-coding' }).first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10_000 })

    // 点选 A 的行：A 占住当前渲染 pane（宿主可见），B 恒为后台——徽标点亮判定不受自动选中漂移影响
    const rowA = view.locator('.ats-item', { hasText: `${PREFIX}2a-${stamp}` }).first()
    await expect(rowA).toBeVisible({ timeout: 10_000 })
    await rowA.click()
    const rowB = view.locator('.ats-item', { hasText: `${PREFIX}2b-${stamp}` }).first()
    await expect(rowB).toBeVisible({ timeout: 10_000 })

    // 投递 A → B：terminal.message 广播点亮 B 行未读徽标（后台会话）
    const sent = await sendMessage(headers, a.id!, b.id!, `${PREFIX}2-${stamp} 别动 config/dev.env，我在改`)
    expect(sent.status).toBe(200)
    await expect(rowB.locator('.ats-item-unread')).toBeVisible({ timeout: 10_000 })

    // B 拉取收件箱：terminal.message.read 广播熄灭徽标（「读取后徽标消」）
    const inbox = await fetchInbox(headers, b.id!)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.from).toBe(a.id)
    await expect(rowB.locator('.ats-item-unread')).toBeHidden({ timeout: 10_000 })
  })
})
