import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { DND_MANUAL_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * 手动临时免打扰快速档 E2E（P-20261003-227）：
 *   1. 铃铛旁 toggle「免打扰 1 小时」→ active 态 + title 剩余时长；时段内
 *      ops-notify toast 静默（OpsChannelBridge isSilenced 前置拦截），通知
 *      中心照常入账（入账链不经过免打扰判定，OR 组合的手动源同口径）；
 *      toggle「关闭免打扰」→ 同链路 toast 恢复弹出（手动解除即时生效）
 *   2. 播种 {until: now+12s}（绝对到期时刻，store 原样恢复并排期到期定时器）
 *      → 到期自动恢复：临时免打扰已结束 通知入账 + toggle 退 active + 同链路
 *      toast 不再静默
 *   3. 播种 {until: 0}（直到手动关哨兵）→ active 恒生效 + toast 静默；手动关
 *      后恢复。0 哨兵经 localStorage 落盘/恢复（JSON 安全，Infinity 不可用）
 * 桌面通知生效点（useDesktopNotify）与 alertSound 同走 isSilenced 统一入口，
 * 静默分支由 dndStore 单测覆盖，e2e 页面恒可见态下本就跳过桌面弹出，不断言。
 * 免打扰偏好存 localStorage（每用例独立 context 互不泄漏）；通知列表为服务端
 * 全局状态：beforeAll/afterAll 清空防残留（同 notify-dnd.spec）。
 */

const TOAST_DND = 'e2e-dnd-manual-静默通知'
const TOAST_CTRL = 'e2e-dnd-manual-放行通知'
const DONE_TASK = 'e2e-dnd-manual-入账任务'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearNotes(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

// ops-notify toast 路径：type=notify 直达 OpsChannelBridge.onNotify（isSilenced 生效点）
async function postToast(page: import('@playwright/test').Page, headers: Record<string, string>, message: string): Promise<void> {
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'notify', payload: { message, level: 'info' } },
  })
}

async function postTaskDone(page: import('@playwright/test').Page, headers: Record<string, string>, task: string): Promise<void> {
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task, status: 'done' } },
  })
}

// 进入项目页（TopBar/铃铛在项目视图；home 无顶栏铃铛）
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  // ops-channel / notifications 两条 WS 建立窗口（同 task-done-notify 口径）
  await page.waitForTimeout(800)
}

function toggle(page: import('@playwright/test').Page) {
  return page.locator('[data-testid="topbar-dnd-toggle"]')
}

// 展开临时免打扰下拉并点选指定档
async function pickDndOption(page: import('@playwright/test').Page, label: string): Promise<void> {
  await toggle(page).click()
  await page.locator('.n-dropdown-option', { hasText: label }).first().click()
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await clearNotes(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await clearNotes(headers)
})

test('toggle 开 1 小时 → toast 静默、通知中心照常入账；手动关 → 恢复弹出', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)

  // 默认关：按钮非 active，title 为功能名
  await expect(toggle(page)).not.toHaveClass(/active/)
  await expect(toggle(page)).toHaveAttribute('title', '临时免打扰')

  // 开启 1 小时档：操作反馈（message）+ active 态 + title 带剩余时长
  await pickDndOption(page, '免打扰 1 小时')
  await expect(page.locator('.n-message').filter({ hasText: '已开启临时免打扰 1 小时' })).toBeVisible({ timeout: 5000 })
  await expect(toggle(page)).toHaveClass(/active/)
  await expect(toggle(page)).toHaveAttribute('title', /临时免打扰中 · 剩余/)

  // 开启确认 toast 自愈期（naive-ui message 默认 3s）过后再断言静默，防串扰
  await page.waitForTimeout(3500)

  // 时段内 toast 路径静默：notify 送达（由下方入账断言反证链路通）但不弹层
  const headers = await unlockHeaders()
  await postToast(page, headers, TOAST_DND)
  await page.waitForTimeout(3500)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_DND })).toHaveCount(0)

  // 同一时段通知中心照常入账：task.progress done → 条目出现（静默只吞打扰不吞账）
  await postTaskDone(page, headers, DONE_TASK)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-item').filter({ hasText: DONE_TASK }).first()).toBeVisible({ timeout: 8000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.nc-card')).toBeHidden({ timeout: 3000 })

  // 手动关闭：即时恢复（active 退场 + 同链路 toast 正常弹出作对照）
  await pickDndOption(page, '关闭免打扰')
  await expect(page.locator('.n-message').filter({ hasText: '已关闭临时免打扰' })).toBeVisible({ timeout: 5000 })
  await expect(toggle(page)).not.toHaveClass(/active/)
  await page.waitForTimeout(3500)
  await postToast(page, headers, TOAST_CTRL)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_CTRL })).toBeVisible({ timeout: 5000 })
})

test('到期自动恢复：入账「临时免打扰已结束」+ toggle 退 active + toast 解除静默', async ({ page }) => {
  test.setTimeout(60000)
  // 播种绝对到期时刻（now+12s）：init script 先于应用执行，store 挂载时按
  // 剩余时长排期到期定时器（留足 进项目+挂载 的启动余量）
  await page.addInitScript(([key]) => {
    localStorage.setItem(key as string, JSON.stringify({ until: Date.now() + 12_000 }))
  }, [DND_MANUAL_STORAGE_KEY])
  await enterProject(page)

  // 播种档即时生效（store load 恢复 + TopBar active 态）
  await expect(toggle(page)).toHaveClass(/active/)
  await expect(toggle(page)).toHaveAttribute('title', /临时免打扰中 · 剩余/)

  // 到期自动恢复：通知中心入账「临时免打扰已结束」（定时器驱动，等待窗覆盖
  // 12s 播种 + 后台标签页定时器最小节流余量）
  await page.locator('button[title="通知中心"]').first().click()
  const expiredRow = page.locator('.nc-item').filter({ hasText: '临时免打扰已结束' }).first()
  await expect(expiredRow).toBeVisible({ timeout: 25000 })
  await page.keyboard.press('Escape')

  // 状态退场 + 静默解除：同链路 toast 恢复弹出
  await expect(toggle(page)).not.toHaveClass(/active/)
  await expect(toggle(page)).toHaveAttribute('title', '临时免打扰')
  const headers = await unlockHeaders()
  await postToast(page, headers, TOAST_CTRL)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_CTRL })).toBeVisible({ timeout: 5000 })
})

test('直到手动关哨兵（until=0）：跨重启恢复恒静默，手动关解除', async ({ page }) => {
  test.setTimeout(60000)
  await page.addInitScript(([key]) => {
    localStorage.setItem(key as string, JSON.stringify({ until: 0 }))
  }, [DND_MANUAL_STORAGE_KEY])
  await enterProject(page)

  // 0 哨兵恢复为「直到手动关」：active + title 无剩余时长段
  await expect(toggle(page)).toHaveClass(/active/)
  await expect(toggle(page)).toHaveAttribute('title', '临时免打扰中 · 直到手动关闭')

  // 静默生效（开启反馈 toast 不存在——播种路径无 UI 动作，顺证无串扰）
  const headers = await unlockHeaders()
  await postToast(page, headers, TOAST_DND)
  await page.waitForTimeout(3500)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_DND })).toHaveCount(0)

  // 手动关解除
  await pickDndOption(page, '关闭免打扰')
  await expect(toggle(page)).not.toHaveClass(/active/)
  await page.waitForTimeout(3500)
  await postToast(page, headers, TOAST_CTRL)
  await expect(page.locator('.n-message').filter({ hasText: TOAST_CTRL })).toBeVisible({ timeout: 5000 })
})
