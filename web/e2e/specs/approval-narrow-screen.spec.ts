import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡窄屏适配（P-20261003-104）：卡片栈锚点（.agent-input-stack，App 层
 * 审批+提问卡共用）原固定 width:320px（P-20261003-87 拆分后锚点自 .aprv-stack
 * 上移至 App 包装层），窄视口（手机裁决场景/分屏半宽）横向溢出被裁——
 *   1. 宽视口（1280）：栈宽仍 320px（min 取常量档，呈现零变化）
 *   2. 窄视口（320）：钳到 calc(100vw - 32px)=288px，卡片完整可见不被裁，
 *      裁决按钮行允许换行仍可点（点「允许一次」走通裁决闭环）
 * 全局审批模式是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，pending 残留统一清账防污染后续用例
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 全局审批模式置位（还原都走这一口） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
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

/** API 造 pending 审批（满种方式对齐 approval-stack-collapse 同族用例） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-104 窄屏适配验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('宽视口呈现零变化：卡片栈锚点仍 320px', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  await seedApproval(request, 'sc-narrow-wide-1', 'reset --hard')
  const card = page.locator('.aprv-card')
  await expect(card).toBeVisible({ timeout: 10000 })

  // 锚点宽度与单卡宽度都还是常量档 320px（min 上界不生效）
  const stackWidth = await page.evaluate(
    () => getComputedStyle(document.querySelector('.agent-input-stack')!).width,
  )
  expect(stackWidth).toBe('320px')
  expect(await card.evaluate(el => el.getBoundingClientRect().width)).toBeCloseTo(320, 0)
})

test.describe('窄视口 320px（手机裁决场景）', () => {
  test.use({ viewport: { width: 320, height: 568 } })

  test('卡片完整可见不被裁，裁决按钮换行仍可点', async ({ page, request }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')

    const id = await seedApproval(request, 'sc-narrow-small-1', 'push --force')
    const card = page.locator('.aprv-card')
    await expect(card).toBeVisible({ timeout: 10000 })

    // 锚点钳宽生效：320 - 32 = 288px
    const stackWidth = await page.evaluate(
      () => getComputedStyle(document.querySelector('.agent-input-stack')!).width,
    )
    expect(stackWidth).toBe('288px')

    // 卡片横向完整落在视口内（不被右缘 16px 锚定挤出裁切）
    const box = await card.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.x).toBeGreaterThanOrEqual(0)
    expect(box!.x + box!.width).toBeLessThanOrEqual(320)

    // 按钮行允许换行保可点：flex-wrap 生效 + 点「允许一次」走通裁决闭环
    const actionsWrap = await page.evaluate(
      () => getComputedStyle(document.querySelector('.aprv-actions')!).flexWrap,
    )
    expect(actionsWrap).toBe('wrap')
    await card.getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(async () => approvalStatus(request, id)).toBe('allowed')
  })
})
