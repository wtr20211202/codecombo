import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心未读分界线 E2E（P-20261003-259）：
 *   - 面板关闭（上次查看时点）后新增的通知 → 再开时在新旧条目之间划出
 *     「上次查看后 N 条新增」分界线
 *   - 再开界线移动：本次浏览过的条目在下次关闭后沉入分界下方，只有新的新增算数
 *   - 与过滤正交：切分类页签后界线随可见条目走（筛选内无新增则不显示，
 *     筛选内全为新时界线落在列表末尾）
 *   - uiState 持久：整页刷新重开，基线（notificationCenter.lastSeenAt）沿用
 *
 * 列表按时间倒序（最新在前）：分界线之上是新增、之下是上次查看前已有的条目
 *（任务书「上方旧下方新」按时间正序的表述按实际列表序适配）。
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，不残留
 * 测试数据）；基线时点经 GET /api/ui-state 轮询确认已落库，避免「关闭写
 * 异步未达 → 重开读旧值」的时序假败。
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearAll(headers: Record<string, string>): Promise<void> {
  const res = await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  expect(res.ok).toBeTruthy()
}

async function seed(
  headers: Record<string, string>,
  notes: Array<{ title: string; category?: string }>,
): Promise<void> {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: 'info', category: n.category ?? 'system', title: n.title, body: '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

/** 已落库的上次查看时点：取所有实例记录中的最大值（当前实例键为 'local'，
 *  不硬编码实例键；分界线只关心当前服务的实例，取 max 对本用例单实例等价） */
async function readLastSeen(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  if (!res.ok) return 0
  const body = (await res.json()) as {
    data?: Record<string, { notificationCenter?: { lastSeenAt?: unknown } }>
  }
  let max = 0
  for (const rec of Object.values(body.data || {})) {
    const v = rec?.notificationCenter?.lastSeenAt
    if (typeof v === 'number' && Number.isFinite(v) && v > max) max = v
  }
  return max
}

async function openPanel(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

/** 面板已关闭状态下的再开（不整页刷新，验证会话内基线推进） */
async function reopenPanel(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

/** 关闭面板 = 记录上次查看时点（P-20261003-259 的定义），并等基线落库。
 *  落库后再等 50ms：确保随后播种的服务端时间严格晚于 lastSeen（同毫秒按旧
 *  处理，界线才稳定落在新增一侧） */
async function closePanel(page: import('@playwright/test').Page, headers: Record<string, string>): Promise<void> {
  const before = await readLastSeen(headers)
  await page.keyboard.press('Escape')
  await expect(page.locator('.nc-card')).toBeHidden({ timeout: 3000 })
  await expect.poll(() => readLastSeen(headers), { timeout: 5000 }).toBeGreaterThan(before)
  await page.waitForTimeout(50)
}

const row = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
const divider = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="notif-unread-divider"]')
const filterBtn = (page: import('@playwright/test').Page, label: string) =>
  page.locator('.nc-filter-btn').filter({ hasText: label })

/** 垂直序断言（列表可滚动区域 ≤ 一屏，行均在视口内） */
async function expectAbove(upper: import('@playwright/test').Locator, lower: import('@playwright/test').Locator): Promise<void> {
  const a = await upper.boundingBox()
  const b = await lower.boundingBox()
  expect(a, '上方元素不可见').not.toBeNull()
  expect(b, '下方元素不可见').not.toBeNull()
  expect(a!.y + a!.height).toBeLessThanOrEqual(b!.y + 1)
}

test.beforeAll(async () => {
  await clearAll(await unlockHeaders())
})

test.afterAll(async () => {
  await clearAll(await unlockHeaders())
})

test('关闭面板后新增通知：再开在新旧之间划出分界线，刷新后基线仍在', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [{ title: 'e2e-分界-旧条目' }])

  // 打开再关闭 = 建立「上次查看」基线（基线推进随关闭时刻）
  await openPanel(page)
  await closePanel(page, headers)

  await seed(headers, [{ title: 'e2e-分界-新条目' }])
  await reopenPanel(page)

  const d = divider(page)
  await expect(d).toHaveCount(1, { timeout: 3000 })
  await expect(d).toContainText('上次查看后 1 条新增')
  // 列表新→旧：新条目在界线上方、旧条目在下方
  await expectAbove(row(page, 'e2e-分界-新条目'), d)
  await expectAbove(d, row(page, 'e2e-分界-旧条目'))

  // uiState 持久：整页刷新重开，基线沿服务端持久值恢复（分界仍在原位）
  await openPanel(page)
  await expect(divider(page)).toHaveCount(1, { timeout: 3000 })
  await expect(divider(page)).toContainText('上次查看后 1 条新增')
  await expectAbove(row(page, 'e2e-分界-新条目'), divider(page))
  await expectAbove(divider(page), row(page, 'e2e-分界-旧条目'))

  await closePanel(page, headers)
})

test('再开界线移动：上次的新增沉入分界下方，只剩最新新增在界线上方', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [{ title: 'e2e-移动-旧条目' }])

  await openPanel(page)
  await closePanel(page, headers)

  await seed(headers, [{ title: 'e2e-移动-第一次新增' }])
  await reopenPanel(page)
  await expect(divider(page)).toContainText('上次查看后 1 条新增', { timeout: 3000 })
  await expectAbove(row(page, 'e2e-移动-第一次新增'), divider(page))

  // 关闭推进基线 → 播种第二条新增 → 再开：界线移到最新条目之后
  await closePanel(page, headers)
  await seed(headers, [{ title: 'e2e-移动-第二次新增' }])
  await reopenPanel(page)

  await expect(divider(page)).toHaveCount(1, { timeout: 3000 })
  await expect(divider(page)).toContainText('上次查看后 1 条新增')
  await expectAbove(row(page, 'e2e-移动-第二次新增'), divider(page))
  await expectAbove(divider(page), row(page, 'e2e-移动-第一次新增'))
  await expectAbove(row(page, 'e2e-移动-第一次新增'), row(page, 'e2e-移动-旧条目'))

  await closePanel(page, headers)
})

test('与过滤正交：界线随当前页签的可见条目移动，筛选内无新增则不显示', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [{ title: 'e2e-正交-旧系统', category: 'system' }])

  await openPanel(page)
  await closePanel(page, headers)

  await seed(headers, [{ title: 'e2e-正交-新Git', category: 'git' }])
  await reopenPanel(page)
  await expect(divider(page)).toContainText('上次查看后 1 条新增', { timeout: 3000 })
  await expectAbove(row(page, 'e2e-正交-新Git'), divider(page))
  await expectAbove(divider(page), row(page, 'e2e-正交-旧系统'))

  // Git 页签：只剩新条目 → 界线随条目落到列表末尾，计数仍为 1
  await filterBtn(page, 'Git').click()
  await expect(row(page, 'e2e-正交-旧系统')).toHaveCount(0)
  await expect(divider(page)).toContainText('上次查看后 1 条新增', { timeout: 3000 })
  await expectAbove(row(page, 'e2e-正交-新Git'), divider(page))

  // 系统页签：只剩旧条目 → 该视图没有新增，不渲染界线
  await filterBtn(page, '系统').click()
  await expect(row(page, 'e2e-正交-新Git')).toHaveCount(0)
  await expect(divider(page)).toHaveCount(0)

  // 回「全部」：界线回到新 Git 与旧系统之间
  await filterBtn(page, '全部').click()
  await expect(divider(page)).toHaveCount(1, { timeout: 3000 })
  await expectAbove(row(page, 'e2e-正交-新Git'), divider(page))
  await expectAbove(divider(page), row(page, 'e2e-正交-旧系统'))

  await closePanel(page, headers)
})
