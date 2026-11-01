import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 跨实例通知聚合（P-20261003-125）E2E：
 *   1. 命令面板打开聚合弹层 → 本机 + 离线实例徽标、error/warning 置顶排序
 *   2. 只读聚合：行内零操作按钮，打开前后服务端已读态零变化（跨实例写不引入）
 *   3. 值班大屏通知卡联动：fleet 未读/离线水位速览，点击开聚合弹层
 *
 * 环境说明：真实第二实例（wsl-server）可达性随环境漂移，断言不落在它身上；
 * 离线标记用确定不可达的注册实例（关闭端口）验证，测试后清理。
 */

const ERR_TITLE = 'e2e-fleetnotify-错误-甲'
const WARN_TITLE = 'e2e-fleetnotify-警告-乙'
const INFO_TITLE = 'e2e-fleetnotify-信息-丙'
// 确定不可达：随机高位端口（49000-59999），无服务监听即连接拒绝
const OFFLINE_NAME = `e2e-offline-inst-${Math.random().toString(36).slice(2, 6)}`
const OFFLINE_URL = `http://127.0.0.1:4${Math.floor(1000 + Math.random() * 9000)}`

let unlockToken = ''
let offlineInstanceId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

async function seedNotifications() {
  for (const n of [
    { title: ERR_TITLE, type: 'error' },
    { title: WARN_TITLE, type: 'warning' },
    { title: INFO_TITLE, type: 'info' },
  ]) {
    const res = await api('POST', '/api/notifications', { category: 'system', ...n })
    expect(res.ok).toBeTruthy()
  }
}

async function listNotifications(): Promise<Array<{ id: string; title: string; read: boolean }>> {
  const res = await api('GET', '/api/notifications')
  return ((await res.json())?.data || []) as Array<{ id: string; title: string; read: boolean }>
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 通知域 spec 约定：先清空再播种（共享实例防跨 spec 残留）
  await api('POST', '/api/notifications/clear')
  await seedNotifications()

  // 注册确定不可达实例（离线标记的确定性锚点），测试后清理
  const create = await api('POST', '/api/instances', { name: OFFLINE_NAME, url: OFFLINE_URL })
  expect(create.ok).toBeTruthy()
  offlineInstanceId = ((await create.json()) as { data?: { id?: string } }).data?.id || ''
  expect(offlineInstanceId).toBeTruthy()
})

test.afterAll(async () => {
  if (offlineInstanceId) await api('DELETE', `/api/instances/${offlineInstanceId}`)
  await api('POST', '/api/notifications/clear')
})

/** 命令面板打开聚合弹层 */
async function openFleetNotify(page: import('@playwright/test').Page) {
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette input, [class*="palette"] input').first().waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.type('跨实例通知')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  const modal = page.locator('.n-modal').filter({ hasText: '跨实例通知' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

test('聚合打开：实例徽标含本机与离线实例，error/warning 置顶排序', async ({ page }) => {
  await fixedLocale(page)
  // /project 是命令面板快捷键的已验证路径（instance-sessions-overview 同款动线）
  await gotoAndUnlock(page, `${API_BASE}/project`)
  await page.waitForTimeout(1200)
  const modal = await openFleetNotify(page)

  // 实例徽标行：至少本机 + 离线实例两枚；离线实例带「不可达」标记
  const chips = modal.locator('[data-testid="fleet-notify-chip"]')
  await expect(chips.filter({ hasText: OFFLINE_NAME })).toBeVisible({ timeout: 10_000 })
  await expect(chips.filter({ hasText: OFFLINE_NAME })).toContainText('不可达')
  expect(await chips.count()).toBeGreaterThanOrEqual(2)
  // 离线注记条：不可达实例的通知未计入
  await expect(modal.locator('[data-testid="fleet-notify-offline"]')).toBeVisible()

  // error/warning 优先排序：错误 < 警告 < 信息（按出现次序）
  const rows = modal.locator('[data-testid="fleet-notify-row"]')
  await expect(rows.filter({ hasText: ERR_TITLE })).toBeVisible({ timeout: 8000 })
  const texts = await rows.allTextContents()
  const ei = texts.findIndex(t => t.includes(ERR_TITLE))
  const wi = texts.findIndex(t => t.includes(WARN_TITLE))
  const ii = texts.findIndex(t => t.includes(INFO_TITLE))
  expect(ei).toBeGreaterThanOrEqual(0)
  expect(wi).toBeGreaterThan(ei)
  expect(ii).toBeGreaterThan(wi)
  // 实例徽标随行：本机条目带中心实例徽标（行内非空徽标列）
  await expect(rows.filter({ hasText: ERR_TITLE })).toContainText('本机', { ignoreCase: true })
})

test('只读聚合：行内零操作按钮，服务端已读态零变化', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)
  await page.waitForTimeout(1200)
  const before = await listNotifications()
  expect(before.filter(n => n.title.startsWith('e2e-fleetnotify')).length).toBeGreaterThanOrEqual(3)

  const modal = await openFleetNotify(page)
  await expect(modal.locator('[data-testid="fleet-notify-row"]').first()).toBeVisible({ timeout: 8000 })

  // 行内无任何操作按钮（已读/移除/延后回各自实例通知中心做）
  await expect(modal.locator('[data-testid="fleet-notify-row"] button')).toHaveCount(0)

  // 打开聚合（逐实例拉取+渲染）后服务端已读态零变化：聚合是纯读面
  await page.waitForTimeout(1000)
  const after = await listNotifications()
  for (const b of before.filter(n => n.title.startsWith('e2e-fleetnotify'))) {
    const a = after.find(n => n.id === b.id)
    expect(a, `条目 ${b.title} 应仍在`).toBeTruthy()
    expect(a!.read, `条目 ${b.title} 已读态不应被聚合改变`).toBe(b.read)
  }
})

test('值班大屏通知卡：fleet 水位速览 + 点击开聚合弹层', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await page.waitForTimeout(1200)

  // 通知卡常显（isEmpty 守卫之外）：含本机未读水位与离线实例标记
  const card = page.locator('[data-testid="monitor-fleet-notify-card"]')
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('[data-testid="monitor-fleet-notify-instance"]').filter({ hasText: OFFLINE_NAME })).toBeVisible({ timeout: 10_000 })
  await expect(card.locator('[data-testid="monitor-fleet-notify-instance"]').filter({ hasText: OFFLINE_NAME })).toContainText('不可达')
  // 本机未读徽标 ≥ 3（beforeAll 播种的 error/warning/info 全部未读）
  const localRow = card.locator('[data-testid="monitor-fleet-notify-instance"]').first()
  await expect(localRow.locator('[data-testid="monitor-fleet-notify-unread"]')).toBeVisible()
  const unread = Number(await localRow.locator('[data-testid="monitor-fleet-notify-unread"]').textContent())
  expect(unread).toBeGreaterThanOrEqual(3)

  // 点击卡片 → 聚合弹层（值班大屏自宿主）打开且渲染聚合列表
  await card.click()
  const modal = page.locator('.n-modal').filter({ hasText: '跨实例通知' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  await expect(modal.locator('[data-testid="fleet-notify-list"]')).toBeVisible({ timeout: 8000 })
  await expect(modal.locator('[data-testid="fleet-notify-chip"]').filter({ hasText: OFFLINE_NAME })).toContainText('不可达', { timeout: 10_000 })
})
