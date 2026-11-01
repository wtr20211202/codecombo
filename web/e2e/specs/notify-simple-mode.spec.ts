import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 桌面通知精简模式 E2E（P-20261003-90）：
 *   1. 基线（默认关=完整内容）：设置通知页「发送测试通知」→ 桌面弹出完整
 *      title/body（测试通知 + 链路文案）
 *   2. 开启精简模式（设置分区真实勾选 + 保存）再发测试通知 → 桌面构造调用
 *      title 泛化为「新通知」、body 不外带（文件路径/错误摘要类内容泄露面收口）
 *   3. 站内中心不受影响：入账链不经过 useDesktopNotify，条目保持完整标题
 *   4. 关闭精简模式 → 恢复完整 title/body（开/关可逆）
 *
 * 触发点选设置页测试按钮而非 ops-notify 任务链：直达 useDesktopNotify.notify()
 * 被测门控本身（lock-notify-mute.spec 同款思路）——注入记录型 Notification mock
 * + 页面恒 hidden 使桌面通知生效点可达（e2e 页面默认可见时 notify 内部跳过）。
 * 通知列表为服务端全局状态：beforeAll/afterAll 清空防残留（同 lock-notify-mute）。
 * 精简偏好是 localStorage（notify-simple），Playwright 每用例全新 context 天然隔离。
 */

const TEST_TITLE = '测试通知' // zh-CN: settings.notifDesktopTestTitle
const GENERIC_TITLE = '新通知' // zh-CN: notify.simple.title
const BODY_SNIPPET = '桌面通知链路正常' // zh-CN: settings.notifDesktopTestBody 前缀
const SAVE_BTN_TEXT = '保存'

interface NotifCall {
  title: string
  body?: string
}

// 注入记录型 Notification mock + 页面恒 hidden（桌面通知生效点前提，
// 见 useDesktopNotify.ts 的 document.hidden 分支；lock-notify-mute.spec 同款）
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

async function recordedCalls(page: Page): Promise<NotifCall[]> {
  return page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__e2eNotifCalls as NotifCall[])
}

// 打开通知中心浮卡；已开则跳过铃铛点击（toggle 语义——点开会把已开的切换为关闭）
async function openNotifCenter(page: Page) {
  const card = page.locator('.nc-card')
  if (!(await card.isVisible().catch(() => false))) {
    await page.locator('button[title="通知中心"]').first().click()
  }
  await expect(card).toBeVisible({ timeout: 3000 })
}

// 通知中心 → 齿轮直达设置通知页签（lock-notify-mute.spec 同入口）
async function openNotifSettings(page: Page) {
  await openNotifCenter(page)
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  return page.locator('.settings-modal .content-pane:visible')
}

// 发送测试通知并等待桌面构造调用数达到 n（复用 granted 行内的测试按钮，
// notify-permission-guide.spec 同款定位）
async function sendTestNotification(page: Page, n: number) {
  const pane = page.locator('.settings-modal .content-pane:visible')
  await pane.locator('.permission-status.granted .permission-recheck', { hasText: '发送测试通知' }).click()
  await expect.poll(async () => (await recordedCalls(page)).length, { timeout: 5000 }).toBe(n)
}

async function saveSettings(page: Page) {
  await page.locator('.settings-modal .settings-footer button', { hasText: SAVE_BTN_TEXT }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
}

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

test('精简模式开→桌面泛化「新通知」不含明细；中心完整；关→恢复完整', async ({ page }) => {
  test.setTimeout(150000)
  await installNotifRecorder(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // ① 基线（精简默认关）：完整 title/body
  await openNotifSettings(page)
  await sendTestNotification(page, 1)
  let calls = await recordedCalls(page)
  expect(calls[0]?.title).toBe(TEST_TITLE)
  expect(calls[0]?.body).toContain(BODY_SNIPPET)

  // ② 开启精简模式（真实勾选 + 保存）→ 再发测试通知：桌面泛化
  const pane = page.locator('.settings-modal .content-pane:visible')
  await pane.locator('.setting-row.simple-row .n-checkbox').click()
  await saveSettings(page)
  await openNotifSettings(page)
  await sendTestNotification(page, 2)
  calls = await recordedCalls(page)
  const generic = calls.filter(c => c.title === GENERIC_TITLE)
  expect(generic).toHaveLength(1)
  expect(generic[0]?.body).toBeUndefined()
  // 全程桌面侧无第二次完整标题构造（泛化确由精简门吞掉，非按钮失灵）
  expect(calls.filter(c => c.title === TEST_TITLE)).toHaveLength(1)

  // ③ 站内中心不受影响：入账链完整标题照常可见（「只改呈现面不动账目」）。
  // 设置弹窗先经 × 关闭（遮罩拦铃铛点击；× 直接 emit 关闭不脏数据）
  await page.locator('.settings-modal .settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  await openNotifCenter(page)
  await expect(page.locator('.nc-item').filter({ hasText: TEST_TITLE }).first())
    .toBeVisible({ timeout: 8000 })

  // ④ 关闭精简模式 → 恢复完整 title/body（开/关可逆）
  await openNotifSettings(page)
  await page.locator('.settings-modal .content-pane:visible').locator('.setting-row.simple-row .n-checkbox').click()
  await saveSettings(page)
  await openNotifSettings(page)
  await sendTestNotification(page, 3)
  calls = await recordedCalls(page)
  const full = calls.filter(c => c.title === TEST_TITLE)
  expect(full).toHaveLength(2)
  expect(full[1]?.body).toContain(BODY_SNIPPET)
})
