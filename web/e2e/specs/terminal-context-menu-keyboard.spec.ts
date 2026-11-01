import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 自绘右键菜单键盘导航 E2E（P-20261004-69）：term-context 家族（tab/pane 右键菜单）
 * 从「键盘孤岛」收口为可达——Menu 键/Shift+F10 可开，↑↓ 环绕移焦、Home/End 首尾、
 * Enter 激活、Esc 关闭，打开即聚焦首项，禁用项跳过。
 *   1. tab 菜单：Shift+F10 开菜单 → 首项（置顶）自动聚焦 → ↓↓↓↓↑↑ 环绕移焦
 *      （置顶→重命名→复制会话→复制会话 ID→拖出为浮动窗，P-20261004-1 复制会话
 *      插入重命名后、P-20261004-123 复制会话 ID 插入复制会话后）→
 *      Enter 激活「重命名」生效 → 重开菜单 Esc 关闭且不误触全局 Esc 退出链
 *   2. pane 菜单：右键打开 → 首项「复制」无选区禁用 → 首焦点跳过禁用项落在
 *      「粘贴」→ ↑ 回绕到末项「刷新」→ Home 回「粘贴」→ Esc 关闭
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 打开项目并归一化底部终端面板可见 + 至少 1 个 tab（terminal-tab-pin 同款归一路径） */
async function openProjectTerminal(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 5000 })
  if ((await page.locator('.term-tab').count()) === 0) {
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 15_000 })
  }
}

/** 当前焦点元素（菜单项按钮）内 span 的文案——菜单项视觉文本的稳定读数 */
function focusedItemText(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return (el?.querySelector('span')?.textContent ?? el?.textContent ?? '').trim()
  })
}

test('tab 菜单键盘导航：Shift+F10 开 → 首项自动聚焦 → ↑↓ 环绕 → Enter 重命名生效 → Esc 关闭', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场基线：只清理本用例新建的会话（存量 tab 不碰）
  const list0 = await page.request.get(`${BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))

  await openProjectTerminal(page)
  // 专用新 tab（.last() = 最新创建，置顶投影也不改变其队尾位置），避免改名污染存量
  const createBtn = page.locator('.term-toolbar').getByRole('button', { name: '新建终端' })
  const before = await page.locator('.term-tab').count()
  await createBtn.click()
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 15_000 })
  const target = page.locator('.term-tab').last()

  try {
    // Menu 键路径：聚焦 tab + Shift+F10 → contextmenu 事件 → tab 菜单打开
    await target.focus()
    await page.keyboard.press('Shift+F10')
    const menu = page.locator('.term-tab-context-menu')
    await expect(menu).toBeVisible({ timeout: 5000 })

    // 打开即聚焦首项（置顶，P-20261004-53 后居首位）
    expect(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.getAttribute('data-testid')))
      .toBe('terminal-pin-tab')

    // ↓ 环绕移焦：置顶 → 重命名 → 复制会话 → 复制会话 ID（P-20261004-123 插入
    // 复制会话后）→ 拖出为浮动窗；↑↑↑ 原路走回重命名（两个方向都走到）
    await page.keyboard.press('ArrowDown')
    await expect(await focusedItemText(page)).toBe('重命名')
    await page.keyboard.press('ArrowDown')
    await expect(await focusedItemText(page)).toBe('复制会话')
    await page.keyboard.press('ArrowDown')
    await expect(await focusedItemText(page)).toBe('复制会话 ID')
    await page.keyboard.press('ArrowDown')
    await expect(await focusedItemText(page)).toBe('拖出为浮动窗')
    await page.keyboard.press('ArrowUp')
    await expect(await focusedItemText(page)).toBe('复制会话 ID')
    await page.keyboard.press('ArrowUp')
    await expect(await focusedItemText(page)).toBe('复制会话')
    await page.keyboard.press('ArrowUp')
    await expect(await focusedItemText(page)).toBe('重命名')

    // Enter 激活（原生 button click 语义，composable 不拦截）→ 菜单关 + 重命名生效
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    const renameInput = target.locator('.term-rename-input')
    await expect(renameInput).toBeVisible({ timeout: 5000 })
    // 直接 fill 不点：点击会冒泡到 tab 的 @click=selectTab → nextTick 里 term.focus()
    // 抢走输入框焦点 → @blur=finishRename 提交并收起输入框（既有重命名流行为）
    await renameInput.fill('kbd-nav-e2e')
    await page.keyboard.press('Enter')
    await expect(target.locator('.term-tab-name')).toHaveText('kbd-nav-e2e', { timeout: 5000 })

    // Esc 关闭：重开菜单（右键）→ Escape → 菜单消失，且不外泄给全局 Esc 退出链
    // （终端面板仍在场 = 布局级 Esc 链未被菜单上的 Esc 误触发）
    await target.click({ button: 'right' })
    await expect(menu).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(page.locator('.term-toolbar')).toBeVisible()
  } finally {
    const list1 = await page.request.get(`${BASE}/api/terminals`, { headers })
    for (const s of ((await list1.json()) as { data?: { id: string }[] }).data || []) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

test('pane 菜单键盘导航：首焦点跳过禁用项 → 回绕 + Home/End 首尾 → Esc 关闭', async ({ page }) => {
  test.setTimeout(120_000)
  await openProjectTerminal(page)

  // 右键 pane → pane 菜单打开；全新终端无选区 → 首项「复制」禁用。
  // 取「当前可见 pane」而非 DOM first：pane 常驻挂载 v-show 互斥可见
  // （TerminalPanesArea v-for + v-show，tab 始终挂载 xterm 不销毁），
  // 存量实例残留多 tab 时 first() 命中旧 tab 的隐藏屏（is-active-pane 是 pane
  // 级标记与 tab 可见性无关），click 永不可见超时——CLAUDE.md「多 tab 取
  // last/可见屏」纪律；菜单键盘导航与具体哪个 pane 无关，任一在场 pane 皆可
  await page.locator('.term-pane:visible').last().click({ button: 'right', position: { x: 60, y: 40 } })
  const menu = page.locator('.term-context-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })

  // 首焦点跳过禁用的「复制」，落在首个可用项「粘贴」（禁用项跳过导航）
  await expect(await focusedItemText(page)).toBe('粘贴')

  // ↑ 自首项回绕到末项「刷新」；Home 回首可用项「粘贴」；End 直达末项「刷新」
  await page.keyboard.press('ArrowUp')
  await expect(await focusedItemText(page)).toBe('刷新内容')
  await page.keyboard.press('Home')
  await expect(await focusedItemText(page)).toBe('粘贴')
  await page.keyboard.press('End')
  await expect(await focusedItemText(page)).toBe('刷新内容')

  // Esc 关闭
  await page.keyboard.press('Escape')
  await expect(menu).toHaveCount(0)
})
