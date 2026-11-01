import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡长 detail 三行钳制（P-20261003-258）：detail ≤2048 字符——多行命令
 * 输出/长散文全显撑爆卡面，长 detail 默认钳到 ~3 行（CSS line-clamp 纯视觉
 * 截断）+ 点「展开全部」解钳看全量；短 detail 原样零变化。
 *   1. 长 detail（8 行）：钳制类在场、可视高度 < 内容高度（真截断而非文案
 *      兜底）、展开钮在场；点击后解钳（类移除、可视=内容、钮退场不回折）；
 *   2. 短 detail（一行）：无钳制类、无展开钮、全文原样。
 * 夹具同 approval-target-middle-ellipsis（API 播种 + 首页断言，无需项目上下文
 * ——纯展示断言不点击裁决；afterEach 清账防残留——.aprv-card 全局常驻，污染
 * 后续用例计数）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// 长 detail 夹具：8 行命令输出（>3 行阈值，任何视口下必然溢出 3 行钳制；
// ASCII 行内容不经脱敏改写，全文断言稳定）
const LONG_DETAIL = Array.from({ length: 8 }, (_, i) => `build step ${i + 1}: compiled module_${i + 1}.ts ok`).join('\n')
const SHORT_DETAIL = '重新写入 README.md 的安装章节'

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

/** API 播种带 detail 的 pending 审批（卡面展示断言用，不点击裁决） */
async function seedDetailApproval(request: APIRequestContext, detail: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { op: 'bash', target: 'npm run build', detail },
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

test('长 detail 默认三行钳制（真截断），点「展开全部」解钳看全量', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await seedDetailApproval(request, LONG_DETAIL)

  await gotoAndUnlock(page, '/')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })

  const detail = page.locator('.aprv-card [data-test="aprv-detail"]')
  // 钳制态：clamp 类在场（-webkit-line-clamp: 3 的视觉截断承载）
  await expect(detail).toHaveClass(/aprv-detail--clamp/)
  // 真截断而非空钳制：可视高度 < 内容高度（3 行钳制 < 8 行内容）
  const before = await detail.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(before.scroll).toBeGreaterThan(before.client)
  // 展开钮在场，文案走 zh（fixedLocale）
  const expand = page.locator('.aprv-card [data-test="aprv-detail-expand"]')
  await expect(expand).toHaveText('展开全部')

  await expand.click()
  // 解钳：类移除、可视高度=内容高度、开关退场（展开后不回折）
  await expect(detail).not.toHaveClass(/aprv-detail--clamp/)
  const after = await detail.evaluate((el) => ({ client: el.clientHeight, scroll: el.scrollHeight }))
  expect(after.client).toBe(after.scroll)
  await expect(expand).toHaveCount(0)
  // 全量在场：尾行可定位（8 行内容完整呈现）
  await expect(detail).toContainText('build step 8')
})

test('短 detail 原样：无钳制类、无展开钮，全文直出', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await seedDetailApproval(request, SHORT_DETAIL)

  await gotoAndUnlock(page, '/')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })

  const detail = page.locator('.aprv-card [data-test="aprv-detail"]')
  await expect(detail).toHaveText(SHORT_DETAIL)
  await expect(detail).not.toHaveClass(/aprv-detail--clamp/)
  await expect(page.locator('.aprv-card [data-test="aprv-detail-expand"]')).toHaveCount(0)
})
