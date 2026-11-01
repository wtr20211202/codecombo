import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 独占挂接 E2E（P2 管理页接管渲染 + P3 底部挂起/取回）
 *
 * 前置：simple-coding 已运行（含 P1 广播 + 挂接表）。
 *
 * 核心契约：同一会话任意时刻只有一个渲染现场——
 *   1. 管理页点击项目会话 = 接管：管理页渲染 xterm，底部面板同会话转挂起占位（不双渲染）
 *   2. 底部点击挂起 tab / 占位卡 = 取回：渲染权回底部，管理页释放
 *   3. 管理页收起/关闭 = 全量自动归还
 *   4. 「打开项目」= 归还 + 切项目视图 + 底部终端 tab 激活 + 管理页收起
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

/** 打开底部终端面板并新建一个 tab（返回实际 tab 名，供侧栏匹配） */
async function createBottomTerminal(page: Page): Promise<string> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: '新建终端' }).first().click()
  await page.locator('.term-container .xterm').locator('visible=true').first()
    .waitFor({ state: 'visible', timeout: 10000 })
  return (await page.locator('.term-tab-name').last().textContent()) || ''
}

test.describe('独占挂接：接管/挂起/取回（P2+P3）', () => {
  let projectId = ''
  let tabName = ''

  test.beforeEach(async ({ page, request }) => {
    projectId = await getProjectId(request)
    await cleanupProjectTerminals(request, projectId)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    tabName = await createBottomTerminal(page)
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
  })

  test('接管 → 底部挂起不双渲染 → 取回还原', async ({ page }) => {
    // 打开管理页，侧栏项目组出现刚建的会话
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    const projectItem = view.locator('.ats-item', { hasText: tabName })
    await expect(projectItem).toHaveCount(1, { timeout: 10000 })

    // ---- 接管：管理页渲染 xterm ----
    await projectItem.click()
    await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
    // 侧栏出现「管理页」徽标
    await expect(projectItem.locator('.ats-item-badge')).toBeVisible()

    // ---- 底部同会话挂起：占位卡出现，且不存在第二个 xterm（独占渲染） ----
    await expect(page.locator('.term-pane-suspended')).toBeVisible({ timeout: 10000 })
    // 底部面板区域没有任何 xterm（唯一会话已被接管）
    await expect(page.locator('.term-tab-content .xterm')).toHaveCount(0)
    // 底部 tab 挂起态样式
    await expect(page.locator('.term-tab.is-suspended')).toHaveCount(1)

    // ---- 取回：点击挂起 tab → 渲染权回底部，管理页释放 ----
    await page.locator('.term-tab.is-suspended').click()
    await expect(page.locator('.term-container .xterm').locator('visible=true').first())
      .toBeVisible({ timeout: 15000 })
    await expect(page.locator('.term-tab.is-suspended')).toHaveCount(0)
    await expect(page.locator('.term-pane-suspended')).toHaveCount(0)
    // 管理页不再渲染该会话（系统会话 pane 会保活隐藏，故只断言无「可见」xterm）
    await expect(view.locator('.xterm').locator('visible=true')).toHaveCount(0)
  })

  test('管理页收起为悬浮球 = 全量自动归还', async ({ page }) => {
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    const projectItem = view.locator('.ats-item', { hasText: tabName })
    await expect(projectItem).toHaveCount(1, { timeout: 10000 })

    // 接管 → 底部挂起
    await projectItem.click()
    await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
    await expect(page.locator('.term-pane-suspended')).toBeVisible({ timeout: 10000 })

    // 收起为悬浮球 → 自动归还：底部占位消失、xterm 回归（实测 ~3ms 内完成，
    // visible=true 过滤排除管理页保活 pane 的隐藏 xterm 干扰）
    await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
    await expect(page.locator('.term-container .xterm').locator('visible=true').first())
      .toBeVisible({ timeout: 15000 })
    // 收尾：关闭悬浮球
    await page.locator('.agm-root').click({ button: 'right' })
    // 球仍在即可（右键样式菜单可关）；直接 Esc 语义不存在，此处仅确认球存在
    await expect(page.locator('.agm-root')).toBeVisible()
  })

  test('「打开项目」= 归还 + 收起管理页 + 底部 tab 激活', async ({ page }) => {
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    const projectItem = view.locator('.ats-item', { hasText: tabName })
    await expect(projectItem).toHaveCount(1, { timeout: 10000 })

    // 接管后点组头「打开项目」
    await projectItem.click()
    await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
    await view.locator('.ats-open-project').first().click()

    // 管理页收起（docked 隐藏）+ 底部 xterm 回归可见
    await expect(view).toBeHidden({ timeout: 10000 })
    await expect(page.locator('.term-container .xterm').locator('visible=true').first())
      .toBeVisible({ timeout: 15000 })
    await expect(page.locator('.term-tab.is-suspended')).toHaveCount(0)
    // 仍在项目视图
    await expect(page).toHaveURL(/\/project/)
  })
})
