import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批 List 的 limit/status 查询参数（P-20261003-254）：GET /api/ops-confirm
 * 默认不传 = 全量（兼容既有消费方）；status 过滤只回该状态；limit 收敛为最新
 * N 条（服务端最新在前排序）。任务书验证面：
 *   1. limit 传 → 条数收敛（全量 N 条中只回 2 条，且为最新 2 条——按 id 归属
 *      本用例新建记录断言，脏数据面的存量 resolved 更旧不进窗口）
 *   2. pending 过滤 → 只回 pending（含本用例两条、不含存量 resolved），且大屏
 *      补账（MonitorView.seedApprovals 现传 status=pending）冷启动照常出卡
 *   3. 非法 status → 400 + 稳定码 ops.confirm_status_invalid；默认无参全量兼容
 * 审批记录无删除端点（30 天保留档），resolved 跨用例累积：断言一律按本 spec
 * 唯一前缀 + 新建 id 集过滤；workers=1 同实例串行，本 spec 先于断言清空 pending
 * （resolved 的 CreatedAt 恒早于本用例新建，不影响「最新 N 条」归属判定）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PREFIX = 'list-params-e2e'

interface ApprovalRow {
  id: string
  op: string
  status: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listApprovals(request: APIRequestContext, query = ''): Promise<ApprovalRow[]> {
  const res = await request.get(`${BASE}/api/ops-confirm${query}`, { headers: await unlockHeaders(request) })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data?: ApprovalRow[] }).data || []
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  for (const a of (await listApprovals(request)).filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造 pending 审批（op 带本 spec 前缀），返回 id */
async function createPending(request: APIRequestContext, op: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { op: `${PREFIX} ${op}`, target: 'main', detail: 'e2e 列表参数验证' },
  })
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data?: { id?: string; status?: string } }).data
  expect(body?.id).toBeTruthy()
  expect(body?.status).toBe('pending')
  return body!.id!
}

/** 毫秒级停顿（创建间隔拉开 CreatedAt，避免同毫秒 tiebreak 影响截断归属） */
function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('limit 传 → 条数收敛为最新 N 条（默认无参全量兼容）', async ({ request }) => {
  test.setTimeout(60000)
  // 三条 pending 的 CreatedAt 即现在，晚于实例存量 resolved（同实例串行前提）；
  // 创建间隔 20ms 保证 CreatedAt 严格递增（Windows 时钟精度兜底，e2e 不依赖
  // 同毫秒 tiebreak——排序语义的精确断言在 Go 单测可控时间线上锁定）
  const ids: string[] = []
  for (const op of ['limit-a', 'limit-b', 'limit-c']) {
    ids.push(await createPending(request, op))
    await sleepMs(20)
  }

  // 默认无参 = 全量兼容：本用例三条全在
  const full = await listApprovals(request)
  for (const id of ids) {
    expect(full.some(a => a.id === id)).toBe(true)
  }

  // limit=2 → 恰 2 条：本用例最新两条（b/c）在窗口内、最旧的 a 被截掉；
  // 存量的更旧记录同样不进窗口（b/c 之间不比先后，e2e 只锁截断语义）
  const limited = await listApprovals(request, '?limit=2')
  expect(limited).toHaveLength(2)
  expect(limited.every(a => ids.includes(a.id) && a.id !== ids[0])).toBe(true)

  // limit 收敛是截断不是过滤：limit 大于全量时原样全回
  const overLimit = await listApprovals(request, `?limit=500`)
  expect(overLimit.length).toBeGreaterThanOrEqual(full.length)
})

test('status=pending 过滤 → 只回 pending；大屏补账冷启动照常出卡', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  // 页面未在场先造 pending：大屏卡片唯一来路是挂载补账（现走 status=pending 过滤）
  const idA = await createPending(request, 'filter-a')
  const idB = await createPending(request, 'filter-b')

  const pending = await listApprovals(request, '?status=pending')
  // 只回 pending：本用例两条全在；存量 resolved（含上一用例留下的）不出现
  expect(pending.some(a => a.id === idA)).toBe(true)
  expect(pending.some(a => a.id === idB)).toBe(true)
  expect(pending.every(a => a.status === 'pending')).toBe(true)
  // 对照：resolved 过滤不含本用例 pending id（过滤真的按状态分桶）
  const resolved = await listApprovals(request, '?status=allowed')
  expect(resolved.every(a => a.id !== idA && a.id !== idB)).toBe(true)

  // 大屏补账消费方（MonitorView.seedApprovals 传 status=pending）端到端：
  // 冷启动进 /monitor，审批卡出现（服务端过滤后的 pending 回填链路完好）
  await gotoAndUnlock(page, `${BASE}/monitor`)
  const card = page.locator('.mon-card.is-approval')
  await expect(card).toHaveCount(2, { timeout: 10000 })
  await expect(card.filter({ hasText: `${PREFIX} filter-a` })).toHaveCount(1)
})

test('非法 status → 400 稳定码；空 status 过滤值视同全量', async ({ request }) => {
  test.setTimeout(60000)
  const id = await createPending(request, 'invalid-status')

  // 枚举外值 → 400 + 稳定码（agent 按 code 分支自纠，勿静默回全量误读语义）
  const res = await request.get(`${BASE}/api/ops-confirm?status=bogus`, {
    headers: await unlockHeaders(request),
  })
  expect(res.status()).toBe(400)
  const body = (await res.json()) as { code?: string }
  expect(body.code).toBe('ops.confirm_status_invalid')

  // status 空串（?status=）= 未携带 → 全量兼容形态
  const rows = await listApprovals(request, '?status=')
  expect(rows.some(a => a.id === id)).toBe(true)
})
