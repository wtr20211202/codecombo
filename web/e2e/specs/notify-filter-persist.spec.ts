import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心过滤选择持久化 E2E（P-20261003-173）：
 *   - 选过滤组合（项目 A × error 页签）→ 整页刷新重开面板 → 选择恢复
 *     （页签激活态/下拉值/行过滤三面对齐，两个维度都验证）
 *   - 失效项目选择回落：持久化的项目其通知被清空后（候选清单从条目聚合），
 *     重开面板回落「全部项目」，持久层同步写回——陈旧选择不在下次启动复活
 *   - 「全部」恢复入口：点回「全部」页签 +「全部项目」即写回默认档，刷新后
 *     保持默认态
 * 通知经 POST /api/notifications 播种（projectId 直传，下拉候选即从条目聚合）；
 * 用例开头先 API 清空、结束后再清空，不残留测试数据。过滤选择落 localStorage，
 * Playwright 每用例独立 context 天然隔离，无跨用例串扰。
 */

const PROJ_A = 'e2e-persist-alpha'
const PROJ_B = 'e2e-persist-beta'
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

async function seed(headers: Record<string, string>, notes: Array<{ title: string; projectId?: string; projectName?: string; category?: string }>) {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'success',
        category: n.category ?? 'task',
        title: n.title,
        body: '',
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

test('选「项目 A × error」刷新重开后选择恢复，两维过滤同时生效', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-持久化-甲A-err', projectId: PROJ_A, projectName: 'alpha项目', category: 'error' },
    { title: 'e2e-持久化-乙A-err', projectId: PROJ_A, projectName: 'alpha项目', category: 'error' },
    { title: 'e2e-持久化-丙A-task', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-持久化-丁B-task', projectId: PROJ_B, projectName: 'beta项目' },
  ])

  await openPanel(page)

  // 选项目 A + error 页签：仅 A 的 error 两条（A 的 task 与 B 的都被过滤）
  await page.locator('.nc-project-select').selectOption(PROJ_A)
  await page.locator('.nc-filter-btn').filter({ hasText: '错误' }).click()
  await expect(row(page, 'e2e-持久化-甲A-err')).toHaveCount(1)
  await expect(row(page, 'e2e-持久化-乙A-err')).toHaveCount(1)
  await expect(row(page, 'e2e-持久化-丙A-task')).toHaveCount(0)
  await expect(row(page, 'e2e-持久化-丁B-task')).toHaveCount(0)

  // 整页刷新重开：组合恢复（页签激活态 + 下拉值 + 行过滤三面对齐）
  await openPanel(page)
  await expect(page.locator('.nc-project-select')).toHaveValue(PROJ_A)
  await expect(page.locator('.nc-filter-btn.active')).toHaveText(/错误/)
  await expect(row(page, 'e2e-持久化-甲A-err')).toHaveCount(1)
  await expect(row(page, 'e2e-持久化-乙A-err')).toHaveCount(1)
  await expect(row(page, 'e2e-持久化-丙A-task')).toHaveCount(0)
  await expect(row(page, 'e2e-持久化-丁B-task')).toHaveCount(0)
})

test('失效项目选择回落「全部项目」，持久层写回不复活陈旧选择', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-回落-甲A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-回落-丙B', projectId: PROJ_B, projectName: 'beta项目' },
  ])

  await openPanel(page)
  await page.locator('.nc-project-select').selectOption(PROJ_A)
  await expect(row(page, 'e2e-回落-甲A')).toHaveCount(1)

  // 刷新确认选择已持久化（本用例的回落前提）
  await openPanel(page)
  await expect(page.locator('.nc-project-select')).toHaveValue(PROJ_A)

  // A 的通知全部移除（候选清单从条目聚合 → A 从下拉消失）
  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const items = ((await listRes.json()) as { data?: Array<{ id: string; projectId?: string }> }).data || []
  const gone = items.filter(n => n.projectId === PROJ_A).map(n => n.id)
  expect(gone.length).toBeGreaterThan(0)
  const dismissRes = await fetch(`${API_BASE}/api/notifications/dismiss-batch`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ids: gone }),
  })
  expect(dismissRes.ok).toBeTruthy()

  // 刷新重开：A 不在候选 → 自动回落「全部项目」，列表不困死为空（B 可见）
  await openPanel(page)
  const select = page.locator('.nc-project-select')
  await expect(select).toBeVisible({ timeout: 3000 })
  await expect(select).toHaveValue('')
  await expect(row(page, 'e2e-回落-丙B')).toHaveCount(1)
  // 回落态同步写回持久层：localStorage 中 project 已清空（载荷含 P-20261003-187
  // 增的 runtime 键，本组用例未涉 runtime 维恒为默认空串）
  const stored = await page.evaluate((k) => localStorage.getItem(k), FILTER_STORAGE_KEY)
  expect(stored).toBe(JSON.stringify({ filter: 'all', project: '', runtime: '' }))
})

test('「全部」恢复入口：点回全部页签/全部项目即写回默认档', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-恢复入口-甲A', projectId: PROJ_A, projectName: 'alpha项目', category: 'error' },
    { title: 'e2e-恢复入口-丙B', projectId: PROJ_B, projectName: 'beta项目' },
  ])

  await openPanel(page)

  // 先进入过滤态，再走「全部」页签 +「全部项目」恢复默认
  await page.locator('.nc-project-select').selectOption(PROJ_A)
  await page.locator('.nc-filter-btn').filter({ hasText: '错误' }).click()
  await expect(row(page, 'e2e-恢复入口-丙B')).toHaveCount(0)
  await page.locator('.nc-filter-btn').filter({ hasText: '全部' }).click()
  await page.locator('.nc-project-select').selectOption('')
  await expect(row(page, 'e2e-恢复入口-甲A')).toHaveCount(1)
  await expect(row(page, 'e2e-恢复入口-丙B')).toHaveCount(1)

  // 刷新后保持默认态：无激活过滤（全部页签 + 空下拉值）
  await openPanel(page)
  await expect(page.locator('.nc-filter-btn.active')).toHaveText(/全部/)
  await expect(page.locator('.nc-project-select')).toHaveValue('')
  await expect(row(page, 'e2e-恢复入口-甲A')).toHaveCount(1)
  await expect(row(page, 'e2e-恢复入口-丙B')).toHaveCount(1)
  const stored = await page.evaluate((k) => localStorage.getItem(k), FILTER_STORAGE_KEY)
  expect(stored).toBe(JSON.stringify({ filter: 'all', project: '', runtime: '' }))
})
