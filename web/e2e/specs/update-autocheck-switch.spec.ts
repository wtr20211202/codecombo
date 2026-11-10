import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 前端自动检查更新受「自动检查更新」开关门控 E2E（P-20261109-6）：
 *   1. 开关关 → 前端零自动检查请求：冷启动（首页挂载 + App 层 5s 首查）与 6h 周期
 *      均不发 /api/updates/check；手动「检查更新」不受开关影响（兼作计数正对照）
 *   2. 版本面板热切换（无刷新无重启）：关 → 开按冷启动节律恢复（5s 首查到达）；
 *      开 → 关即停表（再跨 6h 周期零新增）；开关展示态随点击翻转（受控 n-switch
 *      此前不回写展示态，保存成功后仍停旧位）
 *   3. 他端/agent 经 settings API 改开关（服务端 settings.changed 广播）：页面无刷新
 *      跟随——开后 5s 首查恢复，关后 6h 周期零新增
 * 时间面走 page.clock 且在 goto 前安装：App 挂载即注册的首查/周期定时器同在假时钟上
 * （安装后时间照常流动），fastForward 跳过 5s 首查 / 6h 周期零真实等待。
 * /api/updates/check 经 page.route 本地应答并计数（不外呼 GitHub）。updateChecks 是
 * 服务端全局设置：每例显式设值 + afterEach 还原 true（出厂默认——邻位
 * version-uptodate-feedback 等依赖自动检查照常）。
 */

const CHECK_ROUTE = '**/api/updates/check*'
// 与 stores/updateCheck.ts 的 AUTO_CHECK_FIRST_DELAY_MS（5s）/ AUTO_CHECK_INTERVAL_MS（6h）
// 对齐并各留余量（spec 不 import store：其依赖链含 pinia/axios/i18n 顶层 await）
const PAST_FIRST_CHECK_MS = 5000 + 1000
const PAST_INTERVAL_MS = 6 * 60 * 60 * 1000 + 60_000
// 假时钟跳过后，被触发的跳内网络往返（开关实读 → 检查请求）按真实时间落地的观察窗
const SETTLE_MS = 1500
const SAVED_TOAST = '自动检查更新设置已保存'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 他端/agent 视角改开关：经 settings API 落盘（服务端随即 settings.changed 广播） */
async function setUpdateChecks(request: APIRequestContext, on: boolean): Promise<void> {
  const res = await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { updateChecks: on },
  })
  expect(res.status()).toBe(200)
}

/** /api/updates/check 本地应答（已是最新形态：不触发「发现新版本」通知）并计到达数 */
async function countChecks(page: Page): Promise<{ calls: number }> {
  const state = { calls: 0 }
  await page.route(CHECK_ROUTE, async (route) => {
    state.calls++
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '0.0.1', hasUpdate: false } }),
    })
  })
  return state
}

/** 冷启动进首页：假时钟先于 goto 安装（App 挂载即注册的定时器同在假时钟上） */
async function bootHome(page: Page): Promise<void> {
  await fixedLocale(page)
  await page.clock.install()
  await gotoAndUnlock(page, `${API_BASE}/`)
}

/** 快进 + 真实观察窗：被触发的定时器若发请求，此窗内必已到达路由 */
async function fastForwardAndSettle(page: Page, ms: number): Promise<void> {
  await page.clock.fastForward(ms)
  await page.waitForTimeout(SETTLE_MS)
}

/** 版本面板经首页 logo 版本弹窗打开（三处入口共享同一 VersionPanel） */
async function openVersionPanel(page: Page) {
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  return card
}

/** 「设置已保存」toast 出现次数：逐元素打标只计一次（淡出/重叠不影响计数）——
 *  toast 在保存成功、开关同帧应用到自动检查电路之后弹出，计数到位即应用已生效 */
async function installSavedToastCounter(page: Page): Promise<void> {
  await page.evaluate((text) => {
    const w = window as unknown as { __savedToasts: number }
    w.__savedToasts = 0
    const scan = () => {
      document.querySelectorAll<HTMLElement>('.n-message').forEach((el) => {
        if (el.dataset.e2eCounted || !el.textContent?.includes(text)) return
        el.dataset.e2eCounted = '1'
        w.__savedToasts++
      })
    }
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true })
  }, SAVED_TOAST)
}

function savedToastCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __savedToasts: number }).__savedToasts)
}

test.afterEach(async ({ request }) => {
  // 还原出厂默认：本 spec 的全局开关改动不能泄给后续 spec
  await setUpdateChecks(request, true)
})

test('开关关：冷启动与 6h 周期零自动检查请求，手动检查不受影响', async ({ page, request }) => {
  test.setTimeout(60_000)
  await setUpdateChecks(request, false)
  const check = await countChecks(page)
  await bootHome(page)

  // 冷启动：首页挂载（已并入 store 的旧即查旁路）+ App 层 5s 首查——开关关时均不得发出
  await fastForwardAndSettle(page, PAST_FIRST_CHECK_MS)
  expect(check.calls).toBe(0)

  // 手动检查不受开关影响（兼作计数正对照：路由确实拦得到检查请求）
  const card = await openVersionPanel(page)
  await expect(card.locator('[data-testid="version-autocheck-switch"]')).toHaveAttribute('aria-checked', 'false')
  await card.locator('.version-update-section > button.panel-btn').first().click()
  await expect.poll(() => check.calls).toBe(1)

  // 6h 周期：仍零自动检查（只有上面那一次手动）
  await fastForwardAndSettle(page, PAST_INTERVAL_MS)
  expect(check.calls).toBe(1)
})

test('版本面板热切换：开即按冷启动节律恢复自动检查，关即停表（无刷新无重启）', async ({ page, request }) => {
  test.setTimeout(60_000)
  await setUpdateChecks(request, false)
  const check = await countChecks(page)
  await bootHome(page)
  await fastForwardAndSettle(page, PAST_FIRST_CHECK_MS)
  expect(check.calls).toBe(0)

  const card = await openVersionPanel(page)
  await installSavedToastCounter(page)
  const sw = card.locator('[data-testid="version-autocheck-switch"]')
  await expect(sw).toHaveAttribute('aria-checked', 'false')

  // 开：保存成功即同帧起表，展示态翻转；5s 首查到达
  await sw.click()
  await expect.poll(() => savedToastCount(page)).toBe(1)
  await expect(sw).toHaveAttribute('aria-checked', 'true')
  await page.clock.fastForward(PAST_FIRST_CHECK_MS)
  await expect.poll(() => check.calls).toBe(1)

  // 关：保存成功即停表，展示态翻转回关；跨 6h 周期零新增
  await sw.click()
  await expect.poll(() => savedToastCount(page)).toBe(2)
  await expect(sw).toHaveAttribute('aria-checked', 'false')
  await fastForwardAndSettle(page, PAST_INTERVAL_MS)
  expect(check.calls).toBe(1)
})

test('他端改开关（settings API → settings.changed 广播）：页面无刷新跟随起停', async ({ page, request }) => {
  test.setTimeout(60_000)
  await setUpdateChecks(request, false)
  const check = await countChecks(page)
  await bootHome(page)
  await fastForwardAndSettle(page, PAST_FIRST_CHECK_MS)
  expect(check.calls).toBe(0)

  // 他端开：广播到达即起表——广播往返是真实时间，轮询快进直至 5s 首查到达
  await setUpdateChecks(request, true)
  await expect.poll(async () => {
    await page.clock.fastForward(PAST_FIRST_CHECK_MS)
    return check.calls
  }, { timeout: 15_000 }).toBeGreaterThan(0)

  // 他端关：跨 6h 周期零新增（广播即停表；广播未达时每跳实读开关同样拦下）
  await setUpdateChecks(request, false)
  const before = check.calls
  await fastForwardAndSettle(page, PAST_INTERVAL_MS)
  expect(check.calls).toBe(before)
})
