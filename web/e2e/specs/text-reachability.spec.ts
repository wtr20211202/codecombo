import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 截断文本可达性（P-20261019-9）：
 * - 提交搜索 / 目录历史占位符在输入框内容宽内完整显示（audit 原态 84 vs 125、
 *   110 vs 116 两处裁字）
 * - 项目选择器 overlay 分支名、顶栏分支胶囊、提交 refs 等 ellipsis 元素补 title
 * - 远程仓库 URL title 含完整地址，点击复制走 copyText 链并反馈
 * 种子项目 simple-coding 即仓库根：当前分支名与 origin 远程 URL 常态长于展示
 * 宽度（audit 原态分支 122 vs 171、URL 91 vs 212），天然复现「截断」形态，
 * 无需额外夹具；用例只读 + 写剪贴板，不改服务端状态。
 */

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** 归一化打开底部 Git 面板（uiState 跨用例共享，可能已开/在其他 tab） */
async function openGitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible({ timeout: 5000 })
}

/**
 * 占位符完整显示断言：用同字体离屏文本量出自然宽度，对比 input 内容盒宽
 * （clientWidth 含 padding，减左右 padding 后即 placeholder 可用宽度）。
 * 输入框内容溢出不会改变 scrollWidth，Canvas/离屏 span 是该场景的可测面。
 */
async function expectPlaceholderFits(page: Page, placeholder: string) {
  const input = page.getByPlaceholder(placeholder, { exact: true })
  await expect(input).toBeVisible()
  const dims = await input.evaluate((el) => {
    const input = el as HTMLInputElement
    const cs = getComputedStyle(input)
    const probe = document.createElement('span')
    probe.textContent = input.placeholder
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;white-space:nowrap;visibility:hidden'
    probe.style.font = cs.font
    probe.style.letterSpacing = cs.letterSpacing
    document.body.appendChild(probe)
    const textWidth = probe.getBoundingClientRect().width
    probe.remove()
    return {
      textWidth,
      contentWidth: input.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight),
    }
  })
  expect(dims.textWidth, `占位符「${placeholder}」应完整显示`).toBeLessThanOrEqual(dims.contentWidth)
}

test('提交面板两处占位符完整显示；提交 refs 截断有 title', async ({ page }) => {
  await enterProject(page)
  await openGitPanel(page)

  await expectPlaceholderFits(page, '搜索提交…')
  await expectPlaceholderFits(page, '目录历史 (src/)')

  // refs 在行内 max-width 40% 截断，悬停 title 看全
  const refs = page.locator('.commit-refs').first()
  await expect(refs).toBeVisible()
  const refsTitle = await refs.getAttribute('title')
  expect(refsTitle?.trim()).toBeTruthy()
})

test('项目选择器 overlay 分支名与顶栏胶囊 name 均有全名 title', async ({ page }) => {
  await enterProject(page)
  // 项目列表/当前分支回填完成后选择器标签才带括号分支段（防读到空态「无分支」）
  await expect(page.locator('.header-project-select')).toContainText('(', { timeout: 5000 })

  // 顶栏胶囊：分支名 max-width 140px ellipsis，title = 分支全名
  const capsuleName = page.locator('.branch-capsule .capsule-name')
  await expect(capsuleName).toBeVisible()
  const branchName = (await capsuleName.textContent())?.trim() || ''
  expect(branchName).toBeTruthy()
  await expect(capsuleName).toHaveAttribute('title', branchName)

  // 选择器 overlay：分支段（括号包裹）title = 分支全名，项目名段也有 title
  await page.locator('.header-project-select').click()
  const option = page.locator('.n-base-select-option').filter({ hasText: 'simple-coding' }).first()
  await expect(option).toBeVisible({ timeout: 5000 })
  const branchSpan = option.locator('span[title]').filter({ hasText: '(' }).first()
  await expect(branchSpan).toHaveAttribute('title', branchName)
  const projectSpan = option.locator('span[title]').filter({ hasText: 'simple-coding' }).first()
  await expect(projectSpan).toHaveAttribute('title', /simple-coding/)
})

test('远程仓库 URL 可悬停看全且点击复制到剪贴板', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await enterProject(page)
  await openGitPanel(page)

  const urlEl = page.locator('.remote-entry .remote-url-inline').first()
  await expect(urlEl).toBeVisible({ timeout: 5000 })
  const url = (await urlEl.textContent())?.trim() || ''
  expect(url).toBeTruthy()

  // title 同时承载完整 URL 与复制动作提示
  const title = (await urlEl.getAttribute('title')) || ''
  expect(title).toContain(url)
  expect(title).toContain('复制')

  await urlEl.click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 3000 })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(url)
})
