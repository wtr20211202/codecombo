import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知中心多选批量操作 E2E（P-20261003-281）：
 *   - checkbox 模式：头部开关进入/退出，批量条（全选当前列表三态框 + 已选计数 +
 *     批量已读/删除）仅模式内出现
 *   - 批量已读：选 3 条 → 一键已读（toast + 徽标清零 + 行保留 + 服务端落库）
 *   - 批量删除：选 2 条 → 确认弹窗（取消保留/确认移除）+ 服务端同步 + 失联 id 剪除
 *   - 与过滤正交：「错误」页签内全选 → 切「全部」选择保留（高亮跟随）→ 回页签
 *     批量删除只删选中集
 *   - Esc 分段退出：第一段退多选（选择清空），第二段才关面板
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，
 * 不残留测试数据）
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

async function seed(headers: Record<string, string>, notes: Array<{ title: string; type?: string; category?: string }>): Promise<void> {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ type: n.type ?? 'info', category: n.category ?? 'system', title: n.title, body: '' }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function clearAll(headers: Record<string, string>): Promise<void> {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

async function openPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

function rowOf(page: Page, title: string) {
  return page.locator('.nc-item:not(.nc-sub)').filter({ hasText: title })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await clearAll(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await clearAll(headers)
})

test('多选 3 条批量已读：行点击勾选 → toast + 徽标清零 + 行保留 + 服务端落库', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-ms-read-甲' },
    { title: 'e2e-ms-read-乙' },
    { title: 'e2e-ms-read-丙' },
  ])

  await openPanel(page)
  await expect(page.locator('.notify-badge')).toHaveText('3', { timeout: 3000 })
  // 常规模式无批量条；开关进入后出现
  await expect(page.locator('[data-testid="notif-batch-bar"]')).toHaveCount(0)
  await page.locator('[data-testid="notif-select-toggle"]').click()
  await expect(page.locator('[data-testid="notif-batch-bar"]')).toBeVisible()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 0 条')

  // 行点击 = 勾选（多选模式下激活语义让位批量选择）；选中行高亮
  for (const t of ['甲', '乙', '丙']) {
    await rowOf(page, `e2e-ms-read-${t}`).click()
  }
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 3 条')
  await expect(page.locator('.nc-item.is-selected')).toHaveCount(3)

  await page.locator('[data-testid="notif-batch-read"]').click()
  await expect(page.locator('.n-message')).toHaveText('已标记 3 条为已读')
  await expect(page.locator('.notify-badge')).toHaveCount(0)
  for (const t of ['甲', '丙']) {
    const row = rowOf(page, `e2e-ms-read-${t}`)
    await expect(row).toBeVisible()
    await expect(row).not.toHaveClass(/unread/)
  }

  // 服务端同步：readOne 逐条落库（非仅前端本地置位）
  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await listRes.json()) as { data?: Array<{ title?: string; read?: boolean }> }).data || []
  expect(list.length).toBe(3)
  expect(list.every(n => n.read)).toBe(true)
})

test('勾选框选 2 条批量删除：确认弹窗取消保留/确认移除 + 失联 id 剪除 + 服务端同步', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-ms-del-甲' },
    { title: 'e2e-ms-del-乙' },
    { title: 'e2e-ms-del-丙' },
  ])

  await openPanel(page)
  await expect(rowOf(page, 'e2e-ms-del-甲')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="notif-select-toggle"]').click()

  // 行首勾选框路径（@click.stop 防行点击二次切换）
  await rowOf(page, 'e2e-ms-del-甲').locator('.nc-check').click()
  await rowOf(page, 'e2e-ms-del-乙').locator('.nc-check').click()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 2 条')

  // 破坏性动作先确认：取消 → 保留
  await page.locator('[data-testid="notif-batch-remove"]').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('删除选中的 2 条通知')
  await dialog.getByRole('button', { name: '取消' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(3)
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 2 条')

  // 确认 → 两条移除，计数随失联 id 剪除归零
  await page.locator('[data-testid="notif-batch-remove"]').click()
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.n-message')).toHaveText('已删除 2 条通知')
  await expect(rowOf(page, 'e2e-ms-del-甲')).toHaveCount(0)
  await expect(rowOf(page, 'e2e-ms-del-乙')).toHaveCount(0)
  await expect(rowOf(page, 'e2e-ms-del-丙')).toBeVisible()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 0 条')

  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await listRes.json()) as { data?: Array<{ title?: string }> }).data || []
  expect(list.map(n => n.title)).toEqual(['e2e-ms-del-丙'])
})

test('过滤视图内多选与正交性：错误页签全选 → 全部页签选择保留 → 回页签批量删除只删选中集', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [
    { title: 'e2e-ms-f-err-1', type: 'error', category: 'error' },
    { title: 'e2e-ms-f-err-2', type: 'error', category: 'error' },
    { title: 'e2e-ms-f-sys-1', category: 'system' },
    { title: 'e2e-ms-f-sys-2', category: 'system' },
  ])

  await openPanel(page)
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(4, { timeout: 3000 })

  // 过滤到「错误」页签（2 条）
  await page.locator('.nc-filter-btn').filter({ hasText: '错误' }).click()
  await expect(page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-ms-f-err' })).toHaveCount(2)
  await expect(page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-ms-f-sys' })).toHaveCount(0)

  await page.locator('[data-testid="notif-select-toggle"]').click()
  // 全选当前列表：只勾视图内 2 条，不越过滤扩大
  await page.locator('[data-testid="notif-batch-select-all"]').click()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 2 条')

  // 与过滤正交：切回「全部」，选择保留、高亮跟随（error 选中、system 未选）
  await page.locator('.nc-filter-btn').filter({ hasText: '全部' }).first().click()
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(4)
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 2 条')
  await expect(rowOf(page, 'e2e-ms-f-err-1')).toHaveClass(/is-selected/, { timeout: 3000 })
  await expect(rowOf(page, 'e2e-ms-f-err-2')).toHaveClass(/is-selected/)
  await expect(rowOf(page, 'e2e-ms-f-sys-1')).not.toHaveClass(/is-selected/)
  await expect(rowOf(page, 'e2e-ms-f-sys-2')).not.toHaveClass(/is-selected/)

  // 回「错误」页签批量删除：只删选中集
  await page.locator('.nc-filter-btn').filter({ hasText: '错误' }).click()
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(2)
  await page.locator('[data-testid="notif-batch-remove"]').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.nc-empty')).toBeVisible({ timeout: 3000 })

  // 全部页签下 system 两条不受影响；服务端只余 system
  await page.locator('.nc-filter-btn').filter({ hasText: '全部' }).first().click()
  await expect(page.locator('.nc-item:not(.nc-sub)').filter({ hasText: 'e2e-ms-f-sys' })).toHaveCount(2)
  const listRes = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await listRes.json()) as { data?: Array<{ title?: string }> }).data || []
  expect(list.map(n => n.title).sort()).toEqual(['e2e-ms-f-sys-1', 'e2e-ms-f-sys-2'])
})

test('Esc 分段退出：第一段退多选并清空选择（面板保留），第二段才关面板', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await seed(headers, [{ title: 'e2e-ms-esc-1' }, { title: 'e2e-ms-esc-2' }])

  await openPanel(page)
  await expect(rowOf(page, 'e2e-ms-esc-1')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="notif-select-toggle"]').click()
  await rowOf(page, 'e2e-ms-esc-1').click()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 1 条')

  // 第一段 Esc：退多选（批量条消失），面板仍在
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="notif-batch-bar"]')).toHaveCount(0)
  await expect(page.locator('.nc-card')).toBeVisible()

  // 再进多选：从空选择起步（选择不跨模式残留）
  await page.locator('[data-testid="notif-select-toggle"]').click()
  await expect(page.locator('[data-testid="notif-batch-count"]')).toHaveText('已选 0 条')

  // 多选态下 Esc 仍先退多选（分段语义不跳步：两段各自消费一次 Esc），
  // 第二段才轮到关面板
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="notif-batch-bar"]')).toHaveCount(0)
  await expect(page.locator('.nc-card')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.nc-card')).toBeHidden({ timeout: 3000 })
})
