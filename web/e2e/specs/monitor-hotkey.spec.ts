import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 值班大屏入口与键盘补全（P-20261002-80）E2E：
 *   - 命令面板「值班」命令 → 直达 /monitor（面板之外的独立路由获得统一入口）
 *   - 大屏按 R → refreshAll 触发（更新时间文本跨秒变化）
 *   - 焦点在提问输入框内按 R → 仅输入字符、不触发刷新（closest 跳过先例）
 * 提问播种用 API（无 options = 自由文本形态出输入框，配方同 ops-ask.spec）；
 * afterEach 作答清账防残留（pending 提问会污染大屏空态断言的后续用例）
 */

const BASE = API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 提问（作答清账，卡片即消失） */
async function cleanupAsks(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-ask`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-ask/${a.id}/answer`, {
      headers, data: { answer: 'cleanup' },
    })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupAsks(request)
})

test.afterEach(async ({ request }) => {
  await cleanupAsks(request)
})

/** 更新时间文本（秒级 HH:MM:SS）：按下 R 前 blur，防解锁流程残留焦点落在按钮上被跳过 */
async function updatedText(page: import('@playwright/test').Page): Promise<string> {
  return (await page.locator('.mon-updated').textContent()) || ''
}

test('命令面板「值班」命令直达 /monitor', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // Ctrl+K → 命令模式 → 输「值班」→ 回车直达独立路由（配方同 palette-commands.spec）
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>值班')
  const item = page.locator('.palette-item').filter({ hasText: '值班大屏' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Enter')
  await page.waitForURL('**/monitor')
  await expect(page.locator('.mon-root')).toBeVisible()
  await expect(page.locator('.mon-head-text')).toContainText('值班大屏')
})

test('大屏按 R 触发刷新（更新时间变化）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  // 挂载补账完成后更新时间出现
  const updated = page.locator('.mon-updated')
  await expect(updated).toBeVisible({ timeout: 10000 })
  const before = await updatedText(page)

  // 秒级时间戳：跨秒后按键，变化才可断言
  await page.waitForTimeout(1200)
  // 解锁流程可能把焦点留在按钮上（closest 跳过先例）——回归 body 再按 R
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
  await page.keyboard.press('r')
  await expect(updated).not.toHaveText(before, { timeout: 5000 })
})

test('提问输入框内按 R 仅输入不触发刷新', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  // 无 options = 自由文本形态：提问卡内出现输入框
  const seeded = await request.post(`${BASE}/api/ops-ask`, {
    headers,
    data: { question: 'monitor-hotkey e2e：缺环境变量，请输入（按 R 应只输入不刷新）' },
  })
  expect(seeded.ok()).toBeTruthy()

  const card = page.locator('.mon-card.is-ask')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const updated = page.locator('.mon-updated')
  await expect(updated).toBeVisible({ timeout: 10000 })
  const before = await updatedText(page)

  // 焦点在输入框内按 R：字符进输入框，refreshAll 不触发（更新时间保持不变）
  await card.locator('input').click()
  await page.keyboard.press('r')
  await expect(card.locator('input')).toHaveValue('r')
  await page.waitForTimeout(1500)
  await expect(updated).toHaveText(before)
})
