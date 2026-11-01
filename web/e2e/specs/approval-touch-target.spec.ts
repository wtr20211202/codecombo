import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批/提问卡触屏热区放大（P-20261003-128）：手机裁决/作答是移动形态核心动作，
 * tiny 按钮（naive-ui 高 22px）远小于 44px 触控指南——@media (pointer: coarse)
 * 下审批卡裁决按钮行/理由行与提问卡选项/提交按钮 min-height 40px + 间距增大；
 * fine 指针（桌面）不进该分支，呈现零变化。
 *   1. fine 指针（默认桌面上下文，无模拟）：按钮高仍 naive-ui tiny 档 22px、
 *      间距仍 8px/6px
 *   2. coarse 指针：CDP 触摸模拟 + 移动设备度量（mobile:true）——实测定
 *      Emulation.setEmulatedMedia 按 media feature 覆盖不支持 pointer 特性名，
 *      触摸模拟才是 Chromium 判定 coarse 主指针的开关（保持 1280 桌面宽度
 *      ——单变量对照，只有指针形态不同；高度放宽到 900 只是让同屏四张卡
 *      都在可点视野内，与断言无关），按钮高 ≥40px、间距增大，且裁决/作答
 *      点击链不受放大影响（可点可答）
 * 环境守卫：coarse 用例先断言 matchMedia('(pointer: coarse)').matches——模拟
 * 不生效时测试显式红（不静默假绿）。
 * 全局审批模式是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，pending 审批/提问残留统一清账防污染后续用例
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

/** 清理 pending 提问（作答清账，卡片即消失） */
async function cleanupAsks(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-ask`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-ask/${a.id}/answer`, {
      headers, data: { answer: 'cleanup' },
    })
  }
}

/** API 造 pending 审批（满种方式对齐 approval-narrow-screen 同族用例） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-128 触屏热区验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** API 造提问（等同 agent 发起，对齐 ops-ask 同族用例） */
async function seedAsk(
  request: APIRequestContext,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-ask`, { headers, data: body })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

async function approvalStatus(request: APIRequestContext, id: string): Promise<string> {
  const res = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { status?: string } }).data?.status || ''
}

/** 批量量取元素盒高（getBoundingClientRect，触控热区的地面真值） */
async function boxHeights(page: Page, selector: string): Promise<number[]> {
  return page.evaluate((sel) => {
    return Array.from(document.querySelectorAll<HTMLElement>(sel))
      .map(el => el.getBoundingClientRect().height)
  }, selector)
}

/** 量取 flex gap（computed style 归一单值） */
async function flexGap(page: Page, selector: string): Promise<string> {
  return page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)
    if (!el) return ''
    const cs = getComputedStyle(el)
    return cs.rowGap === cs.columnGap ? cs.rowGap : `${cs.rowGap}/${cs.columnGap}`
  }, selector)
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test('fine 指针（桌面）呈现零变化：按钮仍 naive-ui tiny 档 22px、间距不变', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  await seedApproval(request, 'sc-touch-fine-1', 'reset --hard')
  const card = page.locator('.aprv-card')
  await expect(card).toBeVisible({ timeout: 10000 })
  const headers = await unlockHeaders(request)
  await seedAsk(request, headers, {
    question: '检测到未推送提交，直接推送还是先变基？（e2e 触屏 fine 对照）',
    options: ['直接推送', '先变基'],
  })
  await expect(page.locator('.ask-card')).toHaveCount(1, { timeout: 10000 })

  // 桌面不进 coarse 分支：三裁决按钮高保持 naive-ui tiny 档 22px，间距 8px
  const allowBtn = card.getByRole('button', { name: '允许一次', exact: true })
  await expect(allowBtn).toBeVisible()
  for (const h of await boxHeights(page, '.aprv-actions .n-button')) {
    expect(h).toBeCloseTo(22, 0)
  }
  expect(await flexGap(page, '.aprv-actions')).toBe('8px')

  // 提问卡选项按钮同口径：22px / 6px
  for (const h of await boxHeights(page, '.ask-options .n-button')) {
    expect(h).toBeCloseTo(22, 0)
  }
  expect(await flexGap(page, '.ask-options')).toBe('6px')
})

test.describe('coarse 指针（触屏模拟）', () => {
  // 视口放宽只是让同屏两张审批卡+两张提问卡都在可点视野内（fixed 锚点自底
  // 向上生长）；pointer: coarse 与视口尺寸无关，单变量仍是「指针形态」
  test.use({ viewport: { width: 1280, height: 900 } })

  test('裁决/理由/提问按钮 ≥40px + 间距增大，点击链不受影响', async ({ page, request }) => {
    // CDP 触摸模拟 + 移动设备度量 → Chromium 判定主指针 coarse（先于导航，
    // 首帧即 coarse；media feature 名直接覆盖不支持 pointer，触摸模拟才是开关）
    const cdp = await page.context().newCDPSession(page)
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      mobile: true, width: 1280, height: 900, deviceScaleFactor: 1,
    })
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')

    // 环境守卫：模拟不生效（Chromium 行为变化）显式红，不静默假绿
    const coarse = await page.evaluate(() => matchMedia('(pointer: coarse)').matches)
    expect(coarse).toBe(true)

    await seedApproval(request, 'sc-touch-coarse-1', 'push --force')
    const card = page.locator('.aprv-card')
    await expect(card).toBeVisible({ timeout: 10000 })
    const headers = await unlockHeaders(request)
    await seedAsk(request, headers, {
      question: '检测到未推送提交，直接推送还是先变基？（e2e 触屏选项）',
      options: ['直接推送', '先变基'],
    })
    await seedAsk(request, headers, {
      question: '缺 STAGING_DATABASE_URL 的值，请提供（e2e 触屏自由文本）',
    })
    await expect(page.locator('.ask-card')).toHaveCount(2, { timeout: 10000 })

    // 热区放大生效：三裁决按钮 ≥40px（44px 指南的工程档），间距 8→12px
    for (const h of await boxHeights(page, '.aprv-actions .n-button')) {
      expect(h).toBeGreaterThanOrEqual(40)
    }
    expect(await flexGap(page, '.aprv-actions')).toBe('12px')

    // 提问卡选项与自由文本提交按钮同案放大
    for (const h of await boxHeights(page, '.ask-options .n-button')) {
      expect(h).toBeGreaterThanOrEqual(40)
    }
    expect(await flexGap(page, '.ask-options')).toBe('10px')
    for (const h of await boxHeights(page, '.ask-input-row .n-button')) {
      expect(h).toBeGreaterThanOrEqual(40)
    }
    expect(await flexGap(page, '.ask-input-row')).toBe('10px')

    // 理由行展开后确认/取消按钮同案放大（点拒绝开行 → 量取 → 取消收起）
    await card.getByRole('button', { name: '拒绝', exact: true }).click()
    await expect(card.locator('.aprv-deny-row')).toBeVisible()
    for (const h of await boxHeights(page, '.aprv-deny-row .n-button')) {
      expect(h).toBeGreaterThanOrEqual(40)
    }
    expect(await flexGap(page, '.aprv-deny-row')).toBe('10px')
    await card.getByRole('button', { name: '取消', exact: true }).click()
    await expect(card.locator('.aprv-deny-row')).toHaveCount(0)

    // 放大不破坏点击链：裁决与作答照常走通
    const approvalId = await seedApproval(request, 'sc-touch-coarse-2', 'rm -rf /tmp/x')
    await expect(page.locator('.aprv-card')).toHaveCount(2, { timeout: 10000 })
    await page.locator('.aprv-card', { hasText: 'rm -rf /tmp/x' })
      .getByRole('button', { name: '允许一次', exact: true }).click()
    await expect.poll(async () => approvalStatus(request, approvalId)).toBe('allowed')
    await page.locator('.ask-card', { hasText: '先变基' })
      .locator('.ask-option', { hasText: '先变基' }).click()
    await expect(page.locator('.ask-card')).toHaveCount(1, { timeout: 5000 })
  })
})
