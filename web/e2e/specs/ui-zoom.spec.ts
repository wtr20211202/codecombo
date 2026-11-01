import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 界面缩放（P-20261002-2）E2E：外观设置切档（90/100/110/125%）→ 根元素
 * html { zoom: var(--ui-zoom) } 生效 → 元素视觉尺寸同步缩放 → localStorage
 * 持久化（刷新后保持，跨设备各自记忆）→ 125% 下 fixed 定位弹层（命令面板）
 * 与终端 xterm 仍正常。zoom 档位只存浏览器 localStorage，服务端零状态，
 * 共享实例无污染；Playwright 每用例独立 context，用例间档位互不泄漏。
 */

const ZOOM_GROUP_LABEL = '界面缩放'

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
}

async function openAppearance(page: import('@playwright/test').Page) {
  await enterProject(page)
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不再依赖导航序下标
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const group = page.locator('.settings-content .form-group', { hasText: ZOOM_GROUP_LABEL })
  await expect(group).toBeVisible({ timeout: 3000 })
  return group
}

/** 选档 + 底部保存：各分区 save 走完后弹窗自动关闭 */
async function pickZoomAndSave(page: import('@playwright/test').Page, group: import('@playwright/test').Locator, pct: string) {
  await group.locator('.n-radio-button', { hasText: pct }).click()
  await page.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
}

function rootZoom(page: import('@playwright/test').Page) {
  // computed zoom 在 Chromium 是字符串（"1.25"），统一转数值比较
  return page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).zoom))
}

test('切 125% 后根元素 zoom 生效且元素视觉尺寸同步放大', async ({ page }) => {
  const group = await openAppearance(page)

  // 基准：默认 100% 时固定宽设置卡片（width: 880px）
  const card = page.locator('.settings-card')
  const before = await card.boundingBox()
  expect(before).not.toBeNull()

  await pickZoomAndSave(page, group, '125%')

  // 根元素 zoom 样式 + --ui-zoom 变量双断言
  expect(await rootZoom(page)).toBeCloseTo(1.25)
  const cssVar = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--ui-zoom').trim())
  expect(cssVar).toBe('1.25')

  // 视觉尺寸：重开设置弹窗量同一元素，宽度 ≈ 1.25×（expect.poll 吸收弹窗过渡动画）
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await expect.poll(async () => {
    const after = await card.boundingBox()
    return after && before ? after.width / before.width : 0
  }).toBeCloseTo(1.25, 1)
})

test('刷新后档位保持（localStorage 持久化，各设备各自记忆）', async ({ page }) => {
  const group = await openAppearance(page)
  await pickZoomAndSave(page, group, '110%')
  expect(await rootZoom(page)).toBeCloseTo(1.1)

  // 刷新走完整 boot 链（App.vue setup 恢复档位并注入变量）
  await page.reload()
  await enterProject(page)
  expect(await rootZoom(page)).toBeCloseTo(1.1)
})

test('未保存丢弃后档位不变（pending 语义，不即时生效）', async ({ page }) => {
  const group = await openAppearance(page)

  // 只点档位不保存 → Esc → 丢弃并关闭
  await group.locator('.n-radio-button', { hasText: '125%' }).click()
  await page.keyboard.press('Escape')
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await dialog.getByRole('button', { name: '丢弃并关闭' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  expect(await rootZoom(page)).toBeCloseTo(1)
})

test('125% 下 fixed 弹层（命令面板）与终端 xterm 正常', async ({ page }) => {
  const group = await openAppearance(page)
  await pickZoomAndSave(page, group, '125%')
  expect(await rootZoom(page)).toBeCloseTo(1.25)

  // fixed 定位弹层：zoom 坐标标准化后命令面板照常打开可输入
  await page.keyboard.press('Control+k')
  const paletteInput = page.locator('.palette-input input')
  await expect(paletteInput).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(paletteInput).toBeHidden({ timeout: 3000 })

  // 终端：zoom 下 xterm canvas 就绪可渲染（fit 尺寸链路不崩）。
  // 面板开合状态经服务端 uiState 跨页面恢复（继承自同实例其他用例），
  // 单次点击非确定性——与 terminal-restart 同款循环归一化到工具条可见
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(800)
  }
  // 显式新建 tab 并激活：新内容置于 DOM 尾部顶层，等 shell 引导完成再断言
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(3500)
  await page.locator('.term-tab').last().click()
  const screen = page.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 15000 })
  const box = await screen.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.height).toBeGreaterThan(0)
})
