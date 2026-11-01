import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知滚动自动已读 E2E（P-20261003-260）：
 *   1. 默认关（历史行为零变化）：滚过列表底部，条目保持未读、徽标不变；
 *      Shift+A 批量已读不受影响（正交性——自动已读只加 markRead 来源，
 *      不动既有清理动作）
 *   2. 设置行开启（真实勾选 + 保存，默认未勾选一并验证）→ 重开面板：
 *      视口内未读先批量标读（滚过即读过），分步滚到底后全部已读、徽标清零，
 *      服务端同步（markRead 逐条 readOne 落库，非仅前端置位）
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，
 * 不残留测试数据）。开关是 localStorage 偏好（notify-scroll-read），
 * Playwright 每用例全新 context 天然隔离。
 */

const SEED_COUNT = 16 // 面板视口约容 6~7 行，16 条保证滚到底必有一批条目滚过视口

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seed(headers: Record<string, string>): Promise<string[]> {
  const titles: string[] = []
  for (let i = 1; i <= SEED_COUNT; i++) {
    const title = `e2e-scroll-read-${String(i).padStart(2, '0')}`
    titles.push(title)
    // 标题互异防同类聚合（聚合组行会让「滚过即读」的行级断言含混）
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'info', category: 'system', title, body: '' }),
    })
    expect(res.ok).toBeTruthy()
  }
  return titles
}

async function serverList(headers: Record<string, string>): Promise<Array<{ title?: string; read?: boolean }>> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  return ((await res.json()) as { data?: Array<{ title?: string; read?: boolean }> }).data || []
}

async function openPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

// 分步滚动到底（真实滚动轨迹）：IntersectionObserver 只在帧边界报告交集，
// 一步跳底会让中间行从未进入视口——分步前进模拟人手滚轮，滚过的行全数可见过
async function scrollListToBottom(page: Page) {
  await page.locator('.nc-list').evaluate(async (el) => {
    const step = Math.max(120, Math.floor(el.clientHeight * 0.6))
    for (let top = 0; top <= el.scrollHeight; top += step) {
      el.scrollTop = top
      await new Promise(r => setTimeout(r, 120))
    }
    el.scrollTop = el.scrollHeight
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

test('默认关：滚到底不标已读，Shift+A 仍可用（正交）', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers)

  await openPanel(page)
  await expect(page.locator('.notify-badge')).toHaveText(String(SEED_COUNT), { timeout: 3000 })

  // 滚过全部条目：默认关 = 零自动已读（首行保持未读、徽标不变）
  await scrollListToBottom(page)
  await page.waitForTimeout(600) // 越过 300ms 合流窗：若误开启此处必然已标读
  const first = page.locator('.nc-item').filter({ hasText: 'e2e-scroll-read-16' })
  await expect(first).toBeVisible()
  await expect(first).toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText(String(SEED_COUNT))

  // 正交性：Shift+A 批量已读照常工作（全部置已读 + 徽标清零 + 行保留）
  await page.locator('.nc-card').focus()
  await page.keyboard.press('Shift+A')
  await expect(page.locator('.n-message')).toHaveText(`已全部标记为已读（${SEED_COUNT} 条）`)
  await expect(page.locator('.notify-badge')).toHaveCount(0)
  await expect(first).toBeVisible()
  await expect(first).not.toHaveClass(/unread/)
})

test('开关开：视口内先标读，滚到底全部已读并同步服务端', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers)

  await openPanel(page)
  await expect(page.locator('.notify-badge')).toHaveText(String(SEED_COUNT), { timeout: 3000 })

  // 设置行开启（真实勾选 + 保存）：默认未勾选（「默认关」的设置面验证）
  await page.locator('.nc-action-btn').first().click()
  const pane = page.locator('.settings-modal .content-pane:visible')
  await expect(pane).toBeVisible({ timeout: 3000 })
  const enable = pane.locator('[data-testid="settings-scroll-read-enable"]')
  await expect(enable).toBeVisible()
  // naive-ui n-checkbox 无真实 input：勾选态走 aria-checked（testid 落根 div）
  await expect(enable).toHaveAttribute('aria-checked', 'false')
  await enable.click()
  await expect(enable).toHaveAttribute('aria-checked', 'true')
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  // 重开面板：滚入视口（首屏可见）的未读先批量标读
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.nc-item.unread')).not.toHaveCount(SEED_COUNT, { timeout: 5000 })

  // 分步滚到底：滚过的行全部标读，徽标清零
  await scrollListToBottom(page)
  await expect(page.locator('.nc-item.unread')).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.notify-badge')).toHaveCount(0)

  // 服务端同步：逐条 readOne 落库（非仅前端本地置位）
  const list = await serverList(headers)
  expect(list.length).toBe(SEED_COUNT)
  expect(list.every(n => n.read)).toBe(true)
})
