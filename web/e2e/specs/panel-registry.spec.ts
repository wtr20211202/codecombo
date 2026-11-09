import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 面板注册表守护（roadmap M3.4）：
 * 活动栏按钮 / 底部 Tab 只允许经 web/src/panels/registry.ts 注册产生
 * （单一入口），本 spec 锁定注册表的渲染结果——新增面板时必须同步更新
 * 这里的期望清单（这正是守护点：防止绕过注册表手写面板装配）。
 * 期望清单（zh-CN，fixedLocale 固定）：
 *   活动栏 rail-top 面板按钮（files/changes/todos/git/terminal/notes/
 *   agent-terminal/share-manager/dsh-console/remote-console，共 10 个）+
 *   2 个固定按钮（添加项目/设置）
 *   底部 bottom-tab 4 个 Tab（终端/Git/预览/控制台）——提交面板已改为侧栏专属
 *   形态（registry 的 changes rail 入口），底部不再有提交 Tab
 *
 * 注意：活动栏/底部面板只挂在项目页（Layout）——先进入项目。
 */

/** 进入 simple-coding 项目页（活动栏/底部面板的挂载宿主） */
async function enterProject(page: import('@playwright/test').Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击/快捷键，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

test.describe('panel registry', () => {
  test('活动栏渲染注册表声明的全部面板按钮', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const rail = page.locator('.ide-rail')
    await expect(rail).toBeVisible()

    // 注册表面板按钮（rail-top 组，按 order 升序的 title 文案）
    const expectedRailPanels = [
      '项目文件',     // files
      '提交',         // changes
      'Git 管理',     // git
      '终端',         // terminal
      '笔记',         // notes（P-20261002-110；P-20261107-5 起文案「笔记」，P-20261108-2 起主区独立视图）
      '终端会话管理', // agent-terminal
      '远程管理',     // remote-console
    ]
    for (const title of expectedRailPanels) {
      await expect(rail.locator(`.rail-btn[title="${title}"]`), `rail 面板按钮 ${title}`).toHaveCount(1)
    }

    // 固定按钮：添加项目 / 设置（非注册表面板，回归守护）
    await expect(rail.locator('.rail-btn[title="添加项目"]')).toHaveCount(1)
    await expect(rail.locator('.rail-btn[title="设置"]')).toHaveCount(1)
  })

  test('底部面板渲染注册表声明的全部 Tab', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    const tabs = page.locator('.bottom-tabs button')
    await expect(tabs).toHaveCount(5)

    // bottom-tab 组：终端(10) Git(20 labelRaw) 预览(30) 问题(35 P-20261003-297)
    // 控制台(40)——提交面板为侧栏专属
    await expect(tabs.filter({ hasText: '终端' })).toHaveCount(1)
    await expect(tabs.filter({ hasText: 'Git' })).toHaveCount(1)
    await expect(tabs.filter({ hasText: '预览' })).toHaveCount(1)
    await expect(tabs.filter({ hasText: '问题' })).toHaveCount(1)
    await expect(tabs.filter({ hasText: '控制台' })).toHaveCount(1)
  })

  test('点击活动栏面板按钮可切换面板（注册表 onClick 生效）', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    // 终端按钮 → 底部面板展开且 terminal tab 激活
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await expect(page.locator('.bottom-tabs button').filter({ hasText: '终端' })).toHaveClass(/primary/, { timeout: 5000 })

    // 项目文件按钮 → 侧栏展开（toggle 语义：可能已被 uiState 恢复为开启，归一化点击）
    const filesBtn = page.locator('.ide-rail .rail-btn[title="项目文件"]')
    for (let i = 0; i < 3; i++) {
      if (await page.locator('#side-panel').isVisible().catch(() => false)) break
      await filesBtn.click()
      await page.waitForTimeout(500)
    }
    await expect(page.locator('#side-panel')).toBeVisible()
  })

  test('Ctrl+1..9 数字键按视觉顺序切换活动栏面板', async ({ page }) => {
    await fixedLocale(page)
    await enterProject(page)

    // 归一化基线：侧栏与底部面板均关闭（toggle 语义下，只有从关闭基线出发
    // 数字键结果才确定——uiState 持久的面板开合状态因跑序而异）
    for (let i = 0; i < 4; i++) {
      if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
      await page.locator('.ide-rail .rail-btn[title="项目文件"]').click()
      await page.waitForTimeout(400)
    }
    for (let i = 0; i < 4; i++) {
      if (!(await page.locator('.bottom-tabs button').first().isVisible().catch(() => false))) break
      await page.keyboard.press('Control+`')
      await page.waitForTimeout(400)
    }
    await expect(page.locator('#side-panel')).toBeHidden()
    await expect(page.locator('.bottom-tabs button').first()).toBeHidden()

    // rail-top 视觉序（10 个，registry.test.ts 同源断言）：
    // 1 files / 2 changes / 3 todos / 4 git / 5 terminal / 6 notes
    // 7 agent-terminal / 8 share-manager / 9 dsh-console / 10 remote-console。
    // 只按到 Ctrl+5：1..5 覆盖了 notes 插入点前后（第 6 位）的全部既有键位；
    // 6..9 位是主区视图切换（dsh/分享/远程），按下会持久化 dshConsole.open 等
    // 布局态且本 spec 无 afterAll 清理，跨 spec 污染首页（实测 dsh-auth-center
    // 遮罩劫持后续 spec 的 project-card 点击），故不在此处触发

    // 关闭基线：Ctrl+1 → 侧栏开（files）
    await page.keyboard.press('Control+1')
    await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.ide-rail .rail-btn[title="项目文件"]')).toHaveClass(/active/)

    // Ctrl+3 → 侧栏切 todos（P-20261002-25 起 todos 居第 3 位）
    await page.keyboard.press('Control+3')
    await expect(page.locator('.ide-rail .rail-btn[title="TODO 清单"]')).toHaveClass(/active/, { timeout: 5000 })
    await expect(page.locator('[data-testid="todo-panel"]')).toBeVisible()

    // Ctrl+4 → 底部面板开且 git tab 激活
    await page.keyboard.press('Control+4')
    await expect(page.locator('.bottom-tabs button').filter({ hasText: 'Git' })).toHaveClass(/primary/, { timeout: 5000 })

    // Ctrl+5 → 底部面板切 terminal
    await page.keyboard.press('Control+5')
    await expect(page.locator('.bottom-tabs button').filter({ hasText: '终端' })).toHaveClass(/primary/, { timeout: 5000 })
  })
})
