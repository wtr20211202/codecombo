import { test, expect, type APIRequestContext } from '@playwright/test'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程接入安全加固（P-20261020-1）E2E：
 *   1. 可信代理配置面：GET/PUT /api/settings 的 trustedProxies 往返 + 非法
 *      条目 400（运行期生效需重启，e2e 只验配置面；ClientIP 行为由 Go 单测
 *      `middleware/trustedproxy_test.go` 覆盖）；
 *   2. AgentGuard 隧道控制：agent 令牌 start → 428 + approvalId；人工 allow
 *      后带 X-Approval-ID 重试放行（非 428）；stop 降险直过 200；未知 action
 *      失败闭合（428）；
 *   3. UI：档案填域名（反代形态）时编辑器显黄色明文边界提示。
 *
 * 与 remote-access-tunnel.spec 的分工：该 spec 覆盖真实隧道生命周期（需 WSL
 * sshd），本 spec 不建真隧道，只验安全边界与提示文案，任何环境可跑。
 */

const PROFILE_NAME = `ra-hardening-${Math.random().toString(36).slice(2, 8)}`
let headers: Record<string, string> = {}
let agentToken = ''
let baseline: {
  agentGuard?: boolean
  agentApprovalMode?: string
  agentApprovalRules?: unknown[]
  trustedProxies?: string[]
  profiles?: any[]
} = {}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getSettings(request: APIRequestContext): Promise<any> {
  const res = await request.get(`${API_BASE}/api/settings`, { headers })
  return ((await res.json()) as any).data || {}
}

async function putSettings(request: APIRequestContext, body: Record<string, unknown>): Promise<Response> {
  return request.put(`${API_BASE}/api/settings`, { headers, data: body })
}

async function resolvePendingApprovals(request: APIRequestContext, allow: boolean): Promise<void> {
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow, always: false },
    })
  }
}

const agentHeaders = () => ({
  'Content-Type': 'application/json',
  'X-Lock-Token': agentToken,
})

test.beforeAll(async ({ request }) => {
  headers = await unlockHeaders(request)
  const settings = await getSettings(request)
  baseline = {
    agentGuard: settings.agentGuard,
    agentApprovalMode: settings.agentApprovalMode,
    agentApprovalRules: settings.agentApprovalRules,
    trustedProxies: settings.trustedProxies,
    profiles: settings.remoteAccess?.profiles || [],
  }
  // 强制面显式开启 + 无规则 ask（金态可能被其他用例改过）
  expect((await putSettings(request, {
    agentGuard: true,
    agentApprovalMode: 'ask',
    agentApprovalRules: [],
  })).ok()).toBeTruthy()

  const revealed = await request.post(`${API_BASE}/api/agent-token/reveal`, { headers })
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
})

test.afterAll(async ({ request }) => {
  if (!headers['X-Lock-Token']) return
  // 降险清场：停隧道 + 清掉本 spec 建的 pending 审批
  await request.post(`${API_BASE}/api/remoteaccess/tunnel`, {
    headers: agentHeaders(), data: { action: 'stop' },
  }).catch(() => undefined)
  await resolvePendingApprovals(request, false).catch(() => undefined)
  // 恢复共享设置（串行套件，避免污染后续用例）
  await putSettings(request, {
    agentGuard: baseline.agentGuard,
    agentApprovalMode: baseline.agentApprovalMode,
    agentApprovalRules: baseline.agentApprovalRules,
    trustedProxies: baseline.trustedProxies,
    remoteAccess: { profiles: baseline.profiles },
  }).catch(() => undefined)
})

test('trustedProxies 配置面：往返读写 + 非法条目 400', async ({ request }) => {
  const before = await getSettings(request)
  expect(Array.isArray(before.trustedProxies), 'trustedProxies must be an array').toBeTruthy()

  const saved = await putSettings(request, { trustedProxies: ['127.0.0.1', '::1'] })
  expect(saved.ok(), await saved.text()).toBeTruthy()
  const after = await getSettings(request)
  expect(after.trustedProxies).toEqual(['127.0.0.1', '::1'])

  const bad = await putSettings(request, { trustedProxies: ['not-an-ip'] })
  expect(bad.status()).toBe(400)
  // 非法写入不落地：仍保留上一次合法值
  expect((await getSettings(request)).trustedProxies).toEqual(['127.0.0.1', '::1'])

  // 还原基线（显式空数组 = 不信任，与缺省等价）
  const restore = await putSettings(request, { trustedProxies: before.trustedProxies })
  expect(restore.ok()).toBeTruthy()
})

test('AgentGuard：start 需审批 / stop 直过 / 未知 action 失败闭合', async ({ request }) => {
  // start：428 + approvalId，审批卡 op 为隧道暴露面
  const started = await request.post(`${API_BASE}/api/remoteaccess/tunnel`, {
    headers: agentHeaders(), data: { action: 'start' },
  })
  expect(started.status()).toBe(428)
  const startBody = (await started.json()) as { approvalId?: string }
  expect(startBody.approvalId).toBeTruthy()

  const cards = await (await request.get(`${API_BASE}/api/ops-confirm`, { headers })).json() as any
  const card = (cards.data || []).find((a: any) => a.id === startBody.approvalId)
  expect(card?.op).toContain('远程接入隧道')

  // 人工允许 → 带 X-Approval-ID 重试 → 不再 428（一次性审批通过）。重试体
  // 用未知 action：审批通过后立即到 handler 并 400，避免在 e2e 里真去连 VPS
  //（审批是一次性放行，不绑定请求体；这里验的是「过闸」而非 start 业务）
  const resolved = await request.post(`${API_BASE}/api/ops-confirm/${startBody.approvalId}/resolve`, {
    headers, data: { allow: true, always: false },
  })
  expect(resolved.ok()).toBeTruthy()
  const retried = await request.post(`${API_BASE}/api/remoteaccess/tunnel`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': startBody.approvalId! },
    data: { action: 'probe-after-approval' },
  })
  expect(retried.status(), await retried.text()).toBe(400)

  // stop：降险动作，agent 无需审批直过
  const stopped = await request.post(`${API_BASE}/api/remoteaccess/tunnel`, {
    headers: agentHeaders(), data: { action: 'stop' },
  })
  expect(stopped.status()).toBe(200)

  // 未知 action：失败闭合（仍走审批，不能借拼写绕过）
  const unknown = await request.post(`${API_BASE}/api/remoteaccess/tunnel`, {
    headers: agentHeaders(), data: { action: 'explode' },
  })
  expect(unknown.status()).toBe(428)
  await resolvePendingApprovals(request, false)
})

test('UI：域名/反代模式显示 VPS 明文边界提示', async ({ page, request }) => {
  // 建一个仅用于 UI 的档案（不启动隧道，不触达 VPS）
  const settings = await getSettings(request)
  const profiles = (settings.remoteAccess?.profiles || []).filter((p: any) => p.name !== PROFILE_NAME)
  profiles.push({
    name: PROFILE_NAME, host: '127.0.0.1', port: 22, user: 'relay',
    authType: 'password', password: 'e2e-secret',
    remoteBindHost: '127.0.0.1', remotePort: 22022, domain: 'relay.example.com',
  })
  expect((await putSettings(request, { remoteAccess: { profiles } })).ok()).toBeTruthy()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('[data-testid="settings-nav-remoteaccess"]').click()
  const pane = page.locator('[data-testid="settings-pane-remoteaccess"]')
  await expect(pane).toBeVisible({ timeout: 10000 })

  const row = pane.locator('[data-testid^="settings-remote-access-profile-"]').filter({ hasText: PROFILE_NAME })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.getByRole('button', { name: '编辑' }).click()

  const warn = pane.locator('[data-testid="settings-remote-access-proxy-warn"]')
  await expect(warn).toBeVisible({ timeout: 10000 })
  await expect(warn).toContainText('VPS 内存中可见明文')
  await pane.getByRole('button', { name: '取消' }).click()
})
