import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 浏览器标签页 title 信息架构（P-20261002-21）：
 * - 首页 title = 纯品牌名「Codecombo」
 * - 项目内（/project）title = 「Codecombo — {项目名}」
 * - 前缀徽标 (n) = max(未读通知, 待审批)：API 播种 pending 审批 → 徽标即时变化
 *   （审批经 WS 广播入 approvals store，启动不回放历史 pending——page 必须先
 *   开着再造数，approval-jump 同款约束）
 * title 无 DOM 选择器面，直接断言 page.title()；共享实例的未读通知会抬徽标
 * 基数，beforeEach 先 read-all 清零，审批数才可精确断言
 * favicon 待办角标（P-20261003-65）为 title 徽标的伴生面（pin 形态可见性），
 * 与 title 同点位联动，断言 icon link 的 href/角标属性
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（全局卡片常驻 + 徽标基数，残留会污染后续用例） */
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

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
  // 未读通知清零：徽标 = max(未读, 待审批)，先归零让徽标数可精确断言
  const headers = await unlockHeaders(request)
  await request.post(`${BASE}/api/notifications/read-all`, { headers })
})

test('首页 title 为纯品牌名（无项目名后缀）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await expect(page).toHaveTitle('Codecombo', { timeout: 10000 })
})

test('播种待审批 → title 徽标含待审批数，裁决后徽标消退', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await expect(page).toHaveTitle('Codecombo', { timeout: 10000 })

  // API 播 pending 审批（approval.pending 经 WS 广播入 store）
  const headers = await unlockHeaders(request)
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'sc_e2e_title_badge', op: 'reset --hard', target: 'main', detail: 'e2e title 徽标验证' },
  })
  expect(appr.ok()).toBeTruthy()

  // 徽标 = max(未读通知=0, 待审批=1) = 1
  await expect(page).toHaveTitle('(1) Codecombo', { timeout: 10000 })

  // 裁决放行 → approval.resolved 回流清账 → 徽标归零恢复品牌名
  const list = await (await request.get(`${BASE}/api/ops-confirm`, { headers })).json()
  const pending = ((list?.data || []) as { id: string; status: string }[])
    .filter(x => x.status === 'pending')
  for (const a of pending) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
  await expect(page).toHaveTitle('Codecombo', { timeout: 10000 })
})

test('进项目 title 含项目名；回首页恢复纯品牌名且徽标跨页保留', async ({ page, request }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 进项目：title = 品牌名 — 项目名（种子项目卡，core-workflow 同款入口）
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  await expect(page).toHaveTitle('Codecombo — simple-coding', { timeout: 10000 })

  // 项目内播种 pending 审批：徽标前缀 + 项目名后缀同屏
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'sc_e2e_title_badge', op: 'push --force', target: 'main', detail: 'e2e 项目 title 验证' },
  })
  expect(appr.ok()).toBeTruthy()
  await expect(page).toHaveTitle('(1) Codecombo — simple-coding', { timeout: 10000 })

  // 回首页（TopBar 返回首页按钮）：项目名后缀消失，徽标保留（审批仍 pending）
  await page.locator('.ide-header .tool-btn[title="返回首页"]').click()
  await page.waitForURL((u) => u.pathname === '/')
  await expect(page).toHaveTitle('(1) Codecombo', { timeout: 10000 })
})

test('favicon 待办角标：播种待审批 href 换合成 dataURL，清零恢复原图标（P-20261003-65）', async ({ page, request }) => {
  // pin 形态标签页只露 favicon 不显 title——角标与 title 前缀徽标同点位联动
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const icon = page.locator('link[rel~="icon"]').first()
  const originalHref = await icon.getAttribute('href')
  expect(originalHref).toBeTruthy()
  expect(originalHref).not.toContain('data:')

  // API 播 pending 审批（上一用例同款：approval.pending 经 WS 广播入 store）
  const headers = await unlockHeaders(request)
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'sc_e2e_favicon_badge', op: 'reset --hard', target: 'main', detail: 'e2e favicon 角标验证' },
  })
  expect(appr.ok()).toBeTruthy()

  // href 换成 canvas 合成的 PNG dataURL，角标特征属性 = 档位文案（光栅 href
  // 无法文本断言，data-favicon-badge 是可观测锚）
  await expect(icon).toHaveAttribute('href', /^data:image\/png/, { timeout: 10000 })
  await expect(icon).toHaveAttribute('data-favicon-badge', '1')
  // 双 icon link（svg + ico 兜底位）同换，覆盖 Firefox「取最后一个」取用策略
  await expect(page.locator('link[rel~="icon"]').last()).toHaveAttribute('href', /^data:image\/png/)

  // 裁决放行清账 → 角标撤除、原图标 href/type 逐字面恢复
  const list = await (await request.get(`${BASE}/api/ops-confirm`, { headers })).json()
  const pending = ((list?.data || []) as { id: string; status: string }[])
    .filter((x) => x.status === 'pending')
  for (const a of pending) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
  await expect(icon).toHaveAttribute('href', originalHref!, { timeout: 10000 })
  await expect(icon).not.toHaveAttribute('data-favicon-badge')
})
