import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 审批等待超时自动拒绝（P-20261003-45）：pending 审批 TTL 可配
 * （settings.agentApprovalTimeoutMin，分钟数，0=不限存量不变）——到期自动置
 * denied（理由走 P-21 通道固定为「超时自动拒绝」）+ approval.resolved 广播
 * （前端卡片一致清账）+ 通知中心入账（跳转发起会话的 terminal Action）。
 *
 * 「注入到期」：服务端无时间旅行 API，经数据面直接回拨审批文档的 createdAt
 * ——filestore Get 每次读盘（无文档级缓存），运行中改写可被服务即时感知；
 * 触发清扫走确定性通道：POST /api/ops-confirm「入队先清场」同步扫描（10min
 * 周期清扫只作生产兜底，e2e 不等表）。数据面目录按候选探测：SC_E2E_DATA_DIR
 * （e2e-restart 注入）→ 全量分片 .e2e-data/full-<port> → 默认 .e2e-data，
 * 取「确有本用例刚创建的审批文档」的那一份。
 *
 * 全局审批模式与 TTL 都是服务端共享状态：beforeEach 归位 ask+TTL=1、
 * afterEach 兜底还原 TTL=0+ask；pending 残留统一清账防污染后续用例。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const TIMEOUT_REASON = '超时自动拒绝'

// 「注入到期」依赖测试侧 fs 直改服务端数据面文档（头注机制）：仅当数据面在
// 测试侧文件系统上（Windows 实例/同机形态）可行——跨拓扑数据面在服务端
// homedir 内结构性不可见，无时间旅行 API 可替代，按环境门控 skip
// （dualpath.serverIsRemote，P-20261005-187）
test.skip(serverIsRemote, '审批文档直改依赖测试侧可见的服务端数据面，跨拓扑不可达——仅同机拓扑')

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setSettings(request: APIRequestContext, patch: Record<string, unknown>): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: patch,
  })
}

async function readSetting(request: APIRequestContext, key: string): Promise<unknown> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: Record<string, unknown> }).data?.[key]
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造 pending 审批（满种方式对齐 approval-deny-reason.spec） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-45 超时自动拒绝验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function pollApproval(request: APIRequestContext, id: string): Promise<{ status: string; reason?: string }> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data: { status: string; reason?: string } }).data
}

/** 审批文档候选路径（按序探测，取真实存在的那份）：数据面布局
 * <dataDir>/data/agentapproval/<id>.json（filestore keyPath 惯例） */
function approvalDocCandidates(id: string): string[] {
  const port = new URL(BASE).port || '80'
  const dirs: string[] = []
  if (process.env.SC_E2E_DATA_DIR) dirs.push(path.resolve(repoRoot, process.env.SC_E2E_DATA_DIR))
  dirs.push(path.join(repoRoot, '.e2e-data', `full-${port}`))
  dirs.push(path.join(repoRoot, '.e2e-data'))
  return dirs.map(dir => path.join(dir, 'data', 'agentapproval', `${id}.json`))
}

/** 注入到期：回拨审批文档 createdAt（服务运行中无同文档并发写，直改无竞态） */
function backdateApproval(id: string, minutesAgo: number): void {
  const candidates = approvalDocCandidates(id)
  const docPath = candidates.find(p => fs.existsSync(p))
  if (!docPath) {
    throw new Error(`approval doc not found, tried: ${candidates.join(', ')}`)
  }
  const doc = JSON.parse(fs.readFileSync(docPath, 'utf-8')) as Record<string, unknown>
  doc.createdAt = new Date(Date.now() - minutesAgo * 60_000).toISOString()
  fs.writeFileSync(docPath, JSON.stringify(doc))
}

test.beforeEach(async ({ request }) => {
  await setSettings(request, { agentApprovalMode: 'ask', agentApprovalTimeoutMin: 1 })
  await request.post(`${BASE}/api/notifications/clear`, { headers: await unlockHeaders(request) })
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  // TTL 归还默认 0=不限（存量行为），审批模式归位 ask
  await setSettings(request, { agentApprovalMode: 'ask', agentApprovalTimeoutMin: 0 })
  await cleanupApprovals(request)
})

test('到期 pending 自动拒绝：轮询得固定理由 + 广播清卡 + 通知带跳转', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const id = await seedApproval(request, 'sc-timeout-exp', 'reset --hard')
  const expiredCard = page.locator('.aprv-card', { hasText: 'reset --hard' })
  await expect(expiredCard).toHaveCount(1, { timeout: 10000 })

  // 注入到期（TTL=1min，回拨 5min）→ 造新审批触发「入队先清场」同步扫描
  backdateApproval(id, 5)
  const newId = await seedApproval(request, 'sc-timeout-new', 'clean -fdx')
  expect(newId).not.toBe(id)

  // 轮询旧审批：denied + P-21 通道固定理由回传（agent 据此知悉非人工否决）
  await expect.poll(async () => (await pollApproval(request, id)).status, { timeout: 10000 })
    .toBe('denied')
  const data = await pollApproval(request, id)
  expect(data.reason).toBe(TIMEOUT_REASON)

  // 前端卡片随 approval.resolved 广播一致清账：旧卡移除、新卡留在堆上仍 pending
  await expect(expiredCard).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('.aprv-card', { hasText: 'clean -fdx' })).toHaveCount(1)
  expect((await pollApproval(request, newId)).status).toBe('pending')

  // 通知中心入账：titleKey/bodyKey 模板 + 跳转发起会话的 terminal Action
  const res = await request.get(`${BASE}/api/notifications`, { headers: await unlockHeaders(request) })
  const notifs = ((await res.json()) as { data?: { titleKey?: string; bodyKey?: string; action?: string; actionPayload?: string }[] }).data || []
  const hit = notifs.find(n => n.titleKey === 'approval.timeout.notify.title')
  expect(hit, 'timeout notification recorded').toBeTruthy()
  expect(hit!.bodyKey).toBe('approval.timeout.notify.body')
  expect(hit!.action).toBe('terminal')
  expect(hit!.actionPayload).toBe('sc-timeout-exp')
})

test('TTL 配置链路：写入回读 + 越界 400 + 0=不限存量不变', async ({ request }) => {
  // 写入回读
  await setSettings(request, { agentApprovalTimeoutMin: 30 })
  expect(await readSetting(request, 'agentApprovalTimeoutMin')).toBe(30)

  // 越界拒绝（上限 1440 / 负数），原值保持
  for (const bad of [1441, -1]) {
    const res = await request.put(`${BASE}/api/settings`, {
      headers: await unlockHeaders(request),
      data: { agentApprovalTimeoutMin: bad },
    })
    expect(res.status()).toBe(400)
  }
  expect(await readSetting(request, 'agentApprovalTimeoutMin')).toBe(30)

  // 0=合法（不限）：过期 pending 不被动——回拨后触发扫描，记录仍 pending
  await setSettings(request, { agentApprovalTimeoutMin: 0 })
  const id = await seedApproval(request, 'sc-timeout-off', 'push --force')
  backdateApproval(id, 48 * 60)
  await seedApproval(request, 'sc-timeout-off-trigger', 'clean -fdx') // 触发扫描
  const data = await pollApproval(request, id)
  expect(data.status).toBe('pending')
  expect(data.reason || '').toBe('')
})
