import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 悬浮列表形态 E2E（P4）：第三种收起形态（球/条/列表）。
 *
 * 覆盖点：
 *   1. 右键样式菜单切「悬浮列表」→ 列表面板出现，包含全部会话行（按项目分组标注）
 *   2. 点击项目会话行 = 跳转项目视图并激活底部终端 tab（管理组件收起）
 *   3. 列表头部刷新按钮可用（列表保持可见）
 *   4. 底部快捷操作「管理页」→ docked 管理页打开
 */

/** 前置：项目页 + 一个底部终端 tab；收起为球并切到列表形态 */
async function setupListShape(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 建一个底部终端（后续作为列表中的项目会话行）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: '新建终端' }).first().click()
  await page.locator('.term-container .xterm').locator('visible=true').first()
    .waitFor({ state: 'visible', timeout: 10000 })

  // 打开管理页 → 收起为悬浮球
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
  const ball = page.locator('.agm-root')
  await expect(ball).toBeVisible()

  // 右键样式菜单 → 切「悬浮列表」
  await ball.click({ button: 'right' })
  await page.getByText('悬浮列表', { exact: true }).click()
  const list = page.locator('.agm-root.is-list')
  await expect(list).toBeVisible()
  return list
}

test.describe('悬浮列表形态（P4）', () => {
  test.afterEach(async ({ page }) => {
    // 清理可能残留的样式（localStorage 随 context 销毁，无需处理）
    await page.close()
  })

  test('列表展示会话行；点击项目会话跳转项目并激活 tab', async ({ page }) => {
    const list = await setupListShape(page)

    // 列表包含项目会话行（名称 = 实际创建的 tab 名；playwright 钉 zh-CN，
    // 服务端按 Accept-Language 命名会话为「终端 N」）
    const row = list.locator('.agm-list-row', { hasText: '终端' }).first()
    await expect(row).toBeVisible()
    // 行内带项目名标注（simple-coding）
    await expect(row.locator('.agm-list-row-proj')).toHaveText('simple-coding')

    // 点击行 → 跳转项目视图并激活 tab；悬浮组件收起
    await row.click()
    await expect(page).toHaveURL(/\/project/)
    await expect(page.locator('.agm-root')).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.term-container .xterm').locator('visible=true').first())
      .toBeVisible({ timeout: 15000 })
  })

  test('刷新按钮保持列表可见；「管理页」快捷操作打开 docked 管理页', async ({ page }) => {
    const list = await setupListShape(page)

    // 刷新：列表保持可见且无报错
    await list.locator('.agm-list-head .agm-list-btn').first().click()
    await expect(list).toBeVisible()

    // 底部快捷操作「管理页」→ docked 打开
    await list.locator('.agm-list-foot-btn', { hasText: '管理页' }).click()
    await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  })

  test('拖拽悬浮球：进行中半透明反馈，松手恢复（打磨轮5）', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
    const ball = page.locator('.agm-root')
    await expect(ball).toBeVisible()

    // 按下并越过拖拽阈值 → is-dragging 半透明；松手 → 恢复不透明
    const box = await ball.boundingBox()
    expect(box).toBeTruthy()
    const cx = box!.x + box!.width / 2
    const cy = box!.y + box!.height / 2
    await page.mouse.move(cx, cy)
    await page.mouse.down()
    await page.mouse.move(cx + 14, cy + 10, { steps: 4 })
    await expect(ball).toHaveClass(/is-dragging/)
    await expect(ball).toHaveCSS('opacity', '0.5')
    await page.mouse.move(cx + 60, cy + 40, { steps: 4 })
    await page.mouse.up()
    await expect(ball).not.toHaveClass(/is-dragging/)
    await expect(ball).toHaveCSS('opacity', '1')
  })
})
