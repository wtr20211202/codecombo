import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { dndWindowCoveringNow } from '../../tests/alert-sound-stub'
import { installDesktopNotifyStub, desktopNotifyCalls } from '../../tests/desktop-notify-stub'
import { DND_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * error 级穿透勿扰 E2E（P-20261004-117）：勿扰滤的是噪声不是警报——
 * type 为 error 的通知在免打扰时段/手动档内仍发桌面通知（开关 exceptError
 * 默认开，关=绝对静默合法偏好）；warning/info 级照旧静默；中心入账不受
 * 影响（勿扰只吞打扰不吞账目，语义③）。
 * 以记录型 Notification 桩断言桌面通知发出 / 不发出（tests/desktop-notify-stub.ts：
 * 同时恒定 document.hidden——e2e 页面可见态下 useDesktopNotify 本就跳过弹出）：
 *   1. 设置页 UI 全链路开启免打扰（新开关「错误级仍提醒」默认勾选）→ error
 *      通知到达 → 桩命中（穿透弹出）+ 中心照常入账
 *   2. 播种 exceptError:false → error 通知到达 → 桩不命中（绝对静默）+
 *      中心照常入账（只吞打扰不吞账目）
 *   3. 播种默认开 → warning 级桩不命中（豁免只认 error）+ info 级桩不命中
 *      （桌面弹层类型面既有 error/warning 过滤），两者中心均照常入账
 * 免打扰偏好存 localStorage（每用例独立 context 互不泄漏），通知列表为服务端
 * 全局状态：beforeAll/afterAll 清空防残留。
 */

const ERROR_TITLE = 'e2e-dnd-errp-任务失败'
// 测试 2（绝对静默档）独立标题：serverCount 仅按 title 过滤，与测试 1 同题会让
// beforeAll 只清一次的本文件内前例条目计入 waitServerCount 计数（run15 实测
// 首轮恒 2≠1，retry 重入文件钩子清场后才假绿）——各用例断言各自的自建条目
const ERROR_MUTE_TITLE = 'e2e-dnd-errp-静默任务失败'
const WARNING_TITLE = 'e2e-dnd-errp-编队告警'
const INFO_TITLE = 'e2e-dnd-errp-进度播报'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function serverCount(title: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: Array<{ title?: string }> }).data || []
  return list.filter(n => n.title === title).length
}

async function waitServerCount(title: string, headers: Record<string, string>, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await serverCount(title, headers)
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

/** 服务端入账一条指定分级/类别的通知（WS 实时送达前端通知中心；notify-dnd.spec
 * 的 page.request.post 同款直投口径，改走 Node fetch 与 unlockHeaders 同源） */
async function postNotification(
  headers: Record<string, string>,
  n: { type: string; category: string; title: string; body?: string }
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify(n),
  })
  expect(res.ok).toBeTruthy()
}

// 免打扰时段偏好直接播种（notify-dnd-exception.spec 同款 addInitScript 写入）
async function seedDnd(page: import('@playwright/test').Page, win: Record<string, unknown>) {
  await page.addInitScript(([k, v]) => {
    localStorage.setItem(k, JSON.stringify(v))
  }, [DND_STORAGE_KEY, win])
}

// 进入项目 → 打开通知中心面板（桌面通知 watch 挂载在 NotificationCenter 组件内，
// v-if=showPanel——面板开着通知到达才会走桌面弹层判定）→ 等 WS 建立窗口
async function openCenterPanel(page: import('@playwright/test').Page) {
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.waitForTimeout(800)
}

// 设置页 UI 全链路开启免打扰（notify-dnd.spec 同款入口与字段填写），返回设置 pane
async function enableDndViaSettings(page: import('@playwright/test').Page) {
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  const pane = page.locator('.settings-modal .content-pane:visible')

  await pane.locator('.setting-row', { hasText: '免打扰时段' }).locator('.n-checkbox').click()
  const fields = pane.locator('.dnd-fields')
  await expect(fields).toBeVisible()
  const w = dndWindowCoveringNow()
  await fields.locator('input[type="time"]').first().fill(w.start)
  await fields.locator('input[type="time"]').nth(1).fill(w.end)
  return pane
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('免打扰时段内 error 通知：穿透弹桌面通知（设置页 UI 全链路，错误级开关默认开）', async ({ page }) => {
  test.setTimeout(60000)
  await installDesktopNotifyStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const pane = await enableDndViaSettings(page)

  // 新开关随分区展开且默认勾选（exceptError 默认 true——警报可达性默认兑现）
  const errToggle = pane.locator('.dnd-error-toggle')
  await expect(errToggle).toBeVisible()
  await expect(errToggle.locator('.n-checkbox--checked')).toHaveCount(1)

  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // 保存链路落地默认开：localStorage 回读 exceptError === true
  const saved = await page.evaluate(
    (k) => JSON.parse(localStorage.getItem(k) || '{}') as { exceptError?: boolean },
    DND_STORAGE_KEY
  )
  expect(saved.exceptError).toBe(true)

  // 重开通知中心面板（openPrefs 打开设置时面板已收起，watch 随组件卸载）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.waitForTimeout(800)

  const headers = await unlockHeaders()
  await postNotification(headers, { type: 'error', category: 'task', title: ERROR_TITLE, body: 'exit 1（32.5s）' })
  expect(await waitServerCount(ERROR_TITLE, headers)).toBe(1)

  // 穿透：桌面通知发出（桩命中，title/body 原样携带）
  await expect.poll(() => desktopNotifyCalls(page), { timeout: 5000 }).toEqual([
    { title: ERROR_TITLE, body: 'exit 1（32.5s）' },
  ])
  // 中心照常入账（勿扰只管桌面拉回）
  await expect(page.locator('.nc-item').filter({ hasText: ERROR_TITLE }).first()).toBeVisible({ timeout: 8000 })
})

test('免打扰 + 错误级开关关（exceptError:false）：error 通知绝对静默，中心照常入账', async ({ page }) => {
  test.setTimeout(60000)
  await installDesktopNotifyStub(page)
  await fixedLocale(page)
  // 显式关：绝对静默是合法偏好
  await seedDnd(page, { ...dndWindowCoveringNow(), exceptError: false })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await openCenterPanel(page)

  const headers = await unlockHeaders()
  await postNotification(headers, { type: 'error', category: 'task', title: ERROR_MUTE_TITLE, body: 'exit 2' })
  expect(await waitServerCount(ERROR_MUTE_TITLE, headers)).toBe(1)

  await page.waitForTimeout(1500) // 事件链余量：确非「还没弹」而是「开关关了被吞」
  expect(await desktopNotifyCalls(page)).toEqual([])

  // 语义③：勿扰只吞打扰不吞账目——中心条目照常在册
  await expect(page.locator('.nc-item').filter({ hasText: ERROR_MUTE_TITLE }).first()).toBeVisible({ timeout: 8000 })
})

test('免打扰默认开：warning 级不穿透（豁免只认 error），info 级不弹桌面，均照常入账', async ({ page }) => {
  test.setTimeout(60000)
  await installDesktopNotifyStub(page)
  await fixedLocale(page)
  // 不带 exceptError → 旧落盘形态，归一化默认开
  await seedDnd(page, dndWindowCoveringNow())
  await gotoAndUnlock(page, `${API_BASE}/`)
  await openCenterPanel(page)

  const headers = await unlockHeaders()
  await postNotification(headers, { type: 'warning', category: 'task', title: WARNING_TITLE, body: '1 失败' })
  expect(await waitServerCount(WARNING_TITLE, headers)).toBe(1)
  await postNotification(headers, { type: 'info', category: 'system', title: INFO_TITLE, body: 'progress 50%' })
  expect(await waitServerCount(INFO_TITLE, headers)).toBe(1)

  await page.waitForTimeout(1500)
  expect(await desktopNotifyCalls(page)).toEqual([])

  // 在册不受影响：warning/info 条目均在中心可见
  await expect(page.locator('.nc-item').filter({ hasText: WARNING_TITLE }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.nc-item').filter({ hasText: INFO_TITLE }).first()).toBeVisible({ timeout: 8000 })
})
