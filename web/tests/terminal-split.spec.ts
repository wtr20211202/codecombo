import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 终端分屏 E2E（覆盖度补充）：split 布局结构 / 方向切换 / 取消拆分语义。
 *
 * 此前分屏功能（useTerminalSplit + TerminalPanesArea 布局）无任何 e2e 覆盖；
 * 断言聚焦 DOM 结构（pane 数量 / 方向 class / divider），确定性强。
 *
 * 语义参照 useTerminalTabs：
 *   - split 已存在 + 同方向 = 取消拆分（收 secondary 回单 pane）
 *   - × 按钮（requestCloseTab）在 split 态 = 收 secondary，不动 primary
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
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

async function openTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
}

async function closeAllTerminalTabs(page: Page) {
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

/** 打开 split 下拉并选方向 */
async function pickSplit(page: Page, direction: 'horizontal' | 'vertical') {
  await page.locator('.term-toolbar .term-tool-btn[title="水平拆分"]').click()
  const label = direction === 'horizontal' ? '水平拆分' : '垂直拆分'
  await page.locator('.n-dropdown:visible').getByText(label, { exact: true }).click()
}

/**
 * 活跃 tab 的布局根：TerminalPanesArea 对全部已知会话（含他项目/后台 tab）
 * 都渲染 `.term-pane-layout`（v-show 隐藏非活跃），全局会话表有残留会话时
 * 裸定位会 strict violation——断言锚定可见（=活跃）tab 的布局根。
 */
function activeLayout(page: Page) {
  return page.locator('.term-tab-content:visible .term-pane-layout')
}

test.describe('终端分屏（覆盖度补充）', () => {
  let projectId = ''

  test.beforeEach(async ({ page, request }) => {
    projectId = await getSimpleCodingProjectId(request)
    await cleanupProjectTerminals(request, projectId)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')
    await openTerminalPanel(page)
    await closeAllTerminalTabs(page)
    await expect(page.locator('.term-tab')).toHaveCount(0, { timeout: 5000 })

    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
    // xterm 断言取 last（CLAUDE.md「测试」节）：多 tab 时旧屏 DOM 序在前，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content .xterm').last()).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
  })

  test('水平拆分：双 pane + divider，会话数 1→2', async ({ page }) => {
    await pickSplit(page, 'horizontal')
    const layout = activeLayout(page)
    await expect(layout).toHaveClass(/split/, { timeout: 8000 })
    await expect(layout).toHaveClass(/horizontal/)
    await expect(layout.locator('.term-pane')).toHaveCount(2)
    await expect(layout.locator('.term-split-divider-horizontal')).toHaveCount(1)
    // split 创建了一个新会话（secondary pane），但 tab 仍是一个
    await expect(page.locator('.term-tab')).toHaveCount(1)
  })

  test('垂直拆分：方向 class 正确', async ({ page }) => {
    await pickSplit(page, 'vertical')
    const layout = activeLayout(page)
    await expect(layout).toHaveClass(/split/, { timeout: 8000 })
    await expect(layout).toHaveClass(/vertical/)
    await expect(layout.locator('.term-pane')).toHaveCount(2)
    await expect(layout.locator('.term-split-divider-vertical')).toHaveCount(1)
  })

  test('× 按钮 split 态 = 取消拆分（回单 pane，tab 保留）', async ({ page }) => {
    await pickSplit(page, 'horizontal')
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2, { timeout: 8000 })

    // requestCloseTab 语义：split 态 × = 关 secondary 回单 pane
    await page.locator('.term-tab .term-close-btn').first().click()
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(1, { timeout: 8000 })
    await expect(page.locator('.term-tab')).toHaveCount(1)
    await expect(activeLayout(page).locator('.xterm').first()).toBeVisible({ timeout: 10000 })
  })
})
