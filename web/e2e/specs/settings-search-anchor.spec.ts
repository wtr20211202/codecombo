import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 设置搜索行级锚定 E2E（P-20261003-39）：
 *   - 搜「审批模式」→ 通用分区命中并滚动定位到审批模式行 + ~2s 高亮闪烁后自动褪去
 *   - 清空搜索高亮立即清除，锚点不残留
 *   - 无锚点词条（凭据/自动拉取）保持分区级过滤现状：命中分区但不高亮
 *   - 高频分区锚点扩容（P-20261005-1）：终端字号/滚动缓冲、终端字体（外观）、
 *     git 用户名/邮箱、通知声音/免打扰、远端添加行、安全 agent token/审计行——
 *     查询→分区唯一性对账见 __tests__/utils/settingsSearch.test.ts 守卫
 * 全程不改动任何设置值，不点保存，不污染共享实例。
 */

async function openSettings(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
}

// n-input 的 data-testid 落在包裹层 div，真正的输入框在其内部
function searchBox(page: import('@playwright/test').Page) {
  return page.getByTestId('settings-search').locator('input')
}

test('搜「审批模式」滚动定位通用区审批模式行并高亮闪烁，2s 后褪去', async ({ page }) => {
  await openSettings(page)

  // 锚点词并入 haystack：仅通用分区命中且自动落位
  await searchBox(page).fill('审批模式')
  await expect(page.getByTestId('settings-nav-general')).toHaveClass(/active/)
  await expect(page.locator('.settings-nav .nav-item')).toHaveCount(1)

  // 行级锚定：滚动进可视区 + 闪烁类，~2s 后自动褪去
  const row = page.getByTestId('settings-agent-approval-mode')
  await expect(row).toBeInViewport()
  await expect(row).toHaveClass(/anchor-flash/)
  await expect(row).not.toHaveClass(/anchor-flash/, { timeout: 3500 })
})

test('搜「审批超时」复用既有控件 testid 锚定；清空搜索高亮立即清除', async ({ page }) => {
  await openSettings(page)

  await searchBox(page).fill('审批超时')
  await expect(page.getByTestId('settings-nav-general')).toHaveClass(/active/)
  // 该行此前已有 data-testid（P-20261003-45 审批超时输入框），锚点直接复用
  const input = page.getByTestId('settings-approval-timeout-min')
  await expect(input).toBeInViewport()
  await expect(input).toHaveClass(/anchor-flash/)

  // 清空 → 高亮立即清除，恢复全部分区
  await searchBox(page).fill('')
  await expect(page.locator('.anchor-flash')).toHaveCount(0)
  await expect(page.locator('.settings-nav .nav-item')).toHaveCount(15)
})

test('无锚点词条行为不变：命中分区但不高亮不锚定', async ({ page }) => {
  await openSettings(page)

  // 「凭据」命中 Git+安全两分区（均未配锚点）——保持纯分区级过滤现状
  await searchBox(page).fill('凭据')
  await expect(page.locator('.settings-nav .nav-item')).toHaveCount(2)
  await expect(page.locator('.anchor-flash')).toHaveCount(0)

  // 通用区词条「自动拉取」命中但非锚点词 → 通用区落位但无闪烁
  await searchBox(page).fill('自动拉取')
  await expect(page.getByTestId('settings-nav-general')).toHaveClass(/active/)
  await expect(page.locator('.anchor-flash')).toHaveCount(0)
})

// P-20261005-1 高频分区锚点扩容：词条→控件最后一跳补齐主要分区。
// 每个「查询→分区→锚点行」映射先经 __tests__ 唯一性守卫对账，此处断言
// 滚动定位 + 闪烁类出现即锚定生效（不点保存不改任何值）。
test('扩容锚点：终端字号/滚动缓冲/选中即复制直达控件行', async ({ page }) => {
  await openSettings(page)

  await searchBox(page).fill('字体大小')
  await expect(page.getByTestId('settings-nav-terminal')).toHaveClass(/active/)
  const fontSize = page.getByTestId('settings-terminal-font-size')
  await expect(fontSize).toBeInViewport()
  await expect(fontSize).toHaveClass(/anchor-flash/)

  // 连续换词：旧闪烁先褪，新行接管（同一分区内换锚点目标）
  await searchBox(page).fill('滚动缓冲')
  const scrollback = page.getByTestId('settings-terminal-scrollback')
  await expect(scrollback).toBeInViewport()
  await expect(scrollback).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('选中即复制')
  const copyOnSelect = page.getByTestId('settings-terminal-copy-on-select')
  await expect(copyOnSelect).toBeInViewport()
  await expect(copyOnSelect).toHaveClass(/anchor-flash/)
})

test('扩容锚点：搜「终端字体」落外观分区并锚定字体族选择区', async ({ page }) => {
  await openSettings(page)

  await searchBox(page).fill('终端字体')
  await expect(page.getByTestId('settings-nav-appearance')).toHaveClass(/active/)
  const fontCard = page.getByTestId('settings-terminal-font-family')
  await expect(fontCard).toBeInViewport()
  await expect(fontCard).toHaveClass(/anchor-flash/)
})

test('扩容锚点：git 用户名/邮箱行、remote 添加行直达', async ({ page }) => {
  await openSettings(page)

  await searchBox(page).fill('用户名')
  await expect(page.getByTestId('settings-nav-git')).toHaveClass(/active/)
  const userName = page.getByTestId('settings-git-user-name')
  await expect(userName).toBeInViewport()
  await expect(userName).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('邮箱')
  const userEmail = page.getByTestId('settings-git-user-email')
  await expect(userEmail).toBeInViewport()
  await expect(userEmail).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('添加远程')
  await expect(page.getByTestId('settings-nav-remote')).toHaveClass(/active/)
  const remoteAdd = page.getByTestId('settings-remote-add')
  await expect(remoteAdd).toBeInViewport()
  await expect(remoteAdd).toHaveClass(/anchor-flash/)
})

test('扩容锚点：通知声音/免打扰行、安全 agent token/审计行直达', async ({ page }) => {
  await openSettings(page)

  await searchBox(page).fill('免打扰')
  await expect(page.getByTestId('settings-nav-notifications')).toHaveClass(/active/)
  const dnd = page.getByTestId('settings-notification-dnd')
  await expect(dnd).toBeInViewport()
  await expect(dnd).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('声音')
  const sound = page.getByTestId('settings-notification-sound')
  await expect(sound).toBeInViewport()
  await expect(sound).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('审计')
  await expect(page.getByTestId('settings-nav-security')).toHaveClass(/active/)
  const auditRow = page.getByTestId('egress-row-audit')
  await expect(auditRow).toBeInViewport()
  await expect(auditRow).toHaveClass(/anchor-flash/)

  await searchBox(page).fill('agent token')
  const tokenRow = page.getByTestId('egress-row-agent-token')
  await expect(tokenRow).toBeInViewport()
  await expect(tokenRow).toHaveClass(/anchor-flash/)
})
