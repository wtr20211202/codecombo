import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, createAgentSession, projectCardByName } from './helpers'

/**
 * 管理页多选批操作 E2E（打磨轮9）：Ctrl+点选系统会话 → 批操作栏 →
 * 批量移到分组 / 批量结束会话（一次确认）。
 *
 * 分组名带唯一前缀并在用例前后清理（ui-state 'local' 实例全局共享）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const GROUP = `batch-e2e-${Math.random().toString(36).slice(2, 7)}-组`

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanup(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  for (const s of list) {
    if (s.kind === 'agent') await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
  const state = await request.get(`${BASE}/api/ui-state`, { headers })
  const all = ((await state.json()) as {
    data?: Record<string, { agentTerminal?: { groups?: { id: string; name: string }[] } }>
  }).data || {}
  const local = all.local
  if (local?.agentTerminal?.groups?.some(g => g.name.startsWith('batch-e2e-'))) {
    local.agentTerminal.groups = local.agentTerminal.groups.filter(g => !g.name.startsWith('batch-e2e-'))
    await request.put(`${BASE}/api/ui-state`, { headers, data: all })
  }
}

test.describe('管理页多选批操作（打磨轮9）', () => {
  let view: ReturnType<Page['locator']>

  test.beforeEach(async ({ page, request }) => {
    await cleanup(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    for (let i = 0; i < 3; i++) {
      await createAgentSession(page, view)
      await expect(view.locator('.ats-item')).toHaveCount(i + 1, { timeout: 10000 })
    }
  })

  test.afterEach(async ({ request }) => {
    await cleanup(request)
  })

  test('Ctrl+点选多选 → 批量移到分组 → 批量结束（一次确认）', async ({ page }) => {
    const rootSection = view.locator('.ats-section', { hasText: '未分组' })

    // 建一个目标组
    await view.getByRole('button', { name: '新建分组' }).click()
    const groupInput = view.locator('.ats-footer input')
    await groupInput.fill(GROUP)
    await groupInput.press('Enter')
    const groupSection = view.locator('.ats-section', { hasText: GROUP })
    await expect(groupSection).toBeVisible()

    // Ctrl+点选 终端 1 / 终端 2 → 批操作栏出现（2 项）
    await rootSection.locator('.ats-item', { hasText: '终端 1' }).click({ modifiers: ['Control'] })
    await rootSection.locator('.ats-item', { hasText: '终端 2' }).click({ modifiers: ['Control'] })
    const batchBar = view.locator('.ats-batch')
    await expect(batchBar).toBeVisible()
    await expect(batchBar.locator('.ats-batch-count')).toHaveText('已选 2 项')

    // 批量移到 GROUP
    await batchBar.locator('.ats-batch-btn', { hasText: '移动到' }).click()
    await page.locator('.n-dropdown-option', { hasText: GROUP }).click()
    await expect(batchBar).toBeHidden()
    await expect(groupSection.locator('.ats-item-title')).toHaveText(['终端 1', '终端 2'])

    // 再多选组内两项 → 批量结束 → 确认弹窗 → 全部消失
    await groupSection.locator('.ats-item', { hasText: '终端 1' }).click({ modifiers: ['Control'] })
    await groupSection.locator('.ats-item', { hasText: '终端 2' }).click({ modifiers: ['Control'] })
    await expect(batchBar).toBeVisible()
    await batchBar.locator('.ats-batch-btn.is-danger').click()
    await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
    await expect(groupSection.locator('.ats-item')).toHaveCount(0, { timeout: 10000 })
    await expect(view.locator('.ats-item', { hasText: '终端 3' })).toBeVisible()
  })
})
