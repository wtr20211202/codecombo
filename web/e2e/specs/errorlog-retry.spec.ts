import { test, expect } from '@playwright/test'
import { fixedLocale, unlockIfNeeded, waitForAppReady, projectCardByName } from '../../tests/helpers'

/**
 * 错误中心 GET 失败原地重试（P-20261003-179）E2E
 *
 * 造错方式（同 errorlog-filter 的拦截口径，让 axios 拦截器把失败写入错误日志）：
 *   - GET /api/projects/:id/status → 首次 abort（网络层失败）→ 幂等 GET 附带重试
 *     配置；行头「重试」点击后原地重放（后续命中放行 200）→ 原条目就地转「已恢复」，
 *     不新增条目（重放成功不重复入账）。
 *   - POST /api/terminals → abort（空态「新建终端」按钮触发）→ 非幂等方法不提供
 *     重试钮（安全边界：重放会重复副作用）。
 *
 * status 在进项目时会被拉取不止一次（errorlog-filter 实测），故按调用计数只让
 * 首次失败、后续一律放行，保证种子确定性。
 */

// 底部面板切到控制台页签并选中「错误」子标签（ConsoleView 因 v-if 重挂载后
// subTab 复位，重进需重选；页面可能先被持久化布局收起：Ctrl+` 幂等归一化打开）
async function openConsoleErrors(page: import('@playwright/test').Page): Promise<void> {
  const consoleTab = page.locator('[data-testid="bottom-tab-console"]')
  if (!(await consoleTab.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+`')
    await consoleTab.waitFor({ state: 'visible', timeout: 5000 })
  }
  await consoleTab.click()
  await page.locator('.sub-tab').filter({ hasText: '错误' }).click()
}

/** 进项目页（路上注册好拦截路由后点卡）并停在控制台错误子标签，返回错误行 locator */
async function openErrorList(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await fixedLocale(page)
  await page.goto('/')
  await page.waitForSelector('body')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.waitForSelector('.project-card', { timeout: 8000 })
  // 首页自身的拉取先落地，再注册拦截路由（errorlog-filter 同款时序）
  await page.waitForTimeout(1000)

  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击（panel-registry 先例）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }

  await openConsoleErrors(page)
  return page.locator('.log-row')
}

test.describe('错误中心 GET 失败原地重试', () => {
  test('GET 失败行头重试钮：点击原地重放成功 → 原条目就地转已恢复，不新增条目', async ({ page }) => {
    let statusCalls = 0
    await page.route('**/api/projects/*/status', route => {
      if (statusCalls++ === 0) {
        route.abort('failed')
      } else {
        route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
      }
    })

    const rows = await openErrorList(page)

    // 种子：/status 网络层失败恰好一条，行头带重试钮、无已恢复标记
    const statusRow = rows.filter({ hasText: '/status' })
    await expect(statusRow).toHaveCount(1, { timeout: 10000 })
    await expect(statusRow.locator('[data-testid="errorlog-retry"]')).toHaveCount(1)
    await expect(statusRow.locator('[data-testid="errorlog-recovered"]')).toHaveCount(0)

    // 重试钮阻断行冒泡：点击不触发行展开
    await statusRow.locator('[data-testid="errorlog-retry"]').click()
    await expect(statusRow.locator('.raw-wrap')).toHaveCount(0)

    // 原地重放成功：原条目就地转「已恢复」，重试钮让位；成功重放不重复入账
    await expect(statusRow.locator('[data-testid="errorlog-recovered"]')).toHaveCount(1, { timeout: 10000 })
    await expect(statusRow.locator('[data-testid="errorlog-retry"]')).toHaveCount(0)
    await expect(statusRow).toContainText('已恢复')
    await expect(statusRow).toHaveCount(1)
  })

  test('POST 失败无重试钮（非幂等方法安全边界）', async ({ page }) => {
    await page.route('**/api/terminals', route => {
      if (route.request().method() === 'POST') {
        route.abort('failed')
      } else {
        route.continue()
      }
    })

    const rows = await openErrorList(page)

    // 触发 POST /api/terminals：底部终端页签空态「新建终端」按钮（种子数据面无会话）
    await page.locator('[data-testid="bottom-tab-terminal"]').click()
    await page.getByRole('button', { name: '新建终端' }).first().click()

    // ConsoleView 因 v-if 已重挂载（subTab 复位），回到错误子标签再断言
    await openConsoleErrors(page)

    // POST 失败入账，但行头无重试钮（安全边界），也无已恢复标记
    const postRow = rows.filter({ hasText: '/terminals' }).filter({ hasText: 'POST' })
    await expect(postRow).toHaveCount(1, { timeout: 10000 })
    await expect(postRow.locator('[data-testid="errorlog-retry"]')).toHaveCount(0)
    await expect(postRow.locator('[data-testid="errorlog-recovered"]')).toHaveCount(0)
  })
})
