import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { installDesktopNotifyStub, desktopNotifyCalls, clickDesktopNotification } from '../../tests/desktop-notify-stub'
import { OPS_ACTIVATE_TERMINAL } from '../../src/utils/opsEvents'

/**
 * 桌面通知点击会话直达 E2E（P-20261004-121）：回拉信号最后一米——点击桌面通知
 * 不只 window.focus()，还派发与在册卡「查看会话」同款 OPS_ACTIVATE_TERMINAL
 * 激活广播（落点由 useAgentTerminal / TerminalView 既有消费端接管）。桩语境
 * （tests/desktop-notify-stub.ts：document.hidden 恒 true 补可见性门）下锁两条
 * 真实链路的透传与点击行为：
 *   1. agentTaskNotify 直发链：ops-notify 播种 task.progress done → 桌面通知
 *      data 落档 terminalId（透传）→ 桩实例 onclick → 窗口聚焦 + 广播携带该 id
 *   2. 通知中心 watch 链：POST /api/notifications error 级条目带 terminal 动作
 *      → 桌面通知 data 落档（error 条目经服务端回流晚于直发、同 tag 槽后到者
 *      替换——watch 不透传会冲掉直发链携带的落点）
 * 广播对不存在的会话 id 无落点（消费端按会话表对账早退）——本 spec 锁「点击
 * 派发」这一环，落点归属由 useDesktopNotify 单测与 notify-jump.spec（在册卡链）
 * 覆盖。通知经共享实例 API 清理，不残留测试数据
 */

const DIRECT_TASK = 'e2e-click-jump-直发任务'
const DIRECT_TERMINAL = 'e2e-click-jump-t1'
const CENTER_TITLE = 'e2e-click-jump-中心条目'
const CENTER_TERMINAL = 'e2e-click-jump-t2'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 点击探针：点击前注册——记录 OPS_ACTIVATE_TERMINAL 广播 detail 与 window.focus
// 调用次数（覆盖法：包装原 focus，行为不变仅计数）
async function installClickProbe(page: Page) {
  await page.evaluate((type) => {
    const w = window as unknown as { __jumpProbe?: Array<{ id?: string }>; __focusCount?: number }
    w.__jumpProbe = []
    w.__focusCount = 0
    window.addEventListener(type, (e) => {
      w.__jumpProbe!.push((e as CustomEvent<{ id?: string }>).detail)
    })
    const origFocus = window.focus.bind(window)
    window.focus = () => {
      w.__focusCount = (w.__focusCount ?? 0) + 1
      origFocus()
    }
  }, OPS_ACTIVATE_TERMINAL)
}

async function clickProbeSnapshot(page: Page): Promise<{ focus?: number; jumps?: Array<{ id?: string }> }> {
  return page.evaluate(() => {
    const w = window as unknown as { __jumpProbe?: Array<{ id?: string }>; __focusCount?: number }
    return { focus: w.__focusCount, jumps: w.__jumpProbe }
  })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('agentTaskNotify 直发链：done → data 落档 terminalId，点击聚焦窗口并派发激活广播', async ({ page }) => {
  test.setTimeout(60000)
  await installDesktopNotifyStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // ops-channel WS 在 App 挂载即连：留出建立窗口再播种（task-done-notify.spec 同款）
  await page.waitForTimeout(800)

  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: DIRECT_TASK, status: 'done', terminalId: DIRECT_TERMINAL } },
  })

  // 直发桌面通知 data 落档 terminalId（透传；无 running 起点正文不含耗时）
  await expect.poll(() => desktopNotifyCalls(page), { timeout: 5000 }).toEqual([
    { title: DIRECT_TASK, body: '已完成', data: { terminalId: DIRECT_TERMINAL } },
  ])

  await installClickProbe(page)
  await clickDesktopNotification(page, 0)
  expect(await clickProbeSnapshot(page)).toEqual({ focus: 1, jumps: [{ id: DIRECT_TERMINAL }] })
})

test('通知中心 watch 链：error 条目带 terminal 动作 → data 落档，点击同款广播', async ({ page }) => {
  test.setTimeout(60000)
  await installDesktopNotifyStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 桌面通知 watch 挂载在 NotificationCenter 组件内（v-if=showPanel）——面板开着
  // 通知到达才会走桌面弹层判定（notify-dnd-error-pierce.spec 同款前提）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.waitForTimeout(800)

  const headers = await unlockHeaders()
  const res = await page.request.post(`${API_BASE}/api/notifications`, {
    headers,
    data: { type: 'error', category: 'task', title: CENTER_TITLE, body: 'boom', action: 'terminal', actionPayload: CENTER_TERMINAL },
  })
  expect(res.ok()).toBeTruthy()

  // watch 透传条目 terminal 动作：桌面通知 data 落档（同 tag 槽替换链的落点保真）
  await expect.poll(() => desktopNotifyCalls(page), { timeout: 5000 }).toEqual([
    { title: CENTER_TITLE, body: 'boom', data: { terminalId: CENTER_TERMINAL } },
  ])

  await installClickProbe(page)
  await clickDesktopNotification(page, 0)
  expect(await clickProbeSnapshot(page)).toEqual({ focus: 1, jumps: [{ id: CENTER_TERMINAL }] })
})
