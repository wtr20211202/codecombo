import { test, expect, type Page } from '@playwright/test'
import {
  clearNotesViewUiState, closeNotesOverlayIfOpen, fixedLocale, gotoAndUnlock, unlockIfNeeded, waitForAppReady,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 笔记管理侧栏可调宽度 E2E（P-20261112-9 S1）：
 *   1. 拖拽调宽：把手 pointer 拖拽 → .np-sidebar 实时变宽 + localStorage 记忆
 *      落盘（sc.notes.sidebarWidth，sc.<panel>.sidebarWidth 既有车道）；反向拖
 *      过下界收在 min 钳制（不塌缩到不可用）；
 *   2. 宽度记忆：拖宽后刷新重开恢复持久宽度（load 读回）；ARIA slider 语义与
 *      实宽一致；双击把手恢复默认 260；键盘（聚焦后方向键/Home/End）微调即落盘。
 *   3. 窄屏（≤700px）默认收起不受影响：侧栏与把手同随 sidebarOpen 不挂载。
 * 复用 SidebarResizer 通用把手（P-20261106-5）：组件自身几何/键盘语义由
 * remote-sidebar-resize.spec 与 SidebarResizer.test.ts 守，本 spec 只守笔记
 * 接入面（键 sc.notes.sidebarWidth、默认 260/180–400 钳制、窄屏同隐）。
 * 入口走首页工具条 overlay（无项目夹具）；全局笔记库残留不碍宽度断言。
 */

const BASE = API_BASE
const WIDTH_KEY = 'sc.notes.sidebarWidth'
const DEFAULT_W = 260
const MIN_W = 180
const MAX_W = 400

/** 首页工具条入口 → 近全屏 overlay，面板可见（zh-CN 固定 locale） */
async function openNotesOverlay(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  // 前序用例残留的笔记 overlay 开态先关（P-20261112-6-S1 开态复活会遮住 home-notes，
  // 见 tests/helpers closeNotesOverlayIfOpen 注释）；关后 home-notes 即正常开
  await closeNotesOverlayIfOpen(page)
  await page.locator('[data-testid="home-notes"]').click()
  const panel = page.locator('[data-testid="notes-home-overlay"] [data-testid="notes-panel"]')
  await expect(panel).toBeVisible({ timeout: 8000 })
  return panel
}

/** 刷新后重新打开（同 context：localStorage/locale 注入仍在） */
async function openNotesOverlayAfterReload(page: Page) {
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await closeNotesOverlayIfOpen(page) // reload 后开态复活同防御（同上）
  await page.locator('[data-testid="home-notes"]').click()
  const panel = page.locator('[data-testid="notes-home-overlay"] [data-testid="notes-panel"]')
  await expect(panel).toBeVisible({ timeout: 8000 })
  return panel
}

/** 笔记侧栏实测宽（border-box：与内联 width px 值一致） */
async function sidebarWidth(page: Page): Promise<number> {
  const box = await page.locator('.np-sidebar').boundingBox()
  expect(box, '笔记侧栏应有 boundingBox').toBeTruthy()
  return box!.width
}

/** 抓住把手水平拖 delta px（pointer 事件链：down → move(steps) → up） */
async function dragResizer(page: Page, delta: number) {
  const handle = page.locator('[data-testid="notes-panel"] .sidebar-resizer')
  const box = await handle.boundingBox()
  expect(box, '宽度把手应有 boundingBox').toBeTruthy()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + delta, cy, { steps: 5 })
  await page.mouse.up()
}

test.afterAll(async () => {
  // 本 spec 用例结束时 overlay 保持打开：开态残留跨 spec 复活会遮住后续 spec 的
  // 首页入口——uiState notesView 键兜底归位（notes-view.spec afterAll 同款机制）
  await clearNotesViewUiState(BASE)
})

test('拖拽调宽：侧栏实时变宽 + localStorage 落盘 + 越下界收在 min 钳制', async ({ page }) => {
  const panel = await openNotesOverlay(page)

  // 大区域形态：管理侧栏默认常显（P-20261108-2 既有）
  await expect(panel.locator('[data-testid="notes-search"]')).toBeVisible({ timeout: 8000 })

  // 默认宽度 = 260（P-20261112-9 S1 提升：无记忆值的全新会话直接受益）
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W, 0)

  // 右拖 +100：侧栏实时变宽，松开落盘
  await dragResizer(page, 100)
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W + 100, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(DEFAULT_W + 100))

  // 左拖远超下界（360-300=60 < 180）：收在 180 钳制（参数化 min，不塌缩到不可用）
  await dragResizer(page, -300)
  expect(await sidebarWidth(page)).toBeCloseTo(MIN_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(MIN_W))
})

test('宽度记忆：刷新恢复持久宽度；双击复位默认；键盘方向键/Home/End 微调', async ({ page }) => {
  const panel = await openNotesOverlay(page)
  await expect(panel.locator('[data-testid="notes-search"]')).toBeVisible({ timeout: 8000 })

  // 拖宽到 340 → 刷新 → 重新打开笔记 → 恢复 340（非默认 260 = load 读回生效）
  await dragResizer(page, 80)
  expect(await sidebarWidth(page)).toBeCloseTo(340, 0)
  await page.reload()
  await openNotesOverlayAfterReload(page)
  expect(await sidebarWidth(page)).toBeCloseTo(340, 0)

  // ARIA slider 语义：role/valuemin/valuemax/valuenow 与实际宽度一致
  const handle = page.locator('[data-testid="notes-panel"] .sidebar-resizer')
  await expect(handle).toHaveAttribute('role', 'slider')
  await expect(handle).toHaveAttribute('aria-valuemin', String(MIN_W))
  await expect(handle).toHaveAttribute('aria-valuemax', String(MAX_W))
  await expect(handle).toHaveAttribute('aria-valuenow', '340')

  // 双击复位默认 260 并落盘（无存量记忆键，复位链即未来存量值的退役语义）
  await handle.dblclick()
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(DEFAULT_W))

  // 键盘可达：聚焦后 → 步进 +16 即落盘；焦点移出再按方向键宽度不动（非焦点巧合）
  await handle.focus()
  await page.keyboard.press('ArrowRight')
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W + 16, 0)
  await page.keyboard.press('Shift+Tab')
  await page.keyboard.press('ArrowRight')
  expect(await sidebarWidth(page)).toBeCloseTo(DEFAULT_W + 16, 0)
  await handle.focus()
  await page.keyboard.press('Home')
  expect(await sidebarWidth(page)).toBeCloseTo(MIN_W, 0)
  await page.keyboard.press('End')
  expect(await sidebarWidth(page)).toBeCloseTo(MAX_W, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), WIDTH_KEY)).toBe(String(MAX_W))
})

test('窄屏（≤700px）默认收起不受影响：侧栏与把手同随 sidebarOpen 不挂载', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 })
  const panel = await openNotesOverlay(page)
  // 窄屏默认收起（P-20261108-2 既有）：列表面与 S1 把手都不在 DOM
  await expect(panel.locator('[data-testid="notes-search"]')).toHaveCount(0)
  await expect(panel.locator('.sidebar-resizer')).toHaveCount(0)
})
