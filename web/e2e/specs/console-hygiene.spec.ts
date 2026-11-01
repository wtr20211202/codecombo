import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 控制台错误扫描：走一遍核心流程（解锁 → 进项目 → 开文件 → 开终端 →
 * 开搜索替换 → 开设置 → 回首页），断言全程无 console error、无 5xx。
 * 广谱探测：能抓到常规断言覆盖不到的运行时异常/失败请求。
 * 已知良性噪声（如 423 解锁前 boot 请求）白名单跳过。
 */

test('核心流程控制台零错误扫描', async ({ page }) => {
  const errors: string[] = []
  const serverErrors: string[] = []
  let unlocked = false

  page.on('console', msg => {
    if (msg.type() === 'error') errors.push(msg.text().slice(0, 200))
  })
  page.on('pageerror', err => errors.push(`pageerror: ${String(err).slice(0, 200)}`))
  page.on('response', resp => {
    if (resp.status() >= 500) serverErrors.push(`${resp.status()} ${resp.url().slice(0, 120)}`)
    // 解锁前 boot 请求 423 是锁定态预期行为
    if (resp.status() === 423 && !unlocked) errors.push(`423-before-unlock ${resp.url().slice(0, 120)}`)
  })

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  unlocked = true

  // 进项目
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(1500)

  // 打开文件树首个文件
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name').first().click()
  await page.waitForTimeout(1200)

  // 开终端
  await page.locator('[data-testid="rail-terminal"]').click()
  await page.waitForTimeout(800)

  // 全工程搜索开关一轮
  await page.keyboard.press('Control+Shift+f')
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 大纲开关一轮
  await page.keyboard.press('Control+Shift+o')
  await page.waitForTimeout(600)
  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)

  // 设置开合一轮
  await page.locator('[data-testid="rail-settings"]').click()
  await page.waitForTimeout(800)
  const close = page.locator('.n-modal.settings-modal .n-base-close')
  if (await close.isVisible().catch(() => false)) {
    await close.click()
    await page.waitForTimeout(500)
  }

  expect(errors, `console errors:\n${errors.join('\n')}`).toHaveLength(0)
  expect(serverErrors, `5xx:\n${serverErrors.join('\n')}`).toHaveLength(0)
})
