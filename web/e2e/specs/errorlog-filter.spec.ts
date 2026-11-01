import { test, expect } from '@playwright/test'
import { fixedLocale, unlockIfNeeded, waitForAppReady, projectCardByName } from '../../tests/helpers'

/**
 * 错误日志搜索与类别过滤（P-20261002-62）E2E
 *
 * 造错方式：拦截项目页启动必发的三个请求，让 axios 拦截器把三类错误写入
 * 错误日志（http.ts 对所有失败请求「永远写 Console」，silent 也不例外）：
 *   - GET /api/ahead-behind        → fulfill 500 {"error":"SCSEED-SRV-ZX91"} → 服务端
 *     （批量端点失败非 404 时不逐项目扇出；rawMessage 即 error 字段）
 *   - GET /api/settings            → fulfill 404 {"error":"SCSEED-NF-QK77"} → 未找到
 *   - GET /api/projects/:id/status → abort → 网络
 *
 * 每条路由只让首次请求失败（single-failure）：实测 settings / status 在进项目时
 * 会被拉取不止一次，后续命中一律放行良性 200，保证每类恰一条种子、总数确定。
 * 路由在首页稳定后、点项目卡前注册——首页自身的 ahead-behind/settings 拉取
 * 已在注册前完成，不会混入额外条目。
 */

const SRV_MARKER = 'SCSEED-SRV-ZX91'
const NF_MARKER = 'SCSEED-NF-QK77'

/** 进项目页（路上拦截三个请求种下三类错误，每类恰一条）并打开控制台错误子标签 */
async function openErrorList(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await page.goto('/')
  await page.waitForSelector('body')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.waitForSelector('.project-card', { timeout: 8000 })
  // 首页自身的 ahead-behind / settings 拉取先落地，再注册拦截路由
  await page.waitForTimeout(1000)

  let aheadBehindFails = 0
  let settingsFails = 0
  let statusFails = 0
  await page.route('**/api/ahead-behind', route => {
    if (aheadBehindFails++ === 0) {
      route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: SRV_MARKER }) })
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })
  await page.route('**/api/settings', route => {
    if (settingsFails++ === 0) {
      route.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: NF_MARKER }) })
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    }
  })
  await page.route('**/api/projects/*/status', route => {
    if (statusFails++ === 0) {
      route.abort('failed')
    } else {
      route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    }
  })

  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project', { timeout: 10000 })
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击（panel-registry 先例）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }

  // 底部面板可能被持久化布局收起：先归一化打开（Ctrl+` 幂等切换）
  const consoleTab = page.locator('.bottom-tabs button').filter({ hasText: '控制台' })
  if (!(await consoleTab.isVisible().catch(() => false))) {
    await page.keyboard.press('Control+`')
    await consoleTab.waitFor({ state: 'visible', timeout: 5000 })
  }
  await consoleTab.click()
  await page.locator('.sub-tab').filter({ hasText: '错误' }).click()

  // 三类种子各一条到齐
  const rows = page.locator('.log-row')
  await expect(rows.filter({ hasText: '服务器异常' })).toHaveCount(1, { timeout: 10000 })
  await expect(rows.filter({ hasText: '资源不存在' })).toHaveCount(1, { timeout: 10000 })
  await expect(rows.filter({ hasText: '网络连接异常' })).toHaveCount(1, { timeout: 10000 })
}

test.describe('错误日志搜索与类别过滤', () => {
  test('搜索关键词过滤：剩 1 条 + n/总数计数 + 清空恢复全量', async ({ page }) => {
    await openErrorList(page)

    const rows = page.locator('.log-row')
    const total = await rows.count()
    expect(total).toBeGreaterThanOrEqual(3)

    const search = page.locator('.errorlog-filter-input input')
    // 关键词只出现在服务端条目的 rawMessage 中（折叠态文案不含它）——验证消息子串匹配
    await search.fill(SRV_MARKER)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('服务器异常')
    await expect(page.locator('.errorlog-filter-count')).toHaveText(`1 / ${total}`)

    // 输入框内按键不触发行展开（Enter/Space 落在输入框，无行进入展开态）
    await search.press('Enter')
    await search.press('Space')
    await expect(rows).toHaveCount(1)
    await expect(page.locator('.raw-wrap')).toHaveCount(0)

    // 清空恢复全量，计数随之消失
    await search.fill('')
    await expect(rows).toHaveCount(total)
    await expect(page.locator('.errorlog-filter-count')).toHaveCount(0)
  })

  test('类别徽标即过滤器：点选仅看该类别，再点取消且不触发展开', async ({ page }) => {
    await openErrorList(page)

    const rows = page.locator('.log-row')
    const total = await rows.count()
    const netRow = rows.filter({ hasText: '网络连接异常' })
    await expect(netRow).toHaveCount(1)

    // 点击网络条目的类别徽标 → 仅剩网络类别（计数分子=该类别条数）
    await netRow.locator('.cat-badge').click()
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('网络连接异常')
    await expect(netRow.locator('.cat-badge')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.errorlog-filter-count')).toHaveText(`1 / ${total}`)
    // 徽标点击阻断行冒泡：不触发展开
    await expect(page.locator('.raw-wrap')).toHaveCount(0)

    // 再点取消 → 恢复全量
    await netRow.locator('.cat-badge').click()
    await expect(rows).toHaveCount(total)
    await expect(page.locator('.errorlog-filter-count')).toHaveCount(0)
  })

  test('展开态跨过滤保持 + 无匹配空态', async ({ page }) => {
    await openErrorList(page)

    const rows = page.locator('.log-row')
    const total = await rows.count()
    const srvRow = rows.filter({ hasText: '服务器异常' }).first()

    // 展开服务端条目（点文案区，避开徽标），rawMessage 可见
    await srvRow.locator('.user-msg').click()
    await expect(srvRow.locator('.raw')).toContainText(SRV_MARKER)

    // 搜索只命中「未找到」条目 → 服务端条目被隐藏
    const search = page.locator('.errorlog-filter-input input')
    await search.fill(NF_MARKER)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).toContainText('资源不存在')

    // 清空搜索 → 服务端条目恢复且仍处于展开态
    await search.fill('')
    await expect(rows).toHaveCount(total)
    await expect(srvRow.locator('.raw')).toContainText(SRV_MARKER)

    // 无匹配空态 + 0/总数计数
    await search.fill('SCSEED-NO-SUCH-KEYWORD')
    await expect(rows).toHaveCount(0)
    await expect(page.getByText('无匹配错误')).toBeVisible()
    await expect(page.locator('.errorlog-filter-count')).toHaveText(`0 / ${total}`)

    await search.fill('')
    await expect(rows).toHaveCount(total)
  })
})
