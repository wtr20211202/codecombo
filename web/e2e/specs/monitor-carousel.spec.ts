import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 值班大屏轮播模式（P-20261005-166）E2E：
 *   - 开启轮播 → 开关即登记首幕高亮（不跳幕）→ 间隔到点滚动定位下一区块 +
 *     蓝描边高亮换幕（区块序 = instance→fleet→approvals→asks→tasks→sessions，
 *     末块回绕）；间隔档位热切换即刻生效（page.clock 假时钟快进，零真实等待）
 *   - 交互暂停：wheel（真实输入）命中 → 暂停注记在场、暂停期整倍间隔不换幕 →
 *     idle 60s 自动恢复 → 恢复后重等一个整间隔才换幕（相位重置）
 *   - 页签隐藏暂停：document.hidden 置真（实例 getter 覆盖 + visibilitychange
 *     派发，jsdom 同款手法）→ 隐藏期不换幕 → 回前台恢复
 *   - 关停清态：高亮/档位选择器/暂停注记全退场
 * 全屏引导为 best-effort（无手势上下文/策略拒绝时静默，轮播本体不依赖全屏
 * 成败）——headless 环境行为不一，不在此断言（逻辑面由 useMonitorCarousel
 * 单测与视图接线覆盖，全屏请求在 toggleCarousel 内独立 try 链）。
 * 配方同 monitor-dashboard / monitor-task-stale（API 播种 + page.clock）；
 * afterEach 清账防残留
 */

const BASE = API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留污染会话卡类目） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批（审批全局广播，残留会污染类目 pending 判定） */
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
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

/** 「建议修改默认密码」提醒遮罩会拦点击（时序不定）——出现则点「稍后提醒」收起 */
async function dismissPwdTip(page: import('@playwright/test').Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 开启轮播并切到 10s 档（假时钟下最短间隔 = 最少快进步数） */
async function enableCarousel(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="monitor-carousel-toggle"]').click()
  await expect(page.locator('[data-testid="monitor-carousel-interval"]')).toBeVisible()
  await page.locator('[data-testid="monitor-carousel-interval"]').selectOption('10')
}

/** 当前幕 testid（is-carousel-focus 落点；无高亮返回 ''） */
function focusCat(page: import('@playwright/test').Page): Promise<string> {
  return page.locator('main.mon-wall .mon-cat.is-carousel-focus')
    .evaluateAll(els => els.map(e => (e.getAttribute('data-testid') || '').replace('monitor-cat-', '')).join(','))
}

/** 播种会话 + pending 审批 + 运行中任务：卡墙满内容（区块高于视口，滚动可断言） */
async function seedContent(page: import('@playwright/test').Page, request: APIRequestContext, tag: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const session = await createAgentSessionApi(request, { name: `mon-carousel-${tag}` })
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: session.id, op: 'reset --hard', target: 'main', detail: `carousel ${tag}` },
  })
  expect(appr.ok()).toBeTruthy()
  await request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: {
      type: 'task.progress',
      payload: { task: `轮播任务 ${tag}`, step: '步骤一', status: 'running', terminalId: session.id },
    },
  })
  // 播种经 WS 广播对账，卡墙满内容后再动轮播（区块序确定性依赖类目块在场）
  await expect(page.locator('.mon-card.is-approval')).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator('.mon-card.is-task')).toHaveCount(1, { timeout: 10000 })
}

test('开启轮播 → 间隔到点滚动下一区块并高亮换幕，换档即刻生效', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()
  await dismissPwdTip(page)
  await seedContent(page, request, 'rotate')

  // 假时钟在页面加载后安装：此后新注册的定时器（轮换表在开关点击时才创建）
  // 全部走假时钟，快进零真实等待
  await page.clock.install()

  await enableCarousel(page)

  // 开关即登记首幕：instance 立即高亮、不跳幕（scrollY 仍为 0）
  await expect(page.locator('[data-testid="monitor-cat-instance"].is-carousel-focus')).toBeVisible()
  expect(await page.evaluate(() => window.scrollY)).toBe(0)

  // 一个间隔到点 → 滚动定位 fleet（window 级滚动跟随 scrollIntoView）
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('fleet')
  await expect.poll(() => page.evaluate(() => window.scrollY), { timeout: 5000 }).toBeGreaterThan(0)

  // 下一间隔 → approvals
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('approvals')

  // 换 60s 档即刻生效：59s 内不换幕，到点才走
  await page.locator('[data-testid="monitor-carousel-interval"]').selectOption('60')
  await page.clock.fastForward(59_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('approvals')
  await page.clock.fastForward(1_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('asks')
})

test('手动交互暂停 → idle 60s 自动恢复（相位重置再换幕）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()
  await dismissPwdTip(page)
  await seedContent(page, request, 'pause')
  await page.clock.install()

  await enableCarousel(page)
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('fleet')

  // 真实 wheel 输入命中（先移出轮播控件——控件自身豁免交互暂停）
  await page.mouse.move(640, 400)
  await page.mouse.wheel(0, 200)
  await expect(page.locator('[data-testid="monitor-carousel-paused"]')).toBeVisible()

  // 暂停期整倍间隔不换幕（idle 窗 60s 未满）
  await page.clock.fastForward(30_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('fleet')
  await expect(page.locator('[data-testid="monitor-carousel-paused"]')).toBeVisible()

  // idle 窗满自动恢复（注记退场），再等一个整间隔才换幕（相位重置）
  await page.clock.fastForward(30_001)
  await expect(page.locator('[data-testid="monitor-carousel-paused"]')).toHaveCount(0)
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('approvals')
})

test('隐藏页签暂停省资源，回前台恢复；关停清态', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()
  await dismissPwdTip(page)
  await seedContent(page, request, 'hidden')
  await page.clock.install()

  await enableCarousel(page)
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('fleet')

  // 置 hidden + 派发 visibilitychange（实例 getter 覆盖，jsdom 同款手法）
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(30_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('fleet') // 隐藏期不换幕

  // 回前台恢复
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(10_000)
  await expect.poll(() => focusCat(page), { timeout: 5000 }).toBe('approvals')

  // 关停清态：高亮退场、档位选择器与暂停注记全收
  await page.locator('[data-testid="monitor-carousel-toggle"]').click()
  await expect(page.locator('main.mon-wall .mon-cat.is-carousel-focus')).toHaveCount(0)
  await expect(page.locator('[data-testid="monitor-carousel-interval"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="monitor-carousel-paused"]')).toHaveCount(0)
})
