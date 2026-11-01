import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心项目维过滤 E2E（P-20261002-57）：
 *   - 两项目各发通知 → 项目下拉选项目 A → 仅 A 的通知显示 → 切全部项目恢复
 *   - 正交性：项目过滤与分类页签（未读）叠加生效
 *   - 项目维生效时清空按钮只清当前筛选结果（项目子集），不动其它项目
 * 通知经 POST /api/notifications 播种（projectId/projectName 直传，下拉候选
 * 即从条目聚合）；先清空、结束后再清空，不残留测试数据。
 */

const PROJ_A = 'e2e-proj-alpha'
const PROJ_B = 'e2e-proj-beta'

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

interface SeedNote {
  title: string
  projectId?: string
  projectName?: string
  category?: string
}

async function seed(headers: Record<string, string>, notes: SeedNote[]) {
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

test.beforeAll(async () => {
  await clearAll(await unlockHeaders())
})

test.afterAll(async () => {
  await clearAll(await unlockHeaders())
})

test('两项目各发通知，选项目 A 仅显示 A，切全部项目恢复', async ({ page }) => {
  const headers = await unlockHeaders()
  // 用例开头先清空再播种：前序用例遗留通知会混进列表影响计数
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-项目过滤-甲A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-项目过滤-乙A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-项目过滤-丙B', projectId: PROJ_B, projectName: 'beta项目' },
    // 无 projectId 的系统级通知：不归属任何项目，仅「全部项目」下可见
    { title: 'e2e-项目过滤-丁系统', category: 'system' },
  ])

  await openPanel(page)

  // 下拉候选从条目聚合：全部项目 + 两个项目（无项目条目不产生候选）
  const select = page.locator('.nc-project-select')
  await expect(select).toBeVisible({ timeout: 3000 })
  await expect(select.locator('option')).toHaveText([
    '全部项目',
    'alpha项目',
    'beta项目',
  ])

  const row = (text: string) => page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
  await expect(row('e2e-项目过滤-甲A')).toHaveCount(1)
  await expect(row('e2e-项目过滤-丙B')).toHaveCount(1)

  // 选项目 A：仅 A 的两条显示，B 与系统条目被过滤
  await select.selectOption(PROJ_A)
  await expect(row('e2e-项目过滤-甲A')).toHaveCount(1)
  await expect(row('e2e-项目过滤-乙A')).toHaveCount(1)
  await expect(row('e2e-项目过滤-丙B')).toHaveCount(0)
  await expect(row('e2e-项目过滤-丁系统')).toHaveCount(0)

  // 切回全部项目：全量恢复
  await select.selectOption('')
  await expect(row('e2e-项目过滤-甲A')).toHaveCount(1)
  await expect(row('e2e-项目过滤-丙B')).toHaveCount(1)
  await expect(row('e2e-项目过滤-丁系统')).toHaveCount(1)
})

test('正交叠加：项目 B × 未读页签', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-正交-甲A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-正交-乙B', projectId: PROJ_B, projectName: 'beta项目' },
  ])

  await openPanel(page)

  // 选项目 B 再点未读页签：B 的未读仍在，A 的被项目维过滤
  const select = page.locator('.nc-project-select')
  await select.selectOption(PROJ_B)
  await page.locator('.nc-filter-btn').filter({ hasText: '未读' }).click()
  const row = (text: string) => page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
  await expect(row('e2e-正交-乙B')).toHaveCount(1)
  await expect(row('e2e-正交-甲A')).toHaveCount(0)
})

test('项目维生效时清空只清当前项目，其它项目保留', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-清空项目-甲A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-清空项目-乙A', projectId: PROJ_A, projectName: 'alpha项目' },
    { title: 'e2e-清空项目-丙B', projectId: PROJ_B, projectName: 'beta项目' },
  ])

  await openPanel(page)

  await page.locator('.nc-project-select').selectOption(PROJ_A)
  await page.locator('.nc-action-btn.danger').click()

  // 确认弹窗计数为项目子集（2 条而非 3 条），标题为「清空当前筛选」
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('清空当前筛选（2 条）')
  await dialog.getByRole('button', { name: '确认' }).click()

  const row = (text: string) => page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
  await expect(row('e2e-清空项目-甲A')).toHaveCount(0)
  await expect(row('e2e-清空项目-乙A')).toHaveCount(0)
  // B 项目通知不受影响；下拉候选随 A 的条目消失自动回落「全部项目」
  await expect(row('e2e-清空项目-丙B')).toHaveCount(1)
  await expect(page.locator('.nc-project-select')).toHaveValue('')
})
