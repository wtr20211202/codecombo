import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知稍后提醒 E2E（P-20261003-36，分诊三态：处理/延后/清除）：
 *   - 条目操作区「稍后提醒」三档菜单 → 条目入「已延后」分组、徽标沉默
 *   - 延后态随记录落盘（整页刷新仍在——跨重启持久的同链路验证）
 *   - 取消延后恢复原位与未读
 *   - 到点重挂（注入时钟：API 直传临近到期时刻，等分钟巡检）→ 置顶+未读+徽标恢复
 *   - API 契约：坏 snoozeUntil 400 稳定原文、未知 id 404
 * 通知经 POST /api/notifications 播种（共享实例用例开头/结尾先清空，
 * 不残留测试数据）；打开项目页取 TopBar 铃铛入口。
 */

interface NotifItem { id: string; title: string; snoozeUntil?: string; read: boolean }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearNotifications(): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers: await unlockHeaders() })
}

async function seed(headers: Record<string, string>, title: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'info', category: 'system', title }),
  })
  expect(res.ok).toBeTruthy()
}

async function listNotifications(): Promise<NotifItem[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers: await unlockHeaders() })
  const body = (await res.json()) as { data?: NotifItem[] }
  return body.data || []
}

async function snoozeApi(id: string, snoozeUntil: string): Promise<Response> {
  return fetch(`${API_BASE}/api/notifications/snooze/${id}`, {
    method: 'POST',
    headers: await unlockHeaders(),
    body: JSON.stringify({ snoozeUntil }),
  })
}

async function openPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 解锁后延迟弹出的「建议修改默认密码」提醒会拦项目卡片点击（时序不定），
  // 先等 4s 出现则点「稍后提醒」收起（CLAUDE.md「测试」节既有条目）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test.beforeAll(async () => {
  await clearNotifications()
})

test.afterAll(async () => {
  await clearNotifications()
})

test('稍后提醒菜单 → 入已延后分组且徽标沉默；刷新后仍在（落盘持久）；取消延后恢复', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearNotifications()
  await seed(headers, 'e2e-延后-甲')

  await openPanel(page)
  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-甲' })
  await expect(row).toHaveCount(1, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toBeVisible()

  // 条目操作区「稍后提醒」→ 三档菜单 → 30 分钟
  await row.hover()
  await row.locator('[data-testid="notif-snooze-btn"]').click()
  await expect(page.locator('.n-dropdown-option').filter({ hasText: '30 分钟' })).toBeVisible({ timeout: 3000 })
  await page.locator('.n-dropdown-option').filter({ hasText: '30 分钟' }).click()

  // 延后即暂离常规流：全部页签消失、徽标沉默；「已延后」页签计数 1
  await expect(row).toHaveCount(0, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toHaveCount(0)
  const snoozedTab = page.locator('.nc-filter-btn').filter({ hasText: '已延后' })
  await expect(snoozedTab).toContainText('1')

  // 已延后分组可查看：条目在列且带「已延后至」到期展示
  await snoozedTab.click()
  const snoozedRow = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-甲' })
  await expect(snoozedRow).toHaveCount(1, { timeout: 3000 })
  await expect(snoozedRow).toContainText('已延后至')

  // 延后态随记录落盘：整页刷新（跨重启同链路）后已延后分组仍在
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-filter-btn').filter({ hasText: '已延后' }).click()
  await expect(page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-甲' })).toHaveCount(1, { timeout: 3000 })

  // 取消延后：恢复原位（全部页签、未读徽标回归）
  const cancelRow = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-甲' })
  await cancelRow.hover()
  await cancelRow.locator('[data-testid="notif-snooze-cancel"]').click()
  await expect(cancelRow).toHaveCount(0, { timeout: 3000 })
  await page.locator('.nc-filter-btn').filter({ hasText: '全部' }).first().click()
  await expect(page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-甲' })).toHaveCount(1, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toBeVisible()
})

test('到点重挂（注入时钟）：延后条目到期后由巡检重挂为未读置顶，徽标恢复', async ({ page }) => {
  test.setTimeout(150_000) // 分钟级巡检：触发等待最长 ~1 分钟，留余量
  const headers = await unlockHeaders()
  await clearNotifications()
  await seed(headers, 'e2e-延后-到期重挂')

  // 注入时钟：API 直传临近到期时刻（菜单三档之外的绝对时刻，契约允许）。
  // 到期 = now+12s：晚于面板打开（前端延后判定 = 标记在位，标记未被巡检清掉
  // 前必隐藏）且早于重挂上界（服务端巡检按分钟界扫，到期后首个巡检 ∈
  // [到期, 到期+60s] ⊆ [+12s, +72s] ⊂ 重挂断言的 90s 预算）——两段断言对
  // 任意起跑时刻都确定。now+3s 的原写法会撞「巡检界在到期后、面板打开前」
  // 的窗口（~3/60 概率）：条目在面板打开前已被重挂，隐藏断言必红（fulle2e 实测）
  const items = await listNotifications()
  const target = items.find(n => n.title === 'e2e-延后-到期重挂')
  expect(target).toBeTruthy()
  const resp = await snoozeApi(target!.id, new Date(Date.now() + 12_000).toISOString())
  expect(resp.ok).toBeTruthy()

  await openPanel(page)
  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-延后-到期重挂' })
  // 延后生效：常规流暂离
  await expect(row).toHaveCount(0, { timeout: 3000 })

  // 到点重挂：服务端分钟巡检（≤~60s）清标记、置未读、时间戳前移；
  // WS snoozeDue 实时送达 → 条目回到常规流且未读，徽标恢复
  await expect(row).toHaveCount(1, { timeout: 90_000 })
  await expect(row).toHaveClass(/unread/, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toBeVisible()
  // 重挂后不再是延后态：已延后页签计数归零（页签计数徽标随 >0 才显示）
  await expect(page.locator('.nc-filter-btn').filter({ hasText: '已延后' })).not.toContainText('1')
})

test('snooze API 契约：坏 snoozeUntil 400 稳定原文、未知 id 404', async () => {
  const items = await listNotifications()
  const anyId = items[0]?.id ?? 'missing-id'

  const bad = await snoozeApi(anyId, 'not-a-time')
  expect(bad.status).toBe(400)
  const badBody = (await bad.json()) as { error?: string }
  expect(badBody.error).toBe('snoozeUntil must be RFC3339 or empty')

  const missing = await snoozeApi('e2e-missing-id', new Date().toISOString())
  expect(missing.status).toBe(404)
})
