import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, createAgentSession, projectCardByName } from './helpers'

/**
 * 管理页侧栏即时筛选 E2E（打磨轮2）：输入即过滤会话列表，清空恢复。
 * Claude 列表的搜索（服务端 q 参数）由 ClaudeSessionPicker 自带，不在本用例范围。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清场：agent 会话 + 项目会话全删，并轮询等待列表归零。
 *  DELETE 是异步杀进程（列表移除有延迟），不等待会把幽灵会话泄入本 spec
 *  的侧栏计数（.ats-item 按「全部会话」渲染）——全量串行下必现 */
async function cleanupSessions(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; kind?: string; projectId?: string }[] }).data || []
    const stale = list.filter(s => s.kind === 'agent' || !!s.projectId)
    if (stale.length === 0) return
    for (const s of stale) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
    await new Promise(r => setTimeout(r, 600))
  }
}

test.describe('管理页侧栏即时筛选（打磨轮2）', () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupSessions(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupSessions(request)
  })

  test('输入过滤 → 无匹配提示 → 清空恢复', async ({ page }) => {
    const view = page.locator('.atv-root')
    const filter = view.locator('.ats-filter input')
    const names = () => view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item-title')

    // 命中其一
    await filter.fill('终端 1')
    await expect(names()).toHaveText(['终端 1'])

    // 项目名/任意子串大小写不敏感
    await filter.fill('终端')
    await expect(names()).toHaveText(['终端 1', '终端 2'])

    // 无匹配提示
    await filter.fill('zzz-不存在')
    await expect(view.locator('.ats-no-match')).toBeVisible()

    // 清空恢复（clearable 按钮 + 直接清空两种路径取直接清空）
    await filter.fill('')
    await expect(names()).toHaveText(['终端 1', '终端 2'])
    await expect(view.locator('.ats-no-match')).toHaveCount(0)
  })
})
