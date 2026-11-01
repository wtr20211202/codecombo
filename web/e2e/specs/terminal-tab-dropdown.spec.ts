import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端 tab 溢出快速选择下拉（P-20261002-112，复刻编辑器 EditorGroupPane 标签溢出模式）：
 *   ① tab 未溢出：尾部无 chevron 按钮（v-if 不渲染）
 *   ② 多开会话至 tab 挤压溢出（scrollWidth 差 >4）：尾部出现 chevron
 *   ③ 点开下拉：列出全部会话 tab（条数与 tab 一致、名字一一对上），当前项高亮标注
 *   ④ 点选非当前项：下拉关闭 + 直达激活对应会话（is-active 迁移）
 */

/** 终端面板基座：进入项目 + 归一化底部终端面板可见 + 至少 1 个 tab（terminal-font-gesture 同款归一路径） */
async function openTerminalPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
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

/** 溢出 chevron 按钮（v-if：未溢出时 DOM 不存在） */
function overflowBtn(page: import('@playwright/test').Page) {
  return page.locator('.term-tabs-overflow-btn')
}

/** 下拉里名称精确等于 name 的选项（用 exact 内层匹配，避免「终端 1」误中「终端 10」） */
function optionFor(page: import('@playwright/test').Page, name: string) {
  return page.locator('.n-dropdown-menu .n-dropdown-option', {
    has: page.getByText(name, { exact: true }),
  })
}

test('tab 溢出→chevron→下拉列全部会话→点选直达激活', async ({ page }) => {
  await openTerminalPanel(page)

  // 自愈归一：前序运行残留的溢出态先清到 chevron 消失（关 tab 可能弹二次确认）
  for (let i = 0; i < 24 && (await overflowBtn(page).isVisible().catch(() => false)); i++) {
    await page.locator('.term-tab').last().locator('.term-close-btn').click()
    const modal = page.locator('.n-modal')
    if (await modal.isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(300)
  }
  await expect(overflowBtn(page)).toHaveCount(0)

  // 多开至溢出：cap 兜底，若 16 个仍未溢出让断言显式失败而非死循环
  const createBtn = page.locator('.term-toolbar').getByRole('button', { name: '新建终端' })
  for (let i = 0; i < 16; i++) {
    if (await overflowBtn(page).isVisible().catch(() => false)) break
    const before = await page.locator('.term-tab').count()
    await createBtn.click()
    await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 10000 })
  }
  await expect(overflowBtn(page)).toBeVisible()

  // 下拉列出全部会话 tab：条数与 tab 一致、名字一一对上
  const tabNames = await page.locator('.term-tab-name').allTextContents()
  await overflowBtn(page).click()
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.n-dropdown-option')).toHaveCount(tabNames.length)
  for (const name of tabNames) {
    await expect(optionFor(page, name)).toHaveCount(1)
  }

  // 当前项高亮标注：活动 tab 对应选项 font-weight 600（naive-ui 把 option props
  // 内联样式落在 .n-dropdown-option-body 上，字重沿继承链到 label 可观测）
  const activeName = await page.locator('.term-tab.is-active .term-tab-name').textContent() as string
  await expect(menu.getByText(activeName, { exact: true })).toHaveCSS('font-weight', '600')

  // 点选非当前项：下拉关闭 + 直达激活对应会话
  const targetName = tabNames.find(n => n !== activeName)
  expect(targetName, '至少存在两个会话 tab 供切换').toBeTruthy()
  await optionFor(page, targetName!).click()
  await expect(page.locator('.n-dropdown-menu')).toHaveCount(0)
  await expect(page.locator('.term-tab.is-active .term-tab-name')).toHaveText(targetName!)
})
