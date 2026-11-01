import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 终端分屏 pane 键盘切换 E2E（P-20261004-111）：编辑器组 focusOtherGroup 的终端对称。
 *
 * 覆盖：
 *   - 分屏双 pane 下 Ctrl+Alt+- 键切 → 激活态（is-active-pane）与输入焦点同翻对侧
 *   - 单 pane 按键放行：无 split 产生、会话数不变、无副作用（转发 PTY 语义）
 *
 * 语义参照 useTerminalSplit.focusOtherPane：以按键 pane 为基准互翻，切换走
 * setActivePane 既有收口（fit + 滚动区重同步 + xterm focus 链）。
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

/** 活跃 tab 的布局根（可见 = 活跃；断言锚定避免多会话 strict violation） */
function activeLayout(page: Page) {
  return page.locator('.term-tab-content:visible .term-pane-layout')
}

/** 焦点（document.activeElement）落在第几个 pane：-1 = 不在任何 pane 内 */
async function focusedPaneIndex(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    const pane = el?.closest('.term-pane')
    if (!pane?.parentElement) return -1
    const siblings = Array.from(pane.parentElement.children).filter(c => c.classList.contains('term-pane'))
    return siblings.indexOf(pane)
  })
}

test.describe('终端分屏 pane 键盘切换（P-20261004-111）', () => {
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

  test('分屏双 pane：Ctrl+Alt+- 键切 → 激活态与输入焦点翻到对侧', async ({ page }) => {
    await pickSplit(page, 'horizontal')
    const layout = activeLayout(page)
    await expect(layout).toHaveClass(/split/, { timeout: 8000 })
    await expect(layout.locator('.term-pane')).toHaveCount(2)

    // 点击主 pane 建立基准：主 pane 活跃 + 输入焦点在主 pane
    await layout.locator('.term-pane').first().click()
    await expect(layout.locator('.term-pane').nth(0)).toHaveClass(/is-active-pane/, { timeout: 5000 })
    expect(await focusedPaneIndex(page)).toBe(0)

    // 键切：Ctrl+Alt+- → 激活态与焦点同翻对侧（secondary）
    await page.keyboard.press('Control+Alt+-')
    await expect(layout.locator('.term-pane').nth(1)).toHaveClass(/is-active-pane/, { timeout: 5000 })
    await expect.poll(() => focusedPaneIndex(page), { timeout: 5000 }).toBe(1)

    // 再按一次翻回主 pane（toggle 语义）
    await page.keyboard.press('Control+Alt+-')
    await expect(layout.locator('.term-pane').nth(0)).toHaveClass(/is-active-pane/, { timeout: 5000 })
    await expect.poll(() => focusedPaneIndex(page), { timeout: 5000 }).toBe(0)
  })

  test('单 pane：按键放行无副作用（不产生 split、会话数不变）', async ({ page }) => {
    await expect(activeLayout(page)).toHaveClass(/single/, { timeout: 5000 })

    // 聚焦 pane 后按 Ctrl+Alt+-：无 split 宿主裁决 → 键位放行转发 PTY
    await activeLayout(page).locator('.term-pane').first().click()
    await page.keyboard.press('Control+Alt+-')

    // 无副作用：仍单 pane 布局、单 tab、无错误弹层，终端仍可聚焦输入
    await expect(activeLayout(page)).toHaveClass(/single/, { timeout: 3000 })
    await expect(page.locator('.term-tab')).toHaveCount(1)
    await expect(page.locator('.n-modal')).toHaveCount(0)
    await expect.poll(() => focusedPaneIndex(page), { timeout: 5000 }).toBe(0)
  })
})
