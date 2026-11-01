import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端 tab 条空白区双击 → 快捷新建会话（P-20261004-65）：浏览器/VS Code
 * 「双击 tab 栏空白开新 tab」肌肉记忆，复用工具栏 + 按钮同一条 create 动作链。
 *   ① 双击 tab 条空白区：新会话出现并激活（tab 数 +1，新 tab 即 is-active）
 *   ② tab 本体双击语义不回归：名字区双击仍 = 重命名（输入框出现、tab 数不变
 *      ——名字区 dblclick 未 .stop 会冒泡到容器，closest 守卫必须拦住不新建），
 *      名字区以外的 tab 卡面（序号徽章）双击零动作（不新建、不重命名）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 终端面板基座：进入项目 + 归一化底部终端面板可见 + 至少 1 个 tab（terminal-tab-dropdown 同款归一路径） */
async function openTerminalPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }

  // 引导恢复落定拍：uiState 面板开合异步晚到会翻转归零后的首个 rail 点击语义
  await page.waitForTimeout(600)
  // 归一化：底部终端面板可见（rail 钮 toggle 语义覆盖三种恢复态）
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  if ((await page.locator('.term-tab').count()) === 0) {
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 10000 })
  }
}

/** 只清理本用例新建的会话（存量 tab 不碰，terminal-context-menu-keyboard 同款） */
async function cleanupCreatedSessions(
  page: Page,
  headers: Record<string, string>,
  beforeIds: Set<string>,
) {
  const list = await page.request.get(`${BASE}/api/terminals`, { headers })
  for (const s of ((await list.json()) as { data?: { id: string }[] }).data || []) {
    if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

test('双击 tab 条空白区 → 新建会话并激活', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场基线：只清理本用例新建的会话（存量 tab 不碰）
  const list0 = await page.request.get(`${BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))

  await openTerminalPanel(page)

  // 归一化出确定空白区：前序运行残留多 tab 把 tab 条占满时关尾 tab 腾空
  // （关 tab 可能弹二次确认）；只剩 1 个仍无空白则显式失败而非静默双击落 tab 上
  for (let i = 0; i < 16; i++) {
    const strip = await page.locator('.term-tablist').boundingBox()
    const last = await page.locator('.term-tab').last().boundingBox()
    if (strip && last && last.x + last.width + 12 <= strip.x + strip.width) break
    if ((await page.locator('.term-tab').count()) <= 1) break
    await page.locator('.term-tab').last().locator('.term-close-btn').click()
    const modal = page.locator('.n-modal')
    if (await modal.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(300)
  }
  const strip = await page.locator('.term-tablist').boundingBox()
  const last = await page.locator('.term-tab').last().boundingBox()
  if (!strip || !last || last.x + last.width + 12 > strip.x + strip.width) {
    throw new Error('tab 条无空白区（残留 tab 挤满），双击空白落点无法保证')
  }

  // 双击最后 tab 右缘与条右缘的中点：保证落点在空白区（2px tab 间隙之外）
  const blankX = (last.x + last.width + strip.x + strip.width) / 2
  const before = await page.locator('.term-tab').count()
  await page.mouse.dblclick(blankX, strip.y + strip.height / 2)

  // 新会话出现且激活（createTerminal 即激活；置顶投影不改新 tab 队尾位置）
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 10000 })
  await expect(page.locator('.term-tab').last()).toHaveClass(/is-active/, { timeout: 10000 })

  await cleanupCreatedSessions(page, headers, beforeIds)
})

test('tab 本体双击不回归：名字区 = 重命名，非名字区零动作', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  const list0 = await page.request.get(`${BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))

  await openTerminalPanel(page)

  // 专用新 tab（避免双击/重命名流转污染存量 tab），.last() = 最新创建
  const createBtn = page.locator('.term-toolbar').getByRole('button', { name: '新建终端' })
  const before = await page.locator('.term-tab').count()
  await createBtn.click()
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 15000 })
  const target = page.locator('.term-tab').last()

  // 名字区双击 → 重命名输入框出现；tab 数不变（dblclick 冒泡到容器须被 closest 守卫拦下）
  await target.locator('.term-tab-name').dblclick()
  await expect(target.locator('.term-rename-input')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.term-tab')).toHaveCount(before + 1)
  // Esc 取消重命名（不落库不改名，零污染）——press 先聚焦输入框再派键，
  // 不依赖动态插入的 autofocus 是否生效（键盘导航 spec 同款「不点只按键」纪律）
  await target.locator('.term-rename-input').press('Escape')
  await expect(target.locator('.term-rename-input')).toHaveCount(0)

  // 非名字区（序号徽章）双击 → 零动作：不新建会话、不进重命名
  await target.locator('.term-tab-index').dblclick()
  await expect(page.locator('.term-tab')).toHaveCount(before + 1)
  await expect(page.locator('.term-rename-input')).toHaveCount(0)

  await cleanupCreatedSessions(page, headers, beforeIds)
})
