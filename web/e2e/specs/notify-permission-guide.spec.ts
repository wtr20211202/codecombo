import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 桌面通知权限被拒引导 E2E（P-20261002-100）：
 * Notification.permission 真值由站点设置控制，e2e 无法（也不该）真拒——经
 * addInitScript 覆盖构造函数静态访问器打桩（值挂 window 变量，用例内可翻转）：
 *   1. denied：进入设置页懒检查 → 桌面通知区出现黄色提示行 + 站点设置指引链接，
 *      default 的「授予权限」请求流不出现
 *   2. granted：无提示行，照常显示已授予 + 测试按钮
 *   3. granted→denied 翻转：点「发送测试通知」懒检查接管 → 提示行出现
 *      （0d9c13e 测试按钮的失败路径补全：不再静默无学费）
 * denied 路径在通知入账前拦截（NotificationSettings.sendTestNotification 早退），
 * 本 spec 不访问通知列表 API，无播种/清理需求。
 */

const GUIDE_URL = 'https://support.google.com/chrome/answer/3220216'

function stubPermission(page: import('@playwright/test').Page, initial: 'granted' | 'denied') {
  return page.addInitScript((perm) => {
    ;(window as any).__e2eNotifPerm = perm
    Object.defineProperty(Notification, 'permission', {
      get: () => (window as any).__e2eNotifPerm,
      configurable: true,
    })
  }, initial)
}

// 进入项目 → 通知中心 → 齿轮直达设置通知页签（同 notify-dnd.spec 入口）
async function openNotifSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  return page.locator('.settings-modal .content-pane:visible')
}

test('denied：进入设置即显示黄色提示行与站点设置指引链接', async ({ page }) => {
  test.setTimeout(60000)
  await stubPermission(page, 'denied')
  const pane = await openNotifSettings(page)

  const guide = pane.locator('.permission-status.denied-guide')
  await expect(guide).toContainText('浏览器已拒绝通知权限')
  await expect(guide.locator('a.permission-guide')).toHaveAttribute('href', GUIDE_URL)
  // default 的「授予权限」请求流不出现（denied 分支接管）
  await expect(pane.locator('.permission-row')).toHaveCount(0)
})

test('granted：无提示行，照常显示已授予与测试按钮', async ({ page }) => {
  test.setTimeout(60000)
  await stubPermission(page, 'granted')
  const pane = await openNotifSettings(page)

  await expect(pane.locator('.permission-status.denied-guide')).toHaveCount(0)
  await expect(pane.locator('.permission-status.granted')).toBeVisible()
})

test('granted→denied 翻转：点测试按钮懒检查接管，提示行出现（失败路径补全）', async ({ page }) => {
  test.setTimeout(60000)
  await stubPermission(page, 'granted')
  const pane = await openNotifSettings(page)
  await expect(pane.locator('.permission-status.granted')).toBeVisible()

  // 设置页开着的间隙权限在站点设置被撤销 → 组件内快照过期
  await page.evaluate(() => { (window as any).__e2eNotifPerm = 'denied' })
  await pane.locator('.permission-status.granted .permission-recheck').click()

  const guide = pane.locator('.permission-status.denied-guide')
  await expect(guide).toContainText('浏览器已拒绝通知权限')
  await expect(guide.locator('a.permission-guide')).toBeVisible()
})
