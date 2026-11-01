import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 广播输入覆盖远程主机终端（P-20261005-11）——AgentGuard 高危确认链 + 混合目标
 * 契约 E2E（纯 API 链路，agent 是 API 调用方无前端页面；agent-sensitive-write-guard
 * 同款形态）：
 *   1. 高危确认链全链必验：agent 令牌 POST broadcast-write → 428 + approvalId
 *      （code=ops.approval_required，审批卡 op 以「终端广播输入」为前缀——远程
 *      目标同防，op 文案前缀兼容扩展不改存量规则匹配）→ 用户裁决允许 → 携
 *      X-Approval-ID 重试 → 200 真写入本地会话（scrollback 收到）→ 一次性语义
 *      （同 ID 重放重新 428）。
 *   2. 混合目标契约：本地会话 + 远程形态 id（32 hex，无对应远程主机）一次发 →
 *      written 只计本地（远程半边真命中由 Go 单测覆盖），远程形态 id 落 missing
 *      不阻塞本地照发（逐会话跳过语义跨两端），failedHosts 恒序列化数组。
 * 远程真会话的实流（SSH 双端收到/断连 failed 带主机标注）依赖 sshd 环境，
 * 由 server/api/terminal/broadcast_mixed_test.go 假 PTYConn 单测确定性覆盖。
 */

const BASE = API_BASE

async function unlockHeaders(request: import('@playwright/test').APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let agentToken = ''
let sessionId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // agent 令牌明文（管理面 reveal，单例播种语义）
  const revealed = await request.post(`${BASE}/api/agent-token/reveal`, { headers })
  expect(revealed.ok()).toBeTruthy()
  agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()

  // 目标会话（kind=agent 免项目绑定；广播高危链的落点与混合契约的本地半边）
  const created = await request.post(`${BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'bc-guard-e2e', runtime: 'shell' },
  })
  sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  if (!sessionId) throw new Error('agent session create failed')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (sessionId) await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
})

const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })

test('广播 AgentGuard 全链：agent 428 → 审批允许 → 重试 200 真写入（一次性）', async ({ request }) => {
  const MARKER = `sc-bc-guard-${Date.now()}`

  // agent 令牌首调 → 428 + approvalId（未写入零副作用）。
  // data 为原始 PTY 输入：API 直调执行命令须自带尾部换行（UI 广播条自动补）
  const first = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers: agentHeaders(), data: { ids: [sessionId], data: `echo ${MARKER}\r` },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string; code?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')

  // 审批卡：op 以「终端广播输入」为前缀（P-20261005-11 扩展「（本地+远程终端）」
  // 不破前缀匹配——存量审批规则与断言同语义）
  const uh = await unlockHeaders(request)
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${guard.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('终端广播输入')).toBeTruthy()

  // 用户裁决允许 → 携 X-Approval-ID 重试 → 200 真写入（scrollback 收到）
  const resolved = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { ids: [sessionId], data: `echo ${MARKER}\r` },
  })
  expect(retry.status()).toBe(200)
  const body = (await retry.json()) as { data?: { written?: number; missing?: string[]; failed?: string[]; failedHosts?: unknown[] } }
  expect(body.data?.written).toBe(1)
  expect(body.data?.missing).toEqual([])
  expect(body.data?.failed).toEqual([])
  // failedHosts 恒序列化数组（前端解构安全；无远程失败 = 空）
  expect(body.data?.failedHosts).toEqual([])
  let got = false
  for (let i = 0; i < 10 && !got; i++) {
    await new Promise(r => setTimeout(r, 600))
    const sb = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers: uh })
    if (sb.ok()) got = (await sb.body()).toString('utf8').includes(MARKER)
  }
  expect(got, 'session scrollback should contain marker after approval retry').toBe(true)

  // 一次性语义：同 ID 二次重试 → 已消费，重新 428（重建新审批）
  const replay = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! },
    data: { ids: [sessionId], data: `echo ${MARKER}\r` },
  })
  expect(replay.status()).toBe(428)
})

test('混合目标契约：本地会话 + 远程形态 id 一次发，本地照发远程 id 落 missing', async ({ request }) => {
  const uh = await unlockHeaders(request)
  // 远程形态 id（32 hex crypto/rand 同形）：无对应远程主机/会话 → 落 missing
  const remoteShaped = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
  const res = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers: uh, data: { ids: [sessionId, remoteShaped], data: 'echo mixed-targets\r' },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data?: { written?: number; missing?: string[]; failed?: string[]; failedHosts?: unknown[] } }
  expect(body.data?.written).toBe(1) // 本地半边照发，不掉队
  expect(body.data?.missing).toEqual([remoteShaped])
  expect(body.data?.failed).toEqual([])
  expect(body.data?.failedHosts).toEqual([]) // 恒数组：无远程失败无主机标注
})
