import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * Ctrl+Shift+` 新建终端直达（P-20261002-38，对标 VS Code 新建终端键位）：
 *   ① 面板关闭态按键：开底部终端面板 + 新建 tab 并激活（复用 createTerminal 链）
 *   ② 面板已开态按键：不再收起面板，继续新建（直达语义非 toggle）
 *   ③ 非 shift Ctrl+` 保持既有面板开关（关闭态按键只开面板建一枚 tab）
 *   ④ xterm 聚焦态按键：全局层先于面板消化，直达键仍生效
 * 纯前端链路，用种子项目 simple-coding；面板开合经服务端 uiState 恢复可能跨
 * 用例残留——用例开头先等引导恢复落定再幂等归零（P-69 preview-hotkey 同款）。
 */

async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续按键/点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 引导恢复落定拍：uiState 面板开合/tab 激活异步晚到会翻转归零后的首个按键
 *  语义（面板被恢复态翻回上个用例的 tab），先等一拍再动面板（P-69 同款） */
async function settleRestore(page: import('@playwright/test').Page) {
  await page.waitForTimeout(600)
}

test('面板关闭态 Ctrl+Shift+` 直达新建并激活；已开态继续新建；Ctrl+` 开关不变', async ({ page }) => {
  await openProject(page)
  await settleRestore(page)

  // 归一化：先经 rail 钮开面板落 terminal tab（UI 点击不建终端），等引导恢复
  // 与既有会话列表采纳落定后取基线——面板关闭态 .term-tab 不在 DOM，不可作基线
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  await page.waitForTimeout(500)
  const baseTabs = await page.locator('.term-tab').count()

  // 关面板（UI 关闭钮）：bottomTab 不变，TerminalView 仍挂载，tab 数不变
  await page.locator('.bottom-header button[title="关闭"]').click()
  await expect(page.locator('.term-toolbar')).toBeHidden({ timeout: 3000 })
  await expect(page.locator('.term-tab')).toHaveCount(baseTabs)

  // 关闭态按键：开面板 + 新建 tab 且激活
  await page.keyboard.press('Control+Shift+`')
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.term-tab')).toHaveCount(baseTabs + 1, { timeout: 8000 })
  await expect(page.locator('.term-tab.is-active')).toHaveCount(1)
  await expect(page.locator('.term-tab').last()).toHaveClass(/is-active/)

  // 已开态按键：直达非 toggle——不收面板，继续新建第二枚并激活
  await page.keyboard.press('Control+Shift+`')
  await expect(page.locator('.term-toolbar')).toBeVisible()
  await expect(page.locator('.term-tab')).toHaveCount(baseTabs + 2, { timeout: 8000 })
  await expect(page.locator('.term-tab').last()).toHaveClass(/is-active/)

  // 非 shift Ctrl+`：仍是面板开关（收起，不改 tab 数）
  await page.keyboard.press('Control+`')
  await expect(page.locator('.term-toolbar')).toBeHidden({ timeout: 3000 })
  await expect(page.locator('.term-tab')).toHaveCount(baseTabs + 2)

  // 收在非 terminal tab 再直达：重开面板切到 Git tab（TerminalView 随 v-if
  // 卸载，tab 钮仅面板可见时可点）再收起——覆盖 createNewTerminal 双 nextTick
  // 等 v-if 挂载后再创建的 mount-wait 分支
  await page.locator('[data-testid="rail-terminal"]').click()
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 3000 })
  await page.locator('.bottom-tabs button').filter({ hasText: 'Git' }).click()
  await page.locator('.bottom-header button[title="关闭"]').click()
  await expect(page.locator('.term-toolbar')).toBeHidden({ timeout: 3000 })
  await page.keyboard.press('Control+Shift+`')
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.term-tab')).toHaveCount(baseTabs + 3, { timeout: 8000 })
  await expect(page.locator('.term-tab.is-active')).toHaveCount(1)
})

test('xterm 聚焦态按键直达新建（全局层先于终端面板消化）', async ({ page }) => {
  await openProject(page)
  await settleRestore(page)

  // 归一化到终端 tab 可见：rail 终端钮 toggle 语义覆盖三种恢复态——面板关
  // （开面板落 terminal）/ 开在非 terminal tab（切回 terminal）/ 已就绪（跳过）
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
  if ((await page.locator('.term-tab').count()) === 0) {
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
  }
  await expect(page.locator('.xterm-screen:visible').last()).toBeVisible({ timeout: 8000 })

  // 聚焦终端屏后按键：xterm 不消化该组合，事件冒泡至全局层直达新建
  await page.locator('.xterm-screen:visible').last().click()
  const before = await page.locator('.term-tab').count()
  await page.keyboard.press('Control+Shift+`')
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 8000 })
  await expect(page.locator('.term-tab').last()).toHaveClass(/is-active/)
})
