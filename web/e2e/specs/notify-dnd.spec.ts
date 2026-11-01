import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知免打扰时段 E2E（P-20261002-40）：
 *   1. 设置页 UI 开启免打扰并设覆盖当前时刻的时段（开始=now-2min，结束=now+10min，
 *      含恰逢午夜时 start>end 的跨午夜形态）→ 保存走 NotificationSettings.save
 *      → dndStore 落 localStorage
 *   2. 时段内 toast 路径静默：POST /api/ops-notify（type=notify）→ naive-ui
 *      message 不弹（OpsChannelBridge.onNotify 的 isSilenced 前置拦截）
 *   3. 通知中心照常入账：同窗内 task.progress done → 通知中心条目照常出现
 *      （入账链不经过任何免打扰判定）
 * 桌面通知生效点（useDesktopNotify）在 e2e 页面恒可见态下本就跳过
 *（document.hidden 语义），其免打扰分支由 dndSchedule 单测覆盖，此处不断言。
 * 免打扰偏好存 localStorage（每用例独立 context 互不泄漏），通知列表为服务端
 * 全局状态：beforeAll/afterAll 清空防残留。
 */

const TOAST_DND = 'e2e-dnd-静默通知'
const TOAST_CTRL = 'e2e-dnd-放行通知'
const DONE_TASK = 'e2e-dnd-入账任务'

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

// 覆盖当前时刻的 HH:mm 时段：开始 2 分钟前、结束 10 分钟后——任意墙钟时刻
// （含午夜边界）都满足「isWithinDnd=真」；时段形态由判定单测穷举，此处只要真值
function dndWindowCoveringNow(): { start: string; end: string } {
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return { start: hm(new Date(Date.now() - 2 * 60_000)), end: hm(new Date(Date.now() + 10 * 60_000)) }
}

// 进入项目 → 通知中心 → 齿轮直达设置通知页签（同 notify-webhook.spec 入口）
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

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('免打扰时段内：notify toast 静默，通知中心照常入账（设置页 UI 全链路）', async ({ page }) => {
  test.setTimeout(60000)
  const pane = await openNotifSettings(page)

  // 开启免打扰 → 时段字段展开，填覆盖当前时刻的起止
  await pane.locator('.setting-row', { hasText: '免打扰时段' }).locator('.n-checkbox').click()
  const fields = pane.locator('.dnd-fields')
  await expect(fields).toBeVisible()
  const w = dndWindowCoveringNow()
  await fields.locator('input[type="time"]').first().fill(w.start)
  await fields.locator('input[type="time"]').nth(1).fill(w.end)
  // 审批卡不静默的注明随分区常驻
  await expect(pane.locator('.dnd-note')).toContainText('审批确认卡')

  // modal 保存（NotificationSettings.save → dndStore.set → localStorage）
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // ops-channel / notifications 两条 WS 建立窗口（同 task-done-notify 口径）
  await page.waitForTimeout(800)

  // toast 路径静默：notify 事件送达（由下方入账断言反证链路通）但不弹层。
  // naive-ui message 默认 3s 自愈期，等过再断言「从未出现」
  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'notify', payload: { message: TOAST_DND, level: 'info' } },
  })
  await page.waitForTimeout(3500)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_DND })).toHaveCount(0)

  // 同一时段内通知中心照常入账：task.progress done → 条目出现
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: DONE_TASK, status: 'done' } },
  })
  expect(await waitServerCount(DONE_TASK, headers)).toBe(1)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-item').filter({ hasText: DONE_TASK }).first()).toBeVisible({ timeout: 8000 })
})

test('免打扰未启用：同链路 notify toast 正常弹出（对照）', async ({ page }) => {
  test.setTimeout(60000)
  // 全新 context：notify-dnd localStorage 为空 → 免打扰默认关
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)

  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'notify', payload: { message: TOAST_CTRL, level: 'info' } },
  })
  await expect(page.locator('.n-message').filter({ hasText: TOAST_CTRL })).toBeVisible({ timeout: 5000 })
})
