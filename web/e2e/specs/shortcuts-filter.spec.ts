import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 快捷键帮助面板过滤框（P-20261003-31）：
 *   - 面板顶部过滤输入（? 呼出后自动聚焦）：按条目描述文案+键位串不分大小写匹配
 *   - 命中分组保留、空组隐藏；零命中显示空态行
 *   - Esc 两段式：首次清空过滤（面板不关）、二次关闭面板
 *
 * Esc 二次关闭与全局逐层收起链（esc-layered-dismiss）的让位前提由组件侧保证：
 * 全局链在 n-modal 在场时经 hasBlockingOverlay 整体让位，两段式收链全在面板内。
 */

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** ? 呼出帮助面板并断言过滤框自动聚焦（后续键入直接进过滤框，无需点击） */
async function openHelp(page: Page): Promise<{ help: ReturnType<Page['locator']>; filter: ReturnType<Page['locator']> }> {
  await page.keyboard.press('?')
  const help = page.locator('.sc-help')
  await expect(help).toBeVisible({ timeout: 5000 })
  const filter = help.locator('.sc-help-filter input')
  await expect(filter).toBeFocused()
  return { help, filter }
}

test.describe('快捷键帮助面板过滤', () => {
  test('? 呼出自动聚焦 → 按描述过滤：命中分组保留、空组隐藏、零命中空态', async ({ page }) => {
    await openProjectPage(page)
    const { help, filter } = await openHelp(page)

    // 基线：6 个分组全量显示（全局/编辑器/终端/审批等待/大屏辅助组/鼠标与拖拽，
    // P-20261003-99 增审批等待组、P-20261005-184 增鼠标与拖拽组）
    await expect(help.locator('.sc-help-group')).toHaveCount(6)

    // 「终端」命中全局组（显示/隐藏终端面板等）、终端组与鼠标组（中键关终端签/
    // 拖文件进终端/广播多选）——三组保留，无命中的编辑器组、审批等待组与
    // 大屏辅助组隐藏（键位串含 Ctrl/Alt 的编辑器行不因键位误命中）
    await filter.fill('终端')
    const titles = help.locator('.sc-help-group-title')
    await expect(titles.filter({ hasText: '全局' })).toBeVisible()
    await expect(titles.filter({ hasText: '终端' })).toBeVisible()
    await expect(titles.filter({ hasText: '鼠标与拖拽' })).toBeVisible()
    await expect(titles.filter({ hasText: '编辑器' })).toHaveCount(0)

    // 键位串匹配：Alt 命中含 Alt 键的行（diff 导航/切终端标签等），行内 kbd 可见
    await filter.fill('alt')
    await expect(help.locator('.sc-help-keys kbd').filter({ hasText: 'Alt' }).first()).toBeVisible()

    // 零命中：空态行显示、分组全部隐藏
    await filter.fill('zzz-无此键-zzz')
    await expect(help.locator('.sc-help-empty')).toBeVisible()
    await expect(help.locator('.sc-help-group')).toHaveCount(0)

    // 清空恢复全量
    await filter.fill('')
    await expect(help.locator('.sc-help-group')).toHaveCount(6)
  })

  test('Esc 两段式：首次清空过滤面板不关，二次关闭', async ({ page }) => {
    await openProjectPage(page)
    const { help, filter } = await openHelp(page)

    await filter.fill('终端')
    await expect(help.locator('.sc-help-group')).toHaveCount(3)

    // Esc #1：只清过滤——面板仍开、分组恢复全量、输入框重新聚焦
    await page.keyboard.press('Escape')
    await expect(help).toBeVisible()
    await expect(filter).toHaveValue('')
    await expect(help.locator('.sc-help-group')).toHaveCount(6)
    await expect(filter).toBeFocused()

    // Esc #2：过滤已空，放行 naive closeOnEsc 关面板
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden({ timeout: 5000 })
  })
})
