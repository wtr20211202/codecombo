import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知动作条目的首页生效链 E2E（P-20261007-15）：
 * pendingAction 消费面挂载于项目页 Layout，首页点动作条目此前只有生产者没有
 * 消费者，动作静默丢失。路由桥接链全真验证：
 *   1. 首页播种带 terminal 动作通知（projectId + 会话 id，与服务端
 *      OnSentinelHit 等入账形状同构）→ 点击 → 路由桥接进项目页 → Layout 引导
 *      完成后 immediate 回放 → switchProject + 底部终端面板打开 + 对应 tab 激活
 *   2. url 型动作 set 处直开新窗（不走桥接，当前页不跳转）
 *   3. 无动作通知点击行为不变（标已读，不路由）
 * 项目用共享实例预置的 simple-coding（克隆流重、临时仓会放大用例时长，不重建）；
 * 会话与通知经共享实例 API 清理，不残留测试数据
 */

const SESSION_NAME = 'e2e-home-bridge-shell'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seedNotification(headers: Record<string, string>, body: Record<string, unknown>) {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  expect(res.ok).toBeTruthy()
}

async function cleanup() {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  for (const s of list) {
    if (s.name === SESSION_NAME && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

test.beforeAll(cleanup)
test.afterAll(cleanup)

/** 首页打开通知中心（HomeView 自带铃铛入口，非项目页 TopBar） */
async function openHomeNotificationPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.home-action-btn[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test('首页点 terminal 动作通知 → 桥接进项目页 → 对应终端 tab 激活', async ({ page }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()

  // 预置项目 + 项目终端会话（通知形状与服务端 sentinel 命中入账同构：
  // ProjectID 在位时前端先切项目再跳）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id).toBeTruthy()

  const termRes = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ projectId: proj!.id, name: SESSION_NAME }),
  })
  expect(termRes.ok).toBeTruthy()
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const session = sessions.find(s => s.name === SESSION_NAME)
  expect(session?.id).toBeTruthy()

  await seedNotification(headers, {
    type: 'warning',
    category: 'system',
    title: '哨兵命中：e2e-home-bridge',
    body: `${SESSION_NAME}: secret-leak`,
    projectId: proj!.id,
    projectName: proj!.name,
    action: 'terminal',
    actionPayload: session!.id,
  })

  // 停留首页点击（桥接链起点：pendingAction set 于非 project 路由）
  await openHomeNotificationPanel(page)
  const row = page.locator('.nc-item').filter({ hasText: '哨兵命中：e2e-home-bridge' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.click()

  // 路由桥接：非 project 路由先 push /project，Layout 引导完成挂 watch 后
  // immediate 回放 → 跨项目 switchProject + 底部终端 tab 激活
  await page.waitForURL('**/project', { timeout: 15000 })
  const panel = page.locator('.bottom-panel')
  await expect(panel).toBeVisible({ timeout: 15000 })
  const tab = panel.locator('.term-tab.is-active')
  await expect(tab).toHaveCount(1, { timeout: 20000 })
  await expect(tab).toContainText(SESSION_NAME)
  await expect(panel.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
})

test('首页点 url 动作通知 → set 处直开新窗，当前页不路由', async ({ page, context }) => {
  const headers = await unlockHeaders()
  await seedNotification(headers, {
    type: 'info',
    category: 'system',
    title: 'e2e-home-bridge-url',
    body: '',
    action: 'url',
    actionPayload: 'about:blank#e2e-home-bridge',
  })

  await openHomeNotificationPanel(page)
  const row = page.locator('.nc-item').filter({ hasText: 'e2e-home-bridge-url' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })

  await row.click()
  // noopener 新窗不携带 opener 关系，本机 Chromium/CDP 组合不派发 popup 事件
  // （实测探针：窗口在 ctx.pages() 可见而事件不触发）——按 pages 清单轮询断言
  const deadline = Date.now() + 10000
  let popup: import('@playwright/test').Page | undefined
  while (!popup && Date.now() < deadline) {
    popup = context.pages().find(p => p.url().includes('e2e-home-bridge'))
    if (!popup) await page.waitForTimeout(250)
  }
  expect(popup?.url()).toContain('about:blank')
  // 不走桥接：当前页停留首页（url 型与项目页无涉，无须先落项目页）
  await page.waitForTimeout(1000)
  expect(page.url()).not.toContain('/project')
})

test('首页点无动作通知 → 标已读，不路由不桥接', async ({ page }) => {
  const headers = await unlockHeaders()
  await seedNotification(headers, {
    type: 'info',
    category: 'system',
    title: 'e2e-home-bridge-plain',
    body: 'no action',
  })

  await openHomeNotificationPanel(page)
  const row = page.locator('.nc-item').filter({ hasText: 'e2e-home-bridge-plain' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.click()

  // 无动作仅标已读：给桥接链足够的不触发窗口后断言路由未变
  await page.waitForTimeout(1500)
  expect(page.url()).not.toContain('/project')
})
