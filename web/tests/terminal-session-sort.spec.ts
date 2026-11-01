import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, createAgentSession, projectCardByName } from './helpers'

/**
 * 终端会话排序 E2E（打磨轮1）：管理页侧栏排序控制
 * —— 名称排序改变侧栏列表渲染序；default 恢复创建序。
 * 活动时间戳排序的纯逻辑由 store 单测覆盖（e2e 难以确定性制造 OSC 时序）。
 *
 * 前置：simple-coding 已运行。
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

test.describe('终端会话排序（打磨轮1）', () => {
  test.beforeEach(async ({ page, request }) => {
    await cleanupSessions(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    // 管理页入口（活动栏 rail 按钮）在项目视图。
    // 每个用例自带打开步骤：管理页展开态可能被上一个 spec 留在收起态，
    // 依赖前一个用例打开 = 顺序耦合（重命名用例曾因此随机挂）
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    const view = page.locator('.atv-root')
    if (!(await view.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端会话管理"]').click()
    }
    await expect(view).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupSessions(request)
  })

  test('侧栏排序：名称序 ↔ 创建序切换', async ({ page }) => {
    // 管理页已在 beforeEach 打开；创建两个会话：创建序 = 终端 1, 终端 2
    const view = page.locator('.atv-root')
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })

    const names = () => view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item-title')
    await expect(names()).toHaveText(['终端 1', '终端 2'], { timeout: 10000 })

    // 重命名「终端 2」→「1 会话」：名称序与创建序分离。
    // 命名用数字开头：ICU zh collation 把 Han 排在拉丁字母前（Chrome 148 实测
    // '终端 1'.localeCompare('A 会话') < 0），拉丁字母命名的期望序会随 collator
    // locale 翻转；数字在所有 collation 下都排最前，断言与 collator 环境解耦
    await view.locator('.ats-item', { hasText: '终端 2' }).click({ button: 'right' })
    await page.locator('.n-dropdown-option', { hasText: '重命名' }).click()
    const dialog = page.locator('.n-dialog')
    await dialog.locator('input').fill('1 会话')
    await dialog.getByRole('button', { name: '确认' }).click()
    await expect(view.locator('.ats-item', { hasText: '1 会话' })).toHaveCount(1, { timeout: 10000 })

    // default：创建序（1 会话 在后）
    await expect(names()).toHaveText(['终端 1', '1 会话'], { timeout: 10000 })

    // 按名称：1 会话 提到最前
    await view.locator('.ats-sort').click()
    await page.locator('.n-dropdown-option', { hasText: '按名称' }).click()
    await expect(names()).toHaveText(['1 会话', '终端 1'], { timeout: 10000 })

    // 回默认：创建序还原
    await view.locator('.ats-sort').click()
    await page.locator('.n-dropdown-option', { hasText: '默认排序' }).click()
    await expect(names()).toHaveText(['终端 1', '1 会话'])
  })

  test('双击会话内联重命名（打磨轮7）', async ({ page }) => {
    const view = page.locator('.atv-root')
    const names = () => view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item-title')
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })

    // 双击未分组的系统会话 → 内联输入框出现。
    // 用「第一个 item」定位而非 hasText：进入重命名态后标题被输入框替换，
    // 文本定位器会失效（原写法曾因此找不到 input 而误判功能坏了）
    const item = view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item').first()
    await item.dblclick()
    const inline = item.locator('input')
    await expect(inline).toBeVisible()
    await inline.fill('改名会话')
    await inline.press('Enter')

    // 输入框消失、新名生效；其余会话不受影响
    await expect(item.locator('input')).toHaveCount(0)
    await expect(names()).toHaveText(['改名会话', '终端 2'], { timeout: 10000 })
  })
})
