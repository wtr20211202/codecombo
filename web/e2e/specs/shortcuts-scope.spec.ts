import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 快捷键作用域标签（P-20261003-99）：
 *   - 条目按生效条件打作用域徽标（分组=功能域、徽标=生效域，二者正交）：
 *     编辑器组的 Ctrl+S 徽标「编辑器」（Monaco 聚焦域），而同组的 diff 导航
 *     Alt+↑/↓ 徽标「全局」（注册于 useLayoutKeyboard 全局链）——跨组错位正是
 *     本提案要透明的点；审批等待组（键盘裁决 1/2/3）徽标「审批等待」
 *   - 作用域筛选 chip 与文本过滤 AND 叠加：「全部」复位、再点已选 chip 复位
 *
 * 作用域标注与实际注册的一致性由 scripts/check-keybindings.mjs 单向对账
 * （帮助承诺键 ⊆ 实际注册，approval 作用域同在审计面），此处只验 UI 呈现。
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

/** 按分组标题定位分组（不能用 group hasText——徽标/条目文案跨组含同词，
 *  如全局组的「切换活跃编辑器组」行会让全局组命中「编辑器」）；单条 :has()
 *  选择器把匹配锚在标题元素上，免 filter({ has }) 内层链相对锚定的歧义 */
function groupOf(help: ReturnType<Page['locator']>, title: string) {
  return help.locator(`.sc-help-group:has(.sc-help-group-title:has-text("${title}"))`)
}

test.describe('快捷键作用域标签', () => {
  test('条目徽标按生效条件标注：编辑器组内混布 编辑器/全局 两域，审批组标 审批等待', async ({ page }) => {
    await openProjectPage(page)
    const help = await openHelp(page)

    // 基线：7 个分组（全局/编辑器/终端/笔记面板 P-20261107-5/审批等待/值班大屏/
    // 鼠标与拖拽 P-20261005-184），每行都有作用域徽标（鼠标行的 trigger 短语也带徽标）
    await expect(help.locator('.sc-help-group')).toHaveCount(7)
    const rows = help.locator('.sc-help-row')
    const rowCount = await rows.count()
    expect(rowCount).toBeGreaterThanOrEqual(47)
    await expect(help.locator('.sc-help-scope')).toHaveCount(rowCount)

    // 编辑器组：保存行（Monaco addAction 聚焦域）徽标=编辑器
    const editorGroup = groupOf(help, '编辑器')
    await expect(
      editorGroup.locator('.sc-help-row').filter({ hasText: '保存当前文件' }).locator('.sc-help-scope'),
    ).toHaveText('编辑器')

    // 同组 diff 导航行：注册于全局链（非 Monaco 域）——徽标=全局，作用域≠分组
    await expect(
      editorGroup.locator('.sc-help-row').filter({ hasText: '导航 Diff 变更' }).locator('.sc-help-scope'),
    ).toHaveText('全局')

    // 审批等待组：键盘裁决 1/2/3 三行全标 审批等待
    const approvalGroup = groupOf(help, '审批等待')
    await expect(approvalGroup.locator('.sc-help-row')).toHaveCount(3)
    await expect(approvalGroup.locator('.sc-help-scope').filter({ hasText: '审批等待' })).toHaveCount(3)

    // 终端组行徽标=终端、大屏组行徽标=值班大屏（与分组同名域不缺标）
    await expect(
      groupOf(help, '终端').locator('.sc-help-row').filter({ hasText: '命令历史面板' }).locator('.sc-help-scope'),
    ).toHaveText('终端')
    await expect(
      groupOf(help, '值班大屏').locator('.sc-help-row').filter({ hasText: '刷新大屏数据' }).locator('.sc-help-scope'),
    ).toHaveText('值班大屏')

    // 笔记面板组（P-20261107-5）：notes 域三行（keymap 注册表动态行）全标 笔记面板
    const notesGroup = groupOf(help, '笔记面板')
    await expect(notesGroup.locator('.sc-help-row')).toHaveCount(3)
    await expect(notesGroup.locator('.sc-help-scope').filter({ hasText: '笔记面板' })).toHaveCount(3)
  })

  test('作用域筛选 chip：点选只留该域分组、与文本过滤 AND 叠加、全部/再点复位', async ({ page }) => {
    await openProjectPage(page)
    const help = await openHelp(page)
    const filter = help.locator('.sc-help-filter input')
    const chip = (scope: string) => help.locator(`.sc-help-scope-chip[data-scope="${scope}"]`)

    // 筛终端：终端组 + 鼠标与拖拽组（其终端域行：中键关终端签/拖文件进终端/广播多选；
    // 全局组里「显示/隐藏终端面板」等行虽文案含终端但作用域是全局，被滤掉）
    await chip('terminal').click()
    await expect(help.locator('.sc-help-group')).toHaveCount(2)
    await expect(help.locator('.sc-help-group-title').filter({ hasText: '终端' })).toBeVisible()
    await expect(help.locator('.sc-help-group-title').filter({ hasText: '鼠标与拖拽' })).toBeVisible()

    // AND 叠加：保持终端域 + 文本「历史」→ 终端组内命令历史面板行在、其余行滤除
    await filter.fill('历史')
    const groups = help.locator('.sc-help-group')
    await expect(groups).toHaveCount(1)
    await expect(groups.first().locator('.sc-help-row')).toHaveCount(1)

    // 换筛全局 + 清文本：全局组 + 编辑器组两组回归——编辑器组里 6 行是全局
    // 改键范围（diff 导航/分屏/线性切换/md 循环），作用域筛选按行生效所以
    // 两组都留（这正是徽标要透明的跨组错位）；组内编辑器聚焦域行被滤除
    await chip('global').click()
    await filter.fill('')
    const globalGroup = groupOf(help, '全局')
    const editorGroupGlobal = groupOf(help, '编辑器')
    await expect(help.locator('.sc-help-group')).toHaveCount(2)
    await expect(
      globalGroup.locator('.sc-help-row').filter({ hasText: '命令面板' }).first(),
    ).toBeVisible()
    await expect(
      editorGroupGlobal.locator('.sc-help-row').filter({ hasText: '导航 Diff 变更' }),
    ).toBeVisible()
    await expect(
      editorGroupGlobal.locator('.sc-help-row').filter({ hasText: '保存当前文件' }),
    ).toHaveCount(0)

    // 「全部」chip 复位：7 分组全量回归（P-20261107-5 起含笔记面板组）
    await chip('all').click()
    await expect(help.locator('.sc-help-group')).toHaveCount(7)

    // 再点已选 chip 同样复位（二次点击 toggle-off）
    await chip('approval').click()
    await expect(help.locator('.sc-help-group')).toHaveCount(1)
    await chip('approval').click()
    await expect(help.locator('.sc-help-group')).toHaveCount(7)
  })
})
