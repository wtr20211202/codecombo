import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡长路径中段省略（P-20261003-231）：路径形态 target 的卡面展示文本
 * JS 中段截断（前 20 + … + 后 24 码点）——CSS ellipsis 单行尾裁对长路径恰
 * 裁掉文件名（目录前缀吞文件名），中段省略保首尾：头段目录形态可辨、尾段
 * 文件名恒完整；全量路径恒在 title tooltip（悬停核对）。
 *   1. 长路径 target（>45 码点）：卡面 = 前 20 + … + 后 24（文件名完整），
 *      全文不落卡面 DOM，title = 全量；
 *   2. 短路径 target（阈值内）：卡面原样，title 同文。
 * 夹具同 approval-secret-mask（API 播种 + 首页断言，无需项目上下文——纯
 * 展示断言不点击，点击链归 approval-target-preview）；afterEach 清账防
 * 残留（.aprv-card 全局常驻，污染后续用例计数）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// 长路径夹具（>45 码点；ASCII——期望展示式按 UTF-16 slice 镜像实现口径；
// 文件名段 ≤24 码点，尾段完整保住文件名——提案「文件名恒可见」的演示形态）
const LONG_TARGET = 'src/features/approval/components/approvalCards/sections/ApprovalCardSection.vue'
const HEAD = 20
const TAIL = 24
const LONG_DISPLAY = LONG_TARGET.slice(0, HEAD) + '…' + LONG_TARGET.slice(-TAIL)
const SHORT_TARGET = 'docs/notes.md'

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

/** API 播种路径形态 pending 审批（卡面展示断言用，不点击） */
async function seedPathApproval(request: APIRequestContext, target: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { op: 'write', target, detail: 'P-20261003-231 中段省略验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('长路径 target 卡面中段省略（保首尾，文件名完整），tooltip 全量', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await seedPathApproval(request, LONG_TARGET)

  await gotoAndUnlock(page, '/')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })

  const link = page.locator('.aprv-card [data-test="aprv-target-link"]')
  // 展示文本恰为 前 20 + … + 后 24：尾段文件名完整可见（CSS 尾裁的痛点消除）
  await expect(link).toHaveText(LONG_DISPLAY)
  // 全文不落卡面 DOM——省略是真实的（title 属性除外，非文本内容）
  await expect(page.locator('.aprv-card')).not.toContainText(LONG_TARGET)
  // tooltip 全量：完整路径留在 title 供悬停核对
  await expect(link).toHaveAttribute('title', LONG_TARGET)
})

test('短路径 target 原样展示（阈值内不处理），title 同文', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await seedPathApproval(request, SHORT_TARGET)

  await gotoAndUnlock(page, '/')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })

  const link = page.locator('.aprv-card [data-test="aprv-target-link"]')
  await expect(link).toHaveText(SHORT_TARGET)
  await expect(link).toHaveAttribute('title', SHORT_TARGET)
})
