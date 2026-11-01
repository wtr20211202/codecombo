import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 鼠标与拖拽速查节（P-20261005-184）：ShortcutsHelp 的非键盘交互分区——
 *   - 新分组「鼠标与拖拽」9 条（跨组拖签/Alt 拖签复制/树拖入编辑器/中键关签×2/
 *     双击钉选/面包屑段点击/拖文件进终端/广播多选），条目=触发短语（kbd 键帽
 *     样式）+ 效果一句话 + 作用域徽标（复用 P-99 体系，跨 editor/terminal 混布）
 *   - 文本过滤覆盖新节（描述/触发短语均匹配）；作用域筛选 chip 与新节 AND 叠加
 *
 * 条目与实现的一致性靠组件内注释锚点自陈（鼠标交互无键位注册表，不走
 * check-keybindings 对账），此处只验 UI 呈现与筛选行为。
 */

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

async function openHelp(page: Page) {
  await page.keyboard.press('?')
  const help = page.locator('.sc-help')
  await expect(help).toBeVisible({ timeout: 5000 })
  return help
}

/** 按分组标题定位分组（shortcuts-scope.spec 同款：单条 :has() 把匹配锚在标题元素上） */
function groupOf(help: ReturnType<Page['locator']>, title: string) {
  return help.locator(`.sc-help-group:has(.sc-help-group-title:has-text("${title}"))`)
}

test.describe('鼠标与拖拽速查节', () => {
  test('新节可见：9 条目均有触发短语键帽 + 作用域徽标（editor 6 / terminal 3）', async ({ page }) => {
    await openProjectPage(page)
    const help = await openHelp(page)

    const mouse = groupOf(help, '鼠标与拖拽')
    await expect(mouse).toBeVisible()
    await expect(mouse.locator('.sc-help-row')).toHaveCount(9)

    // 每行：触发短语 kbd 至少 1 枚（Alt 拖签行 2 枚）+ 作用域徽标在场
    const rows = mouse.locator('.sc-help-row')
    for (let i = 0; i < 9; i++) {
      await expect(rows.nth(i).locator('.sc-help-keys kbd').first()).toBeVisible()
      await expect(rows.nth(i).locator('.sc-help-scope')).toBeVisible()
    }
    await expect(mouse.locator('.sc-help-keys kbd').filter({ hasText: 'Alt' })).toHaveCount(1)
    await expect(mouse.locator('.sc-help-scope').filter({ hasText: '编辑器' })).toHaveCount(6)
    await expect(mouse.locator('.sc-help-scope').filter({ hasText: '终端' })).toHaveCount(3)
  })

  test('筛选覆盖新节：文本「中键」命中鼠标两行，与终端作用域 chip AND 叠加收窄到一行', async ({ page }) => {
    await openProjectPage(page)
    const help = await openHelp(page)
    const filter = help.locator('.sc-help-filter input')
    const chip = (scope: string) => help.locator(`.sc-help-scope-chip[data-scope="${scope}"]`)

    // 文本过滤命中新节：中键关签两行（编辑器+终端），仅鼠标组在场
    await filter.fill('中键')
    await expect(help.locator('.sc-help-group')).toHaveCount(1)
    const mouse = groupOf(help, '鼠标与拖拽')
    await expect(mouse.locator('.sc-help-row')).toHaveCount(2)

    // AND 叠加：终端作用域 chip 收窄到终端中键一行（编辑器中键行被作用域滤除）
    await chip('terminal').click()
    await expect(mouse.locator('.sc-help-row')).toHaveCount(1)
    await expect(
      mouse.locator('.sc-help-row').filter({ hasText: '中键点终端标签' }),
    ).toHaveCount(1)

    // 复位后全量回归
    await chip('terminal').click()
    await filter.fill('')
    await expect(help.locator('.sc-help-group')).toHaveCount(6)
  })
})
