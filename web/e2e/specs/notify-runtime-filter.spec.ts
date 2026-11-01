import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心 runtime 过滤 chips E2E（P-20261003-187）：
 *   - 动态清单：条目携带的 runtime 去重成 chip（重复 runtime 不重复出 chip），
 *     无 runtime 条目的通知不产生 chips 行
 *   - 过滤语义：选中 runtime chip → 带其他 runtime 的条目隐藏、选中条目可见；
 *     无 runtime 条目不受过滤（无归属恒可见，任务/克隆类不被藏掉）
 *   - AND 组合：runtime 与项目维正交叠加（交集可见）
 *   - 持久化同构（P-173）：选择跨刷新恢复；选中 runtime 的条目清空后对账回落
 *     「全部运行时」且回落态写回 localStorage
 * 通知经 POST /api/notifications 播种（runtime 字段服务端透传落盘）；用例开头
 * 先 API 清空、结束后再清空。过滤选择落 localStorage，Playwright 每用例独立
 * context 天然隔离。
 */

const PROJ_A = 'e2e-runtime-alpha'
const FILTER_STORAGE_KEY = 'notify-filter'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearAll(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  expect(res.ok).toBeTruthy()
}

async function seed(headers: Record<string, string>, notes: Array<{
  title: string
  runtime?: string
  category?: string
  projectId?: string
  projectName?: string
}>) {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'warning',
        category: n.category ?? 'system',
        title: n.title,
        body: '',
        runtime: n.runtime ?? '',
        projectId: n.projectId ?? '',
        projectName: n.projectName ?? '',
      }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function openPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

const row = (page: import('@playwright/test').Page, text: string) =>
  page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })

test.beforeAll(async () => {
  await clearAll(await unlockHeaders())
})

test.afterAll(async () => {
  await clearAll(await unlockHeaders())
})

test('runtime chips 动态清单：去重成候选；选中后他 runtime 隐藏、无 runtime 条目不受过滤', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-runtime-claude-甲', runtime: 'claude' },
    { title: 'e2e-runtime-claude-乙', runtime: 'claude' },
    { title: 'e2e-runtime-codex', runtime: 'codex' },
    { title: 'e2e-runtime-none-task', category: 'task' },
  ])

  await openPanel(page)

  // 动态清单：两个 claude 条目只出一片 chip；注册名走既有显示名（Claude Code）
  const chips = page.locator('[data-testid="notif-runtime-chips"]')
  await expect(chips).toBeVisible()
  await expect(page.locator('[data-testid="notif-runtime-chip-claude"]')).toHaveText('Claude Code')
  await expect(page.locator('[data-testid="notif-runtime-chip-codex"]')).toHaveText('Codex')
  await expect(page.locator('.nc-runtime-chip')).toHaveCount(3) // 全部 + claude + codex

  // 默认「全部运行时」：四条全可见
  await expect(row(page, 'e2e-runtime-claude-甲')).toHaveCount(1)
  await expect(row(page, 'e2e-runtime-claude-乙')).toHaveCount(1)
  await expect(row(page, 'e2e-runtime-codex')).toHaveCount(1)
  await expect(row(page, 'e2e-runtime-none-task')).toHaveCount(1)

  // 选 claude：codex 隐藏、claude 两条可见；无 runtime 条目不受过滤仍可见
  await page.locator('[data-testid="notif-runtime-chip-claude"]').click()
  await expect(page.locator('[data-testid="notif-runtime-chip-claude"]')).toHaveClass(/active/)
  await expect(row(page, 'e2e-runtime-claude-甲')).toHaveCount(1)
  await expect(row(page, 'e2e-runtime-claude-乙')).toHaveCount(1)
  await expect(row(page, 'e2e-runtime-codex')).toHaveCount(0)
  await expect(row(page, 'e2e-runtime-none-task')).toHaveCount(1)

  // 「全部运行时」恢复档：全部回来
  await page.locator('[data-testid="notif-runtime-chip-all"]').click()
  await expect(row(page, 'e2e-runtime-codex')).toHaveCount(1)
  await expect(page.locator('[data-testid="notif-runtime-chip-all"]')).toHaveClass(/active/)
})

test('runtime 与项目维 AND 叠加：交集可见，并集不出现', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-and-claude-A', runtime: 'claude', projectId: PROJ_A, projectName: '运行时A项目' },
    { title: 'e2e-and-codex-A', runtime: 'codex', projectId: PROJ_A, projectName: '运行时A项目' },
    { title: 'e2e-and-claude-B', runtime: 'claude', projectId: 'e2e-runtime-beta', projectName: '运行时B项目' },
  ])

  await openPanel(page)
  await page.locator('[data-testid="notif-runtime-chip-claude"]').click()
  // 仅选 claude：A/B 的 claude 可见，codex 隐藏
  await expect(row(page, 'e2e-and-claude-A')).toHaveCount(1)
  await expect(row(page, 'e2e-and-claude-B')).toHaveCount(1)
  await expect(row(page, 'e2e-and-codex-A')).toHaveCount(0)
  // 叠加项目 A：只剩 A 的 claude
  await page.locator('.nc-project-select').selectOption(PROJ_A)
  await expect(row(page, 'e2e-and-claude-A')).toHaveCount(1)
  await expect(row(page, 'e2e-and-claude-B')).toHaveCount(0)
  await expect(row(page, 'e2e-and-codex-A')).toHaveCount(0)
})

test('选择持久化跨刷新恢复；候选消失后对账回落「全部运行时」写回持久层', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-persist-claude', runtime: 'claude' },
    { title: 'e2e-persist-codex', runtime: 'codex' },
  ])

  await openPanel(page)
  await page.locator('[data-testid="notif-runtime-chip-claude"]').click()
  await expect(row(page, 'e2e-persist-codex')).toHaveCount(0)

  // 整页刷新重开：选中恢复（chip 激活态 + 行过滤两面对齐）
  await openPanel(page)
  await expect(page.locator('[data-testid="notif-runtime-chip-claude"]')).toHaveClass(/active/)
  await expect(row(page, 'e2e-persist-codex')).toHaveCount(0)
  await expect(row(page, 'e2e-persist-claude')).toHaveCount(1)

  // claude 条目全部移除 → 候选消失 → 重开回落「全部运行时」，codex 不被误藏
  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const items = ((await listRes.json()) as { data?: Array<{ id: string; runtime?: string }> }).data || []
  const gone = items.filter(n => n.runtime === 'claude').map(n => n.id)
  expect(gone.length).toBeGreaterThan(0)
  const dismissRes = await fetch(`${API_BASE}/api/notifications/dismiss-batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids: gone }),
  })
  expect(dismissRes.ok).toBeTruthy()

  await openPanel(page)
  await expect(page.locator('[data-testid="notif-runtime-chip-all"]')).toHaveClass(/active/)
  await expect(row(page, 'e2e-persist-codex')).toHaveCount(1)
  // 回落态同步写回持久层：localStorage 中 runtime 已清空
  const stored = await page.evaluate((k) => localStorage.getItem(k), FILTER_STORAGE_KEY)
  expect(stored).toBe(JSON.stringify({ filter: 'all', project: '', runtime: '' }))
})
