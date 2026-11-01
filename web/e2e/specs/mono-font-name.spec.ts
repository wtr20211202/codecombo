import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 自定义等宽字体名 E2E（P-20261005-227）：
 *   ① 设置·外观·终端字体分区「等宽字体名」输入 → 预览行实时随动（未保存也所见即所得）
 *   ② 保存 → `--font-mono-lead` 前插段落 html 内联，全局等宽消费面（CSS var 级联）
 *      computed --font-mono 链含用户值且内置栈仍在尾随回退；font-settings 持久化
 *   ③ xterm 消费处（内联 fontFamily、不走 CSS var 的那条轨）：创建期读组合栈
 *      含用户值（seed localStorage 直达），运行期清空随动回预设栈（watcher 轨）
 *   ④ 清空保存 → 回内置栈（lead 内联移除、computed 链不含用户值）
 * 字体名用本地必然不存在的 'ZZZ Test Mono'——CSS 天然回退保证渲染不炸，顺带
 * 验证「幻觉字体名」不产生布局事故的承诺。断言走 getComputedStyle 真实级联结果，
 * 不依赖 UI 截图。
 */

const CUSTOM = 'ZZZ Test Mono'

/** 进入项目页（与 term-theme-follow 同款开法；密码提醒遮罩先收起） */
async function gotoProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 打开设置弹窗并落外观分区（settings-remember-tab 记忆上次的分区，显式点一次保稳） */
async function openAppearanceSettings(page: Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await modal.locator('.settings-nav .nav-item').filter({ hasText: '外观' }).click()
  await expect(page.getByTestId('settings-terminal-font-family')).toBeVisible()
  return modal
}

/** 保存并等弹窗关闭（handleSave 全部分区落盘后自动关，在途窗口不能补 Esc） */
async function saveAndClose(page: Page, modal: ReturnType<Page['locator']>) {
  await modal.locator('.settings-footer button').filter({ hasText: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })
}

/** 预览行 computed font-family（--mono-preview-family 绑定 pending 值的级联结果） */
function previewFamily(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="settings-mono-font-preview"]')
    return el ? getComputedStyle(el).fontFamily : ''
  })
}

/** html :root 上生效的 --font-mono computed 值（var() 替换后的完整回退链） */
function computedMonoChain(page: Page): Promise<string> {
  return page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--font-mono'))
}

/** xterm 树内是否有元素的 computed font-family 含指定字体（xterm 内联 fontFamily
 *  落在渲染容器/测宽元素上，渲染器无关的观察面） */
function xtermUsesFont(page: Page, name: string): Promise<boolean> {
  return page.evaluate((n) => {
    const els = document.querySelectorAll('.xterm, .xterm *')
    for (const el of els) {
      if (getComputedStyle(el).fontFamily.includes(n)) return true
    }
    return false
  }, name)
}

test.describe('设置页输入与预览（CSS var 轨）', () => {
  test('输入实时进预览；保存落 lead + font-settings + 全局链；清空回内置栈', async ({ page }) => {
    await gotoProject(page)

    // 初始态：预览行走内置栈（链首 JetBrains Mono），无用户值
    let modal = await openAppearanceSettings(page)
    await expect(page.getByTestId('settings-mono-font-ligature-tip')).toBeVisible()
    expect(await previewFamily(page)).toContain('JetBrains Mono')

    // 输入（未保存）：预览行实时随动 = 所见即所得
    const input = page.getByTestId('settings-mono-font-name').locator('input')
    await input.fill(CUSTOM)
    await expect.poll(() => previewFamily(page)).toContain(CUSTOM)
    // 未保存：全局链与持久层都不动
    expect(await computedMonoChain(page)).not.toContain(CUSTOM)

    // 保存：html 内联 lead 前插段 + font-settings 持久化 + computed 链含用户值且内置栈仍回退
    await saveAndClose(page, modal)
    expect(await page.evaluate(() => localStorage.getItem('font-settings'))).toContain(`"monoFontName":"${CUSTOM}"`)
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-mono-lead'))).toContain(`'${CUSTOM}'`)
    const chain = await computedMonoChain(page)
    expect(chain).toContain(CUSTOM)
    expect(chain).toContain('JetBrains Mono')

    // 清空保存：回内置栈（lead 内联移除、computed 链不含用户值）
    modal = await openAppearanceSettings(page)
    await expect(page.getByTestId('settings-mono-font-name').locator('input')).toHaveValue(CUSTOM)
    await page.getByTestId('settings-mono-font-name').locator('input').fill('')
    await saveAndClose(page, modal)
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--font-mono-lead'))).toBe('')
    expect(await computedMonoChain(page)).not.toContain(CUSTOM)
    expect(await page.evaluate(() => localStorage.getItem('font-settings'))).toContain('"monoFontName":""')
  })
})

test.describe('xterm 消费轨（内联 fontFamily）', () => {
  test('seed 自定义名 → 新建终端字体链含用户值；运行期清空随动回预设栈', async ({ page }) => {
    await fixedLocale(page)
    await page.addInitScript((name) => {
      localStorage.setItem('font-settings', JSON.stringify({ monoFontName: name }))
    }, CUSTOM)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
    try {
      await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
      await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
    } catch { /* 未出现则继续 */ }

    // 打开终端面板 + 建终端 tab（同 terminal-font-gesture 归一化开法）
    await page.waitForTimeout(600)
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
    await expect(page.locator('.xterm-screen:visible').last()).toBeVisible({ timeout: 20000 })

    // 创建期组合栈生效：xterm 树内 font-family 含用户值（load 链 sanitize 后前插）
    await expect.poll(() => xtermUsesFont(page, CUSTOM)).toBe(true)

    // 运行期清空（watcher 轨）：保存后 xterm 字体链随动回预设栈
    const modal = await openAppearanceSettings(page)
    await page.getByTestId('settings-mono-font-name').locator('input').fill('')
    await saveAndClose(page, modal)
    await expect.poll(() => xtermUsesFont(page, CUSTOM)).toBe(false)
    await expect.poll(() => xtermUsesFont(page, 'JetBrains Mono')).toBe(true)
  })
})
