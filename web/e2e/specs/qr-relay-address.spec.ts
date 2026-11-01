import { test, expect } from '@playwright/test'
import {
  fixedLocale,
  gotoAndUnlock,
  projectCardByName,
  mockRelayAddressContext,
  RELAY_FIXTURE_LAN,
  type RelayAddressFixture,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 二维码接力地址三态 E2E（P-20261019-10）：
 *   1. 回环 + 多 LAN 候选 → 红色徽标、自动改用候选、下拉切换即更新码/复制值
 *   2. 回环无候选 → 红色不可达提示，不渲染注定打不开的二维码
 *   3. 配置外部访问地址 → 绿色徽标，码内容用外部 origin + 当前深链
 *
 * `/api/system/network` 与 `/api/settings` GET 均在页面层 mock（helpers
 * mockRelayAddressContext），不写服务端设置、不依赖机器真实网卡。
 */

const SECOND_LAN: RelayAddressFixture = { ip: '10.9.8.7', family: 'v4', iface: 'e2e1', private: true }

async function openProjectPage(
  page: import('@playwright/test').Page,
  opts: { addresses: RelayAddressFixture[]; externalAccessUrl: string },
) {
  await fixedLocale(page)
  await mockRelayAddressContext(page, opts)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

function originWithPort(pageUrl: string, ip: string): string {
  const u = new URL(pageUrl)
  return `${u.protocol}//${ip}${u.port ? `:${u.port}` : ''}`
}

// 页面层 settings/network 路由在用例结束时可能仍有在途请求（后台首拉/弹窗拉取）；
// 卸载路由时忽略这些回调错误，避免 teardown 竞态把已通过用例标 flaky
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

async function openQrModal(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="topbar-qr-relay"]').click()
  const modal = page.locator('.n-modal.qr-relay-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test('回环 + 多 LAN 候选：红色徽标、自动改址、下拉切换更新码与复制值', async ({ page }) => {
  await openProjectPage(page, { addresses: [RELAY_FIXTURE_LAN, SECOND_LAN], externalAccessUrl: '' })
  const modal = await openQrModal(page)
  const input = modal.locator('[data-testid="qr-relay-url"] input')
  const current = page.url()
  const u = new URL(current)

  // 默认第一候选：私有 v4 按地址数值升序（utils/networkAddress 排序契约）
  const firstIp = SECOND_LAN.ip
  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('本机回环')
  const expectedFirst = `${originWithPort(current, firstIp)}${u.pathname}${u.search}${u.hash}`
  await expect(input).toHaveValue(expectedFirst)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText(firstIp)
  await expect(modal.locator('[data-testid="qr-relay-unreachable"]')).toHaveCount(0)

  // 多网卡下拉可切换：选回 192.168.77.10 → 码内容即时更新
  await modal.locator('[data-testid="qr-relay-address-select"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: RELAY_FIXTURE_LAN.ip }).click()
  const expectedSecond = `${originWithPort(current, RELAY_FIXTURE_LAN.ip)}${u.pathname}${u.search}${u.hash}`
  await expect(input).toHaveValue(expectedSecond)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText(RELAY_FIXTURE_LAN.ip)

  // 复制 = 当前选中地址（二维码/文本框/剪贴板同源）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByRole('button', { name: '复制' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedSecond)
})

test('回环无候选：红色不可达提示，不渲染二维码，复制禁用', async ({ page }) => {
  await openProjectPage(page, { addresses: [], externalAccessUrl: '' })
  const modal = await openQrModal(page)

  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('不可达')
  await expect(modal.locator('[data-testid="qr-relay-unreachable"]')).toBeVisible()
  await expect(modal.locator('canvas')).toHaveCount(0)
  await expect(modal.locator('[data-testid="qr-relay-url"] input')).toHaveValue('')
  await expect(modal.getByRole('button', { name: '复制' })).toBeDisabled()
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('外部访问地址')
})

test('外部访问地址：绿色徽标，码内容 = 外部 origin + 当前深链，关携带回根入口', async ({ page }) => {
  await openProjectPage(page, { addresses: [], externalAccessUrl: 'https://nas.example.com:8443/' })
  const modal = await openQrModal(page)
  const input = modal.locator('[data-testid="qr-relay-url"] input')
  const u = new URL(page.url())

  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('外部地址')
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('任意网络')
  // 外部地址优先于局域网候选（本用例候选为空也证明不依赖 network 端点）
  await expect(modal.locator('[data-testid="qr-relay-address-select"]')).toHaveCount(0)
  await expect(input).toHaveValue(`https://nas.example.com:8443${u.pathname}${u.search}${u.hash}`)

  // 关携带 → 外部 origin 根入口（尾斜杠归一为单个 /）
  await modal.locator('[data-testid="qr-relay-carry-location"]').click()
  await expect(input).toHaveValue('https://nas.example.com:8443/')
})
