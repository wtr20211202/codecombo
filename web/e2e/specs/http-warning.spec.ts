import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, waitForAppReady, LOCK_OVERLAY, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * HTTP 明文访问警示条 E2E（P-20261002-30）
 *
 * 覆盖：
 * - 非 loopback 主机名的 http 访问 → 顶栏下方警示条出现（解锁后、项目页）
 * - 「不再提示」→ 立即隐藏 + 刷新后保持隐藏（safeStorage/localStorage 持久）
 * - localhost 访问 → 警示条与锁屏提示都不出现（豁免是硬要求：全量套件跑在
 *   http://localhost 下，误报会污染所有既有用例）
 * - 锁定开启时，锁屏（密码输入第一现场）显示同款提示
 *
 * 非 localhost 形态的模拟：Chromium --host-resolver-rules 把假主机名解析到
 * 127.0.0.1——location.hostname 变为假主机名而流量仍打本实例，服务端无
 * Host/Origin 校验，页面/API/WS 全走同源假主机名。播种脚本零改动（任务书红线）。
 */

const BAR = '[data-testid="http-warning-bar"]'
const BAR_DISMISS = '[data-testid="http-warning-dismiss"]'
const BAR_HELP = '[data-testid="http-warning-help"]'
const LOCK_HINT = '[data-testid="lock-http-hint"]'
const FAKE_HOST = 'sc-e2e-lan.local'

// 假主机名指向的基地址：端口跟随实例（PLAYWRIGHT_BASE_URL 覆盖的隔离槽位）
const API_PORT = new URL(API_BASE).port
const LAN_BASE = `http://${FAKE_HOST}${API_PORT ? `:${API_PORT}` : ''}`

const BAR_TEXT = '当前为 HTTP 明文连接' // zh-CN: conn.http.message 前缀

// launchOptions 只能落在文件顶层（describe 内会强制换 worker）。MAP 仅改写
// 假主机名的解析，localhost 用例不触碰该主机名、行为不受影响
test.use({
  launchOptions: {
    args: [`--host-resolver-rules=MAP ${FAKE_HOST} 127.0.0.1`],
  },
})

/** 从首页进入项目页（警示条仅 Layout/项目页挂载） */
async function enterProjectPage(page: Page): Promise<void> {
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

// 锁定开关全局态的自启用/自还原（同 lock.spec 模式）；unlock 429 限流等待重试
async function unlockViaApi(request: APIRequestContext): Promise<string | null> {
  const attempt = () => request.post('/api/lock/unlock', { data: { password: DEFAULT_PASSWORD } })
  let res = await attempt()
  if (res.status() === 429) {
    const wait = Number(res.headers()['retry-after'] || 0) * 1000 || 5000
    await new Promise((r) => setTimeout(r, Math.min(wait, 15000)))
    res = await attempt()
  }
  if (!res.ok()) return null
  return ((await res.json()) as { token: string }).token
}

async function setLockConfig(request: APIRequestContext, enabled: boolean): Promise<void> {
  const token = await unlockViaApi(request)
  if (!token) return
  await request.put('/api/lock/config', {
    headers: { 'X-Lock-Token': token },
    data: { enabled, currentPassword: DEFAULT_PASSWORD },
  })
}

test.describe('HTTP 明文警示条（非 loopback http）', () => {
  test('非 loopback 主机名 http 访问 → 顶栏下方警示条出现', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${LAN_BASE}/`)
    await enterProjectPage(page)

    const bar = page.locator(BAR)
    await expect(bar).toBeVisible()
    await expect(bar).toContainText(BAR_TEXT)
    // 两个动作按钮在位：查看帮助 / 不再提示
    await expect(page.locator(BAR_HELP)).toBeVisible()
    await expect(page.locator(BAR_DISMISS)).toBeVisible()

    // 「查看帮助」→ 打开 HelpCenter 抽屉（TLS 配置节入口）
    await page.locator(BAR_HELP).click()
    const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
    await expect(drawer).toBeVisible({ timeout: 5000 })
  })

  test('不再提示 → 立即隐藏，刷新后保持隐藏（记忆持久）', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${LAN_BASE}/`)
    await enterProjectPage(page)
    await expect(page.locator(BAR)).toBeVisible()

    await page.locator(BAR_DISMISS).click()
    await expect(page.locator(BAR)).toBeHidden()

    // 刷新（同 origin，localStorage 记忆生效）→ 警示条不再出现；
    // 解锁令牌同在 localStorage，刷新后不回锁、不弹默认密码 dialog
    await page.reload()
    await waitForAppReady(page)
    await expect(page.locator(BAR)).toHaveCount(0)
    // 记忆键确实落在 localStorage（锁屏提示与顶栏条共享同一份）
    const dismissed = await page.evaluate(() => localStorage.getItem('sc.httpWarningDismissed'))
    expect(dismissed).toBe('1')
  })

  test('锁定开启时，锁屏显示同款 HTTP 提示（密码输入第一现场）', async ({ page, request }) => {
    await setLockConfig(request, true)
    await fixedLocale(page)
    // 假主机名 origin 的 localStorage 为空 → 无解锁令牌 → 锁定遮罩必现
    await page.goto(`${LAN_BASE}/`)
    await waitForAppReady(page)
    await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 10000 })

    const hint = page.locator(LOCK_HINT)
    await expect(hint).toBeVisible()
    await expect(hint).toContainText(BAR_TEXT)

    // 本用例不解锁不落任何状态；开关还原交给 afterAll
  })

  test.afterAll(async ({ request }) => {
    await setLockConfig(request, false)
  })
})

test.describe('HTTP 明文警示条（localhost 豁免）', () => {
  test('localhost http 访问 → 警示条与锁屏提示都不出现', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await enterProjectPage(page)

    await expect(page.locator(BAR)).toHaveCount(0)
    await expect(page.locator(LOCK_HINT)).toHaveCount(0)
  })
})
