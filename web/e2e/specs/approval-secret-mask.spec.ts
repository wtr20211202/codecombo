import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批记录密钥脱敏（P-20261003-197）：agent 误在命令里带密钥（curl -H
 * "Authorization: Bearer sk-…"）——Target/Detail/impact 入库前过
 * mask.MaskApprovalText（记录/卡面广播/webhook 外发同源收敛），卡面展示再兜底
 * 一层（记录面与展示面的双保护）。验证三面：
 *   1. 卡面：target/detail 呈现遮蔽形态（前缀 + *** + 尾 4，首尾可读），
 *      明文不出现在卡面 DOM；
 *   2. 记录面：GET /api/ops-confirm 回读 target/detail 无明文原值（原值不落库）；
 *   3. 误判容忍：纯 hex git SHA / task- 连字 ID / 普通路径原样保留（首尾保留
 *      + 三类字符校验的误判容忍面）。
 * afterEach 清账防残留（.aprv-card 全局常驻，残留污染后续用例计数）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// 语料（与 server/mask/redact_test.go / sensitiveMask.test.ts 互锁同源）：
const SK_TARGET = 'curl -H "Authorization: Bearer sk-proj-abc123XYZdef456GHI789" api.example.com'
const SK_MASKED = 'sk-***I789'
const GHP_TOKEN = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'
const GHP_MASKED = 'ghp_***3456'
const JWT_SEG = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
const JWT_MASKED = 'eyJh***VCJ9'
const GIT_SHA = 'a591a6d40bf420404a011733cfb7b190d62c65bf0bcda32b57b277d9ad9f146e'
const TASK_ID = 'task-20241103-0012345'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
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

/** API 造带密钥的 pending 审批，返回 id */
async function createSecretPending(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const detail = `部署触发：${GHP_TOKEN} 与 ${JWT_SEG}.payload；校验 ${GIT_SHA}（${TASK_ID}）`
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { op: 'deploy run', target: SK_TARGET, detail },
  })
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data?: { id?: string } }).data
  expect(body?.id).toBeTruthy()
  return body!.id!
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('带密钥审批：卡面遮蔽显示且明文不落库（记录面+展示面双保护）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  const id = await createSecretPending(request)

  // 记录面：入库前已脱敏——列表回读无明文原值（原值不落库）
  const headers = await unlockHeaders(request)
  const listRes = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await listRes.json()) as { data?: { id: string; target?: string; detail?: string }[] }).data || []
  const rec = list.find(x => x.id === id)
  expect(rec).toBeTruthy()
  expect(rec!.target).toContain(SK_MASKED)
  expect(rec!.target).not.toContain('sk-proj-abc123XYZdef456GHI789')
  expect(rec!.detail).toContain(GHP_MASKED)
  expect(rec!.detail).toContain(JWT_MASKED)
  expect(rec!.detail).not.toContain(GHP_TOKEN)
  // 误判容忍：git SHA / task- 连字 ID 原样保留（首尾可读性）
  expect(rec!.detail).toContain(GIT_SHA)
  expect(rec!.detail).toContain(TASK_ID)

  // 展示面：卡面呈现遮蔽后文本，明文不出现在卡面 DOM
  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText(SK_MASKED)
  await expect(card).toContainText(GHP_MASKED)
  await expect(card).toContainText(JWT_MASKED)
  await expect(card).not.toContainText('sk-proj-abc123XYZdef456GHI789')
  await expect(card).not.toContainText(GHP_TOKEN)
  // 首尾可读性：遮蔽不掩盖普通语境（SHA/任务 ID 完整可见）
  await expect(card).toContainText(GIT_SHA)
  await expect(card).toContainText(TASK_ID)
})
