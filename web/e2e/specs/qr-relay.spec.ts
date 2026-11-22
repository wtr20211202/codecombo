import { test, expect } from '@playwright/test'
import {
  fixedLocale,
  gotoAndUnlock,
  projectCardByName,
  mockRelayAddressContext,
  RELAY_FIXTURE_LAN,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 二维码接力 E2E（P-20261002-59，配方同 palette-commands：Ctrl+K → `>` 命令模式）：
 *   - 「在手机上打开」命令 → 弹窗出现 → 二维码 canvas 渲染（尺寸 ≥240px）
 *   - 复制按钮内容 = 当前链接计算值；顶栏按钮打开同一弹窗
 *   - 携带深链开关：开=当前 origin + 当前路由，关=origin 根入口
 *
 * 地址语义（P-20261120-4 修订）：回环入口默认「自动（当前浏览器地址）」——
 * 链接即浏览器地址栏 origin；要发给别人时在下拉显式切换候选（切换语义与
 * 三方同源断言见 qr-relay-address.spec）。地址源在页面层固定
 *（mockRelayAddressContext），不依赖机器真实网卡。
 */

async function openProjectPage(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await mockRelayAddressContext(page, { addresses: [RELAY_FIXTURE_LAN], externalAccessUrl: '' })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

// 页面层 settings/network 路由在用例结束时可能仍有在途请求（后台首拉/弹窗拉取）；
// 卸载路由时忽略这些回调错误，避免 teardown 竞态把已通过用例标 flaky
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('命令面板执行后弹窗出现且二维码 canvas 渲染', async ({ page }) => {
  await openProjectPage(page)
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>在手机上打开')
  const item = page.locator('.palette-item').filter({ hasText: '在手机上打开' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  // NQRCode 默认 canvas 渲染：元素存在且可见
  const canvas = modal.locator('canvas')
  await expect(canvas).toBeVisible({ timeout: 5000 })
  // 任务书规定尺寸 240px 起——弹窗有 zoom 入场动画，轮询等几何稳定后量
  await expect.poll(async () => {
    const box = await canvas.boundingBox()
    return Math.min(box?.width ?? 0, box?.height ?? 0)
  }, { timeout: 3000 }).toBeGreaterThanOrEqual(240)
  // 回环入口红色徽标 + 自动态 hint（默认=浏览器地址栏地址，P-20261120-4）
  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('本机回环')
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('浏览器地址栏')
})

test('复制按钮内容等于自动态链接（当前地址），顶栏入口开同一弹窗', async ({ page }) => {
  await openProjectPage(page)
  // 顶栏按钮入口（命令面板链路上一用例已覆盖）
  await page.locator('[data-testid="topbar-qr-relay"]').click()
  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // 自动态：弹窗内 URL 文本 = 浏览器当前完整地址（origin/路由/query 原样保留）。
  // 用 qr-relay-url 精确锚定：合成回环候选使地址下拉恒在场，裸 input 会多匹配
  const urlInput = modal.locator('[data-testid="qr-relay-url"] input')
  const expectedUrl = page.url()
  await expect(urlInput).toHaveValue(expectedUrl)

  // 复制（localhost 为安全上下文，走 navigator.clipboard 主路径）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByRole('button', { name: '复制' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(expectedUrl)
})

test('携带深链开关：默认开=当前深链，关=当前 origin 根入口，再开复原', async ({ page }) => {
  await openProjectPage(page)
  await page.locator('[data-testid="topbar-qr-relay"]').click()
  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // QR canvas 值 / 链接输入框 / 复制按钮三者同源（同一 url 计算属性），
  // input 断言即码内容断言（canvas 像素解码不做）；qr-relay-url 精确锚定
  //（地址下拉恒在场，裸 input 会多匹配 NSelect 内部输入框）
  const input = modal.locator('[data-testid="qr-relay-url"] input')
  const toggle = modal.locator('[data-testid="qr-relay-carry-location"]')
  const fullUrl = page.url()
  const origin = new URL(fullUrl).origin

  // 默认开 = 现状：自动态深链 = 浏览器当前完整地址
  await expect(input).toHaveValue(fullUrl)
  await expect(toggle).toHaveClass(/n-checkbox--checked/)

  // 关 → 编码当前 origin 根入口（不带当前路由位置）
  await toggle.click()
  await expect(input).toHaveValue(origin + '/')
  await expect(toggle).not.toHaveClass(/n-checkbox--checked/)

  // 再开 → 回到完整深链
  await toggle.click()
  await expect(input).toHaveValue(fullUrl)
  await expect(toggle).toHaveClass(/n-checkbox--checked/)
})
