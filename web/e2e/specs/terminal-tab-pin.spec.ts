import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端会话 tab 置顶 E2E（P-20261004-53）：编辑器 pinned tab 向会话侧的对称补位。
 * 置顶是纯前端显示偏好（terminal-sessions store pinnedIds，safeStorage 持久化），
 * 置顶分组 = 显示序投影（置顶稳定 partition 到队首，物理 tab 序不动）。
 *   1. UI 链路：tab 右键「置顶」→ 置顶 tab 移到队首（置顶分组）+ 粗体/图钉态
 *      + 重开菜单文案翻转「取消置顶」→ 取消后回原相对位、置顶视觉消失
 *   2. 持久化：置顶后刷新页面置顶分组保持（恢复读侧），取消置顶再刷新不复活
 *      （取消写侧同样落盘）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 打开项目并归一化底部终端面板可见（面板开合是 uiState 持久态，随跑序而异） */
async function openProjectTerminal(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 5000 })
}

/** 新建 n 个终端 tab（既有 tab 之上追加），返回创建后的 tab 名列表 */
async function createTerminals(page: Page, n: number): Promise<string[]> {
  const before = await page.locator('.term-tab').count()
  const newBtn = page.locator('.term-toolbar').getByRole('button', { name: '新建终端' })
  for (let i = 0; i < n; i++) {
    await newBtn.click()
    await expect(page.locator('.term-tab')).toHaveCount(before + i + 1, { timeout: 15_000 })
  }
  const names: string[] = []
  const count = await page.locator('.term-tab').count()
  for (let i = before; i < count; i++) {
    names.push((await page.locator('.term-tab').nth(i).locator('.term-tab-name').innerText()).trim())
  }
  return names
}

test('tab 右键置顶 → 置顶分组队首 + 粗体/图钉 + 菜单翻转 → 取消置顶恢复原相对位', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场基线：记录创建前会话 id，finally 只删本用例新建的（不碰存量）
  const list0 = await page.request.get(`${BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))

  await openProjectTerminal(page)
  const created = await createTerminals(page, 2)
  expect(created.length).toBe(2)
  const target = created[1]! // 最后创建的 tab（默认在队尾）

  try {
    // 右键队尾 tab → 「置顶」→ 移到队首（置顶分组）+ is-pinned/图钉/粗体
    await page.locator('.term-tab').last().click({ button: 'right' })
    const pinItem = page.locator('[data-testid="terminal-pin-tab"]')
    await expect(pinItem).toBeVisible({ timeout: 5000 })
    await expect(pinItem).toHaveText('置顶')
    await pinItem.click()

    const firstTab = page.locator('.term-tab').first()
    await expect(firstTab.locator('.term-tab-name')).toHaveText(target, { timeout: 5000 })
    await expect(page.locator('.term-tab.is-pinned')).toHaveCount(1)
    await expect(firstTab).toHaveClass(/is-pinned/)
    await expect(firstTab.locator('[data-testid="term-tab-pin"]')).toBeVisible()
    await expect(firstTab.locator('.term-tab-name')).toHaveCSS('font-weight', '600')

    // 重开菜单文案翻转（store 即时回写）：「取消置顶」
    await firstTab.click({ button: 'right' })
    await expect(page.locator('[data-testid="terminal-pin-tab"]')).toHaveText('取消置顶', { timeout: 5000 })

    // 取消置顶：回原相对位（队尾），置顶视觉消失
    await page.locator('[data-testid="terminal-pin-tab"]').click()
    await expect(page.locator('.term-tab.is-pinned')).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.term-tab').last().locator('.term-tab-name')).toHaveText(target)
    await expect(page.locator('[data-testid="term-tab-pin"]')).toHaveCount(0)
  } finally {
    const list1 = await page.request.get(`${BASE}/api/terminals`, { headers })
    for (const s of ((await list1.json()) as { data?: { id: string }[] }).data || []) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

test('置顶持久化：刷新后置顶分组保持；取消置顶刷新后不复活', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  const list0 = await page.request.get(`${BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))

  await openProjectTerminal(page)
  const created = await createTerminals(page, 1)
  expect(created.length).toBe(1)
  const target = created[0]!

  try {
    // 置顶后刷新：safeStorage 恢复 + 显示序投影 → 仍是置顶队首
    await page.locator('.term-tab').last().click({ button: 'right' })
    await page.locator('[data-testid="terminal-pin-tab"]').click()
    await expect(page.locator('.term-tab.is-pinned')).toHaveCount(1)

    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await expect(page.locator('.term-tab.is-pinned .term-tab-name')).toHaveText(target, { timeout: 15_000 })
    await expect(page.locator('.term-tab').first()).toHaveClass(/is-pinned/)

    // 取消置顶写侧同样落盘：刷新后不复活
    await page.locator('.term-tab.is-pinned').click({ button: 'right' })
    await page.locator('[data-testid="terminal-pin-tab"]').click()
    await expect(page.locator('.term-tab.is-pinned')).toHaveCount(0, { timeout: 5000 })

    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await expect(page.locator('.term-tab.is-pinned')).toHaveCount(0, { timeout: 15_000 })
  } finally {
    const list1 = await page.request.get(`${BASE}/api/terminals`, { headers })
    for (const s of ((await list1.json()) as { data?: { id: string }[] }).data || []) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})
