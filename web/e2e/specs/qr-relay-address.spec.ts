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
 * 二维码接力地址 E2E（P-20261019-10 立项；P-20261120-4 语义修订）：
 *   1. 回环入口默认「自动（当前浏览器地址）」：链接/码 = 浏览器地址栏 origin，
 *      hint 走回环本源语境——不再自动改写为候选首项
 *   2. 下拉显式切换候选（含全球单播 IPv6，用户截图二一致性场景）：链接框、
 *      hint、剪贴板三方同源同一 origin（排序只决定下拉展示序，不劫持链接）
 *   3. 回环合成候选（本机 · 127.0.0.1 / localhost）置尾可选：本机访问场景
 *      一步可达；回环 + 零网卡不再落入不可达态
 *   4. 配置外部访问地址 → 绿色徽标，码内容用外部 origin + 当前深链（不变）
 *
 * `/api/system/network` 与 `/api/settings` GET 均在页面层 mock（helpers
 * mockRelayAddressContext），不写服务端设置、不依赖机器真实网卡。
 */

const SECOND_LAN: RelayAddressFixture = { ip: '10.9.8.7', family: 'v4', iface: 'e2e1', private: true }
// 全球单播 IPv6（非 RFC1918/ULA/CGNAT）：评分低排序后，曾被排序覆盖回私网
// v4 首项——preferredIp 钉住显式选择的一致性实锚（P-20261120-4 用户截图二）
const V6_GLOBAL: RelayAddressFixture = { ip: '240e:8888::5', family: 'v6', iface: 'e2e0', private: false }

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
  const host = ip.includes(':') ? `[${ip}]` : ip
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}`
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

/** 打开地址下拉并点选目标选项（visible 过滤：naive-ui 关闭后旧选项 DOM 延迟卸载） */
async function selectAddress(page: import('@playwright/test').Page, modal: import('@playwright/test').Locator, label: string) {
  await modal.locator('[data-testid="qr-relay-address-select"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: label, visible: true }).first().click()
}

test('回环 + 多候选：默认自动态 = 浏览器地址；显式选 IPv6 链接/hint 同步；可切回自动', async ({ page }) => {
  await openProjectPage(page, { addresses: [RELAY_FIXTURE_LAN, SECOND_LAN, V6_GLOBAL], externalAccessUrl: '' })
  const modal = await openQrModal(page)
  const input = modal.locator('[data-testid="qr-relay-url"] input')
  const current = page.url()
  const u = new URL(current)

  // 自动态（默认）：链接 = 浏览器地址栏 origin + 当前深链（buildRelayUrl 同
  // origin 原样返回）；hint = 回环本源语境（不再「已自动改用…」）
  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('本机回环')
  await expect(input).toHaveValue(current)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('浏览器地址栏')
  await expect(modal.locator('[data-testid="qr-relay-unreachable"]')).toHaveCount(0)
  // 下拉默认显示「自动」伪选项；合成回环候选置尾在场（P-20261120-4 诉求①）
  await modal.locator('[data-testid="qr-relay-address-select"]').click()
  const autoOption = page.locator('.n-base-select-option').filter({ hasText: '自动（当前浏览器地址）' })
  await expect(autoOption).toHaveCount(1)
  await expect(page.locator('.n-base-select-option').filter({ hasText: '127.0.0.1' })).toHaveCount(1)
  await expect(page.locator('.n-base-select-option').filter({ hasText: 'localhost' })).toHaveCount(1)
  // 降权展示序：物理网卡在前、回环合成项垫底（既有 10.9.8.7 < 192.168.77.10 数值序）
  const optionTexts = await page.locator('.n-base-select-option').allTextContents()
  expect(optionTexts[optionTexts.length - 1]).toContain('localhost')

  // 同一开态内显式选全球单播 IPv6（用户截图二场景）：链接框/hint 随选择同步
  //（一致性修复；选择即关闭菜单，选项元素由 naive-ui 延迟卸载，不做计数断言）
  await page.locator('.n-base-select-option').filter({ hasText: V6_GLOBAL.ip, visible: true }).first().click()
  const expectedV6 = `${originWithPort(current, V6_GLOBAL.ip)}${u.pathname}${u.search}${u.hash}`
  await expect(input).toHaveValue(expectedV6)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText(V6_GLOBAL.ip)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('同一 Wi-Fi')

  // 复制 = 当前选中地址（二维码 :value 与链接框同一 computed，三方同源）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByRole('button', { name: '复制' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(expectedV6)

  // 切回「自动」→ 回到浏览器地址（自动态随时可达，不再是单向门）
  await selectAddress(page, modal, '自动（当前浏览器地址）')
  await expect(input).toHaveValue(current)
})

test('回环无网卡候选：默认浏览器地址 + 合成回环候选可选（不可达态消失）', async ({ page }) => {
  await openProjectPage(page, { addresses: [], externalAccessUrl: '' })
  const modal = await openQrModal(page)
  const input = modal.locator('[data-testid="qr-relay-url"] input')
  const current = page.url()

  // P-20261120-4：回环入口恒有合成候选，不再「红色不可达」拦死本机自测
  await expect(modal.locator('[data-testid="qr-relay-status"]')).toContainText('本机回环')
  await expect(modal.locator('[data-testid="qr-relay-unreachable"]')).toHaveCount(0)
  await expect(modal.locator('canvas')).toHaveCount(1)
  await expect(input).toHaveValue(current)

  // 显式选 127.0.0.1 → 链接变回环合成项 origin（本机多形态访问一步可达）
  await selectAddress(page, modal, '127.0.0.1')
  const u = new URL(current)
  await expect(input).toHaveValue(`${originWithPort(current, '127.0.0.1')}${u.pathname}${u.search}${u.hash}`)
  await expect(modal.locator('[data-testid="qr-relay-hint"]')).toContainText('浏览器地址栏')
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
