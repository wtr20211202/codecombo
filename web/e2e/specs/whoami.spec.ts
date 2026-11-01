import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 令牌自校验端点 /api/whoami（P-20261004-15）E2E：
 *   1. agent 令牌（sca_）→ tokenKind=agent；解锁令牌（scl_）→ tokenKind=unlock；
 *      version 与 capabilities 摘要在位（capabilities 沿 /api/meta 注册表）
 *   2. 无效令牌 → 401 且错误信息区分令牌族。e2e 种子态锁定关闭（e2e-seed.sh 金态），
 *      中间件放行、whoami 自校验可达——正是 agent 引导的真实调用态；锁定开启时
 *      同请求被 LockMiddleware 423 先行拦下（凭据拒绝语义一致，Go 单测覆盖该分支）
 *   3. terminalId：X-Session-ID（操作手册约定携带 $CC_TERMINAL_ID）指向的会话
 *      仍在时回显，幽灵会话省略——引导期即可发现会话丢失
 *   4. instance 块（P-20261004-133）：agent 令牌自定位「我在哪台」——instanceName
 *      与实例注册库本机条目同源对账、instanceId 数据目录级持久身份、port 实测对账
 *      请求端口；无 claim 形态的缺省回落（注册库无本机条目 → host:port）生产实例
 *      不可达（启动装配即建档），由 Go 单测 whoami_test.go InstanceBlock 三例锁定
 *   5. sessions 配额块（P-20261006-30）：批量开会前的预检原语——max/current 恒在、
 *      存活数不越上限、创建真会话后 current 计入；max 与创建准入同源（单测对账
 *      terminal.MaxSessions，e2e 只验形状与 ≥1 的下界不钉配置值）
 *
 * 纯 API 链路（whoami 是 agent 引导原语，无前端页面）；tokenKind 判别与 401
 * 区分的分支矩阵由 Go 单测锁定（server/api/whoami_test.go）。
 */

const SESSION_NAME_PREFIX = 'e2e-whoami-'
// 已投用能力项抽样（与 server/app/modules.go 的 manifest 声明对应）
const SAMPLE_CAPS = ['notes', 'flat-file-list']

interface SessionInfo { id?: string; name?: string; kind?: string }
// instance 块（P-20261004-133）：whoami 实例自定位三件套
interface WhoamiInstance { instanceName?: string; instanceId?: string; port?: number }
// sessions 块（P-20261006-30）：会话配额 {max 单进程上限, current 存活数快照}
interface WhoamiSessions { max?: number; current?: number }

let unlockToken = ''
let sessionId = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  expect(token, 'unlock should issue a token in seeded state').toBeTruthy()
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function whoami(headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}/api/whoami`, { headers })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function cleanupSession() {
  if (!sessionId) return
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/terminals/${sessionId}`, { method: 'DELETE', headers }).catch(() => {})
  sessionId = ''
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  unlockToken = headers['X-Lock-Token']
  // 清上轮中断遗留的同名前缀会话（会话名唯一化用前缀+时间戳，重跑不冲突也要清）
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await res.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith(SESSION_NAME_PREFIX) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
})

test.afterAll(async () => {
  await cleanupSession()
})

test('agent 令牌 → tokenKind=agent，version/capabilities 摘要在位', async () => {
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const reveal = await fetch(`${API_BASE}/api/agent-token/reveal`, { method: 'POST', headers })
  expect(reveal.status).toBe(200)
  const agentToken = ((await reveal.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()

  const { status, body } = await whoami({ 'X-Lock-Token': agentToken })
  expect(status).toBe(200)
  expect(body.tokenKind).toBe('agent')
  expect(typeof body.version).toBe('string')
  expect(body.version.length).toBeGreaterThan(0)
  // capabilities 摘要：数组非空且含已注册能力项（与 /api/meta 同源）
  expect(Array.isArray(body.capabilities)).toBe(true)
  for (const cap of SAMPLE_CAPS) {
    expect(body.capabilities).toContain(cap)
  }
})

test('instance 块：agent 令牌自定位「我在哪台」——本实例名/持久身份/实测端口', async () => {
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const reveal = await fetch(`${API_BASE}/api/agent-token/reveal`, { method: 'POST', headers })
  expect(reveal.status).toBe(200)
  const agentToken = ((await reveal.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()

  const { status, body } = await whoami({ 'X-Lock-Token': agentToken })
  expect(status).toBe(200)
  const inst = body.instance as WhoamiInstance | undefined
  // 块恒在且三字段齐备——引导原语对「我在哪」恒有答案（实例块无 omitempty）
  expect(inst, 'instance block should always be present').toBeTruthy()
  expect(typeof inst?.instanceName).toBe('string')
  expect(inst?.instanceName?.length ?? 0).toBeGreaterThan(0)
  // instanceId 是数据目录级持久身份（claims.InstanceID，UUID 形态）
  expect(inst?.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)

  // 跨源实测：本实例名 = 实例注册库本机条目的登记名（GET /api/instances 同源，
  // 多机 agent 上报/日志带它做归属追溯）
  const list = await fetch(`${API_BASE}/api/instances`, { headers })
  expect(list.status).toBe(200)
  const instances = ((await list.json()) as { data?: Array<{ name?: string; isLocal?: boolean }> }).data || []
  const local = instances.find(i => i.isLocal)
  expect(local, 'seeded instance should have a local registry entry').toBeTruthy()
  expect(inst?.instanceName).toBe(local?.name)

  // 实测注记：port 与实际请求端口对账——whoami 报的就是「本实例在哪个端口监听」
  expect(String(inst?.port)).toBe(new URL(API_BASE).port)
})

test('sessions 配额块：max/current 恒在，存活数计入且不越上限（P-20261006-30）', async () => {
  // 预检原语的形状契约：块与两字段恒在（零会话也是合法答案）
  const before = await whoami({ 'X-Lock-Token': unlockToken })
  expect(before.status).toBe(200)
  const quota = before.body.sessions as WhoamiSessions | undefined
  expect(quota, 'sessions block should always be present').toBeTruthy()
  expect(typeof quota?.max).toBe('number')
  expect(typeof quota?.current).toBe('number')
  expect(quota?.current).toBeGreaterThanOrEqual(0)
  // max 是创建路径准入的生效值（可配化 P-20261006-12，不钉具体配置值只验下界）
  expect(quota?.max).toBeGreaterThanOrEqual(1)
  // 存活数不越上限——超限创建必败的预检前提
  expect(quota?.current).toBeLessThanOrEqual(quota?.max as number)

  // 正向链路：真会话创建后 current 计入（≥1；并行 worker 的其他 spec 可能
  // 同时增减存量会话，不做精确 ±1 断言避免竞态误报——快照语义本就允许漂移）
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const create = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', name: `${SESSION_NAME_PREFIX}${Date.now()}` }),
  })
  expect(create.status).toBe(200)
  const created = ((await create.json()) as { data?: SessionInfo }).data
  sessionId = created?.id || ''
  expect(sessionId, 'agent session should be created').toBeTruthy()

  const after = await whoami({ 'X-Lock-Token': unlockToken })
  expect(after.status).toBe(200)
  const quotaAfter = after.body.sessions as WhoamiSessions | undefined
  expect(quotaAfter?.current).toBeGreaterThanOrEqual(1)
  expect(quotaAfter?.current).toBeLessThanOrEqual(quotaAfter?.max as number)

  await cleanupSession()
})

test('解锁令牌 → tokenKind=unlock', async () => {
  const { status, body } = await whoami({ 'X-Lock-Token': unlockToken })
  expect(status).toBe(200)
  expect(body.tokenKind).toBe('unlock')
})

test('无效令牌 → 401 且错误信息区分令牌族', async () => {
  // sca_ 坏值：指向 agent 令牌族（轮换/撤销后旧 env 值的典型形态）
  const agentFail = await whoami({ 'X-Lock-Token': 'sca_deadbeef' })
  expect(agentFail.status).toBe(401)
  expect(String(agentFail.body?.error)).toContain('agent token')

  // scl_ 坏值：指向解锁令牌族（TTL 过期/服务重启后的典型形态）
  const unlockFail = await whoami({ 'X-Lock-Token': 'scl_bogus' })
  expect(unlockFail.status).toBe(401)
  expect(String(unlockFail.body?.error)).toContain('unlock token')

  // 无凭据：引导原语对「什么都没带」同样给明确 401，而非含糊 200
  const noCred = await whoami({})
  expect(noCred.status).toBe(401)
  expect(String(noCred.body?.error)).toContain('no credential')
})

test('terminalId：X-Session-ID 存活会话回显，幽灵会话省略', async () => {
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const create = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', name: `${SESSION_NAME_PREFIX}${Date.now()}` }),
  })
  expect(create.status).toBe(200)
  const created = ((await create.json()) as { data?: SessionInfo }).data
  sessionId = created?.id || ''
  expect(sessionId, 'agent session should be created').toBeTruthy()

  // 存活会话：terminalId 原样回显
  const live = await whoami({ 'X-Lock-Token': unlockToken, 'X-Session-ID': sessionId })
  expect(live.status).toBe(200)
  expect(live.body.terminalId).toBe(sessionId)

  // 幽灵会话：字段整体省略（omitempty），不回显无效 id
  const ghost = await whoami({ 'X-Lock-Token': unlockToken, 'X-Session-ID': 'sc-ghost-whoami' })
  expect(ghost.status).toBe(200)
  expect(ghost.body.terminalId).toBeUndefined()

  await cleanupSession()
})
