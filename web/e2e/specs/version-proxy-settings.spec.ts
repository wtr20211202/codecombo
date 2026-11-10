import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 更新链出站代理设置 E2E（P-20261109-12）：版本面板新增「更新代理」输入。
 *   1. 面板可见性与回显——挂载 settings GET 的 updateProxy 灌入输入框
 *   2. 客户端 scheme 早反馈——非法形态报错不发请求
 *   3. 服务端保存 + 归一回读——缺端口补默认（socks5→1080）经真实后端往返，
 *      重开面板回显存盘形态
 *   4. 空串清除——回环境变量感知形态，测试末复位防共享实例泄漏
 *
 * 传输层行为（CONNECT 隧道 / SOCKS5 / 域名白名单守卫）由 Go 单测覆盖
 * （server/update/urlsafety_test.go，测试内自起本地代理，零外部网络副作用）；
 * 本 spec 只钉 UI→API 契约。代理行为用真实外呼验证既不可控也违护栏
 * （不碰本机/WSL 系统代理、持久 env、git/npm 配置），刻意不做。
 */

/** 版本面板经首页 logo 版本弹窗打开（与 version-uptodate-feedback 同款入口） */
async function openVersionPanel(page: Page) {
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  return card
}

/** 「更新代理」输入框与其保存按钮（占位符含 socks5，与中心分发源输入区分） */
function proxyControls(card: ReturnType<Page['locator']>) {
  const input = card.locator('input[placeholder*="socks5"]')
  const save = input.locator('xpath=following-sibling::button')
  return { input, save }
}

async function saveProxy(page: Page, card: ReturnType<Page['locator']>, value: string, expectToast: string) {
  const { input, save } = proxyControls(card)
  await input.fill(value)
  await save.click()
  await expect(page.locator('.n-message').filter({ hasText: expectToast })).toBeVisible({ timeout: 5000 })
}

test('更新代理：非法早反馈 / 保存归一回读 / 空串清除', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = await openVersionPanel(page)
  const { input, save } = proxyControls(card)
  await expect(input).toBeVisible()

  // 非法 scheme：客户端早反馈报错，不发保存请求（无成功 toast；保存态留在输入框）
  await input.fill('ftp://proxy.example')
  await save.click()
  await expect(page.locator('.n-message').filter({ hasText: '代理地址须以' })).toBeVisible({ timeout: 5000 })

  // 合法形态：保存成功 toast（服务端热化 + 落盘）
  await saveProxy(page, card, 'socks5://proxy.example', '更新代理已保存')

  // 重开面板回显服务端归一形态：socks5 缺端口补默认 1080（NormalizeProxyURL 真实栈往返）
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card2 = await openVersionPanel(page)
  const { input: input2 } = proxyControls(card2)
  await expect(input2).toHaveValue('socks5://proxy.example:1080', { timeout: 5000 })

  // 空串 = 清除：保存后重开回显空（复位共享实例，防泄入其他 spec）
  const { input: input3, save: save3 } = proxyControls(card2)
  await input3.fill('')
  await save3.click()
  await expect(page.locator('.n-message').filter({ hasText: '更新代理已保存' })).toBeVisible({ timeout: 5000 })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card3 = await openVersionPanel(page)
  await expect(proxyControls(card3).input).toHaveValue('', { timeout: 5000 })
})
