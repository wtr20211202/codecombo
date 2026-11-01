import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 全局断连指示条 E2E（P-20261002-5）
 *
 * 覆盖：
 * - 项目 WS 被 routeWebSocket 截胡（连接即被关闭，模拟网络切换/离线）→
 *   500ms 防闪烁延迟后顶栏下方横条出现
 * - 切回直通 + window 'online' 事件（useWebSocketBase.handleRecovery 的
 *   恢复触发器，立即重连并重置退避，不吃 3s 指数退避）→ 横条立即消失且保持隐藏
 * - 短暂断连（500ms 防闪烁窗口内恢复）→ 横条不闪现
 *
 * 截胡只匹配项目 WS（/ws/projects/:id），通知/克隆/ops-channel WS 与全部
 * HTTP API 不受影响，页面交互照常。恢复不用 unrouting（本版 Playwright
 * 无 unrouteWebSocket）：handler 按 offline 标记决定关闭还是 connectToServer
 * 直通，同一截胡横跨断开与恢复两个阶段。锁定态不显示的分支由
 * useWsDisconnectBar 内联布尔门控保证，此处不重复搭锁定开关
 * （lock.spec 已维护全局锁定状态）。
 */

const BAR = '[data-testid="ws-disconnect-bar"]'
const WS_PATTERN = /\/ws\/projects\/[^/]+$/

/** 从首页进入项目页（WS 处于被截胡断开的离线期）。
 *  返回恢复函数：调用后新连接直通服务端（配合 window 'online' 立即重连） */
async function enterProjectPage(page: Page): Promise<() => void> {
  let offline = true
  await page.routeWebSocket(WS_PATTERN, ws => {
    if (offline) {
      void ws.close()
      return
    }
    void ws.connectToServer()
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  return () => { offline = false }
}

test.describe('全局断连指示条', () => {
  test('项目 WS 断开 → 防闪烁延迟后横条出现', async ({ page }) => {
    await fixedLocale(page)
    await enterProjectPage(page)

    const bar = page.locator(BAR)
    await expect(bar).toBeVisible({ timeout: 5000 })
    await expect(bar).toContainText('连接已断开，正在重连…')
  })

  test('恢复路由 → 横条立即消失且保持隐藏', async ({ page }) => {
    await fixedLocale(page)
    const goOnline = await enterProjectPage(page)
    await expect(page.locator(BAR)).toBeVisible({ timeout: 5000 })

    // 恢复：新连接放行直通服务端；window 'online' 事件触发立即重连
    goOnline()
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    await expect(page.locator(BAR)).toBeHidden({ timeout: 5000 })
    // 消失后保持隐藏（覆盖横条出现所需的 500ms 窗口仍有余量）
    await page.waitForTimeout(800)
    await expect(page.locator(BAR)).toHaveCount(0)
  })

  test('短暂断连（500ms 防闪烁窗口内恢复）→ 横条不闪现', async ({ page }) => {
    await fixedLocale(page)
    const goOnline = await enterProjectPage(page)

    // 进入项目页即截胡断开（计时起点），立刻放行 + online 触发立即重连，
    // 整个断连窗口 < 500ms——重连风暴式的 connected 抖动不应让横条闪现
    goOnline()
    await page.evaluate(() => window.dispatchEvent(new Event('online')))

    // 等过防闪烁窗口（500ms）+ 重连落定 + 余量，横条始终不应出现
    await page.waitForTimeout(1500)
    await expect(page.locator(BAR)).toHaveCount(0)
  })
})
