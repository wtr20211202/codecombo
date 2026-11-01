import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, LOCK_OVERLAY } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 锁定态桌面通知抑制 E2E（P-20261003-5）：
 *   1. 对照（解锁态）：设置通知页「发送测试通知」→ useDesktopNotify 真实弹出。
 *      window.Notification 为注入的记录型 mock（permission granted + 页面恒
 *      hidden 使桌面通知生效点可达——e2e 页面默认可见时 notify 内部跳过）
 *   2. 锁定态（TopBar「锁定系统」：前端立即切锁定屏 + 服务端撤销本页 token，
 *      标签页隔离语义不影响共享实例其他会话）：锁定时应用会自行收起设置弹窗
 *      （锁定联动收弹窗，锁定功能既有行为），经 DOM click 重开弹窗后直发
 *      「发送测试通知」——入账链 store.add 真实发出（断言请求活性），桌面弹出
 *      应被 notify() 的锁定前置吞掉（计数不变）
 *   3. 解锁后通知中心照常可见：入账不受桌面抑制影响（「只吞打扰不吞账目」）
 *
 * 触发点选设置页测试按钮而非 ops-notify 任务链：锁定时通知/ops 两条 WS 均被
 * 门控断开，任务事件到不了页面（抑制断言会因「事件根本没送达」而空洞）；
 * 测试按钮直达 useDesktopNotify.notify()，断言落在被测门控本身。遮罩/弹窗
 * 收起拦得住指针事件拦不住处理器，DOM click 直发即真实链路。通知列表为
 * 服务端全局状态：beforeAll/afterAll 清空防残留（同 notify-dnd.spec）。
 */

const TEST_NOTIF_TITLE = '测试通知' // zh-CN: settings.notifDesktopTestTitle
const TEST_BTN_TEXT = '发送测试通知' // zh-CN: settings.notifDesktopTest

// 注入记录型 Notification mock + 页面恒 hidden（桌面通知生效点前提，
// 见 useDesktopNotify.ts 的 document.hidden 分支）
async function installNotifRecorder(page: Page) {
  await page.addInitScript(() => {
    const calls: Array<{ title: string; body?: string }> = []
    ;(window as unknown as Record<string, unknown>).__e2eNotifCalls = calls
    class FakeNotification {
      static permission = 'granted'
      static requestPermission = async () => 'granted'
      title: string
      constructor(title: string, opts?: { body?: string }) {
        this.title = title
        calls.push({ title, body: opts?.body })
      }
      close() { /* noop */ }
      onclick: unknown = null
    }
    ;(window as unknown as Record<string, unknown>).Notification = FakeNotification
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  })
}

// 按标题过滤的桌面构造调用计数（过滤防无关通知干扰计数）
function notifCallCount(page: Page, title: string) {
  return page.evaluate((t) =>
    ((window as unknown as Record<string, unknown>).__e2eNotifCalls as Array<{ title: string }>)
      .filter(c => c.title === t).length, title)
}

// 解锁 token 请求头（清空通知列表用，同 notify-dnd.spec）
async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('锁定态测试通知不弹桌面，解锁后通知中心照常可见', async ({ page }) => {
  test.setTimeout(90000)
  await installNotifRecorder(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // 通知中心 → 齿轮直达设置通知页签（同 notify-dnd.spec 入口）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  const pane = page.locator('.settings-modal .content-pane:visible')
  const testBtn = pane.locator('.permission-recheck', { hasText: TEST_BTN_TEXT })

  // ① 对照（解锁态）：mock 与双链路均生效 → 桌面构造调用恰好 +1
  await testBtn.click()
  await expect.poll(() => notifCallCount(page, TEST_NOTIF_TITLE), { timeout: 5000 }).toBe(1)

  // 收起设置弹窗（遮罩不压 TopBar，锁定用真实点击走完整 lockStore.lock 链路）
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // ② TopBar 锁定（前端立即 isLocked=true + 服务端撤销本页 token）
  await page.locator('button[title="锁定系统"]').first().click()
  await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 10000 })

  // 锁定态重开设置弹窗（锁定联动收弹窗；遮罩拦指针拦不住处理器，DOM click
  // 直发重开），再直发「发送测试通知」——锁定态下入账请求真实发出且被 423
  // 拒（活性断言），桌面弹出应被 notify() 的锁定前置吞掉
  await page.evaluate(() => {
    (Array.from(document.querySelectorAll('button[title="通知中心"]'))[0] as HTMLElement | undefined)?.click()
  })
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.evaluate(() => {
    (document.querySelector('.nc-action-btn') as HTMLElement | undefined)?.click()
  })
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  const lockedAdd = page.waitForResponse(
    (r) => r.url().includes('/api/notifications') && r.request().method() === 'POST',
    { timeout: 5000 },
  ).catch(() => null)
  await page.evaluate((text) => {
    const btn = Array.from(document.querySelectorAll('.permission-recheck'))
      .find(b => b.textContent?.includes(text)) as HTMLElement | undefined
    btn?.click()
  }, TEST_BTN_TEXT)
  // 活性：入账链真实跑过，抑制非「事件没到」。响应状态不设断言——共享实例的
  // 服务端锁定开关可能被其他 spec 留在关闭态（中间件放行 → 200 服务端落账），
  // 也可能是开启态（本页 token 已撤销 → 423 → addLocal 本地落账），两者入账
  // 均不受桌面抑制影响，解锁后中心可见断言（下方④）对两种落账形态同判
  expect(await lockedAdd).toBeTruthy()
  await page.waitForTimeout(1000)
  expect(await notifCallCount(page, TEST_NOTIF_TITLE)).toBe(1)

  // 关掉重开的设置弹窗再解锁（× 直接 emit 关闭，不脏无网络；弹窗开着会以
  // 焦点陷阱干扰锁屏表单的 fill→v-model 链）
  await page.evaluate(() => {
    (document.querySelector('.settings-modal .settings-close') as HTMLElement | undefined)?.click()
  })
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // ③ 解锁（遮罩消失）→ 收起默认密码提醒（如弹）
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  await input.fill(DEFAULT_PASSWORD)
  const unlockBtn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
  await expect(unlockBtn).toBeEnabled({ timeout: 2000 })
  await unlockBtn.click()
  await expect(page.locator(LOCK_OVERLAY)).toHaveCount(0, { timeout: 10000 })
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  if (await pwdTip.count() > 0) {
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
    await expect(pwdTip).toBeHidden()
  }

  // ④ 通知中心照常可见（对照与锁定期间的入账都在，桌面抑制未吞账目）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.nc-item').filter({ hasText: TEST_NOTIF_TITLE }).first())
    .toBeVisible({ timeout: 8000 })
})
