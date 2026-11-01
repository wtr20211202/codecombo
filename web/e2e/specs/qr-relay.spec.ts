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
 *   - 复制按钮内容 = 改写后的局域网地址（P-20261019-10：localhost 入口不再编码
 *     回环地址）；顶栏按钮打开同一弹窗
 *   - 携带深链开关：开=LAN origin + 当前路由，关=LAN origin 根入口
 *
 * 地址源在页面层固定（mockRelayAddressContext）：e2e 实例以 localhost 打开，
 * 真实网卡清单随机器漂移，固定候选让码内容可确定性断言。
 */

async function openProjectPage(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await mockRelayAddressContext(page, { addresses: [RELAY_FIXTURE_LAN], externalAccessUrl: '' })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** 局域网候选 origin（沿用当前页面协议/端口） */
function lanOrigin(pageUrl: string): string {
  const u = new URL(pageUrl)
  return `${u.protocol}//${RELAY_FIXTURE_LAN.ip}${u.port ? `:${u.port}` : ''}`
}

/** 携带当前位置的完整 LAN 深链 */
function lanDeepLink(pageUrl: string): string {
  const u = new URL(pageUrl)
  return `${lanOrigin(pageUrl)}${u.pathname}${u.search}${u.hash}`
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
  // 回环入口红色徽标 + 自动改用的局域网地址提示
  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('本机回环')
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText(RELAY_FIXTURE_LAN.ip)
})

test('复制按钮内容等于改写后的局域网地址，顶栏入口开同一弹窗', async ({ page }) => {
  await openProjectPage(page)
  // 顶栏按钮入口（命令面板链路上一用例已覆盖）
  await page.locator('[data-testid="topbar-qr-relay"]').click()
  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // 弹窗内 URL 文本 = LAN origin + 当前路由/query（回环地址不再入码）
  const expectedUrl = lanDeepLink(page.url())
  await expect(modal.locator('input')).toHaveValue(expectedUrl)

  // 复制（localhost 为安全上下文，走 navigator.clipboard 主路径）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByRole('button', { name: '复制' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(expectedUrl)
})

test('携带深链开关：默认开=LAN 深链，关=LAN 根入口，再开复原', async ({ page }) => {
  await openProjectPage(page)
  await page.locator('[data-testid="topbar-qr-relay"]').click()
  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // QR canvas 值 / 链接输入框 / 复制按钮三者同源（同一 url 计算属性），
  // input 断言即码内容断言（canvas 像素解码不做）
  const input = modal.locator('input')
  const toggle = modal.locator('[data-testid="qr-relay-carry-location"]')
  const fullUrl = page.url()

  // 默认开 = 现状：深链 = LAN origin + 当前路由
  await expect(input).toHaveValue(lanDeepLink(fullUrl))
  await expect(toggle).toHaveClass(/n-checkbox--checked/)

  // 关 → 编码 LAN 根入口（不带当前路由位置）
  await toggle.click()
  await expect(input).toHaveValue(lanOrigin(fullUrl) + '/')
  await expect(toggle).not.toHaveClass(/n-checkbox--checked/)

  // 再开 → 回到完整深链
  await toggle.click()
  await expect(input).toHaveValue(lanDeepLink(fullUrl))
  await expect(toggle).toHaveClass(/n-checkbox--checked/)
})
