import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 导出中心（P-20261003-266）E2E：
 *   1. 入口聚合：命令面板「导出中心」打开聚合面板——已落地域（会话/部署/审计/
 *      变更）各带「前往」，未落地域（分享归档）占位禁用
 *   2. 跳对应域：会话 → agent 管理页；审计/部署 → 设置对应分区；变更 → 侧栏变更视图
 *   3. 最近导出记录：执行一次审计 CSV 导出后，记录区出现「导出审计 CSV」——
 *      复用既有审计动作（不新增落盘）的定案在此兑现
 */

/** 命令面板打开导出中心（fleet-notify-overview 同款动线） */
async function openExportCenter(page: Page) {
  await page.keyboard.press('Control+Shift+p')
  await page.locator('.palette input, [class*="palette"] input').first().waitFor({ state: 'visible', timeout: 5000 })
  await page.keyboard.type('导出中心')
  await page.waitForTimeout(400)
  await page.keyboard.press('Enter')
  const modal = page.locator('[data-testid="export-center-modal"]')
  await expect(modal).toBeVisible({ timeout: 8000 })
  return modal
}

test('导出中心聚合：已落地域可前往，未落地域占位', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)
  const modal = await openExportCenter(page)

  // 五域全部聚合呈现（注册表 EXPORT_DOMAINS 渲染序）
  for (const id of ['session', 'deploy', 'audit', 'changes', 'shareArchive']) {
    await expect(modal.getByTestId(`export-center-domain-${id}`)).toBeVisible()
  }
  // 已落地四域：各带「前往」按钮
  for (const id of ['session', 'deploy', 'audit', 'changes']) {
    await expect(modal.getByTestId(`export-center-go-${id}`)).toBeVisible()
  }
  // 未落地域：占位标记、无前往按钮（渐进接线——入口随后补）
  await expect(modal.getByTestId('export-center-placeholder-shareArchive')).toBeVisible()
  await expect(modal.getByTestId('export-center-go-shareArchive')).toHaveCount(0)
})

test('前往跳对应域：会话 → agent 管理页', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)
  const modal = await openExportCenter(page)

  await modal.getByTestId('export-center-go-session').click()
  // 跳转同时收起导出中心（面板 emit update:show(false)）
  await expect(page.locator('[data-testid="export-center-modal"]')).toHaveCount(0, { timeout: 5000 })
  // agent docked 管理页打开（空态引导可见即可，不依赖任何会话存在）
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
})

test('前往跳对应域：审计/部署 → 设置分区；变更 → 侧栏变更视图', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)

  // 审计 → 设置·安全（AuditLogPane 审计 CSV 导出所在分区）
  const modal = await openExportCenter(page)
  await modal.getByTestId('export-center-go-audit').click()
  await expect(page.getByTestId('settings-pane-security')).toBeVisible({ timeout: 8000 })
  await page.locator('.settings-close').click()
  await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })

  // 部署 → 设置·远程部署（部署日志 txt 下载所在分区）
  const modal2 = await openExportCenter(page)
  await modal2.getByTestId('export-center-go-deploy').click()
  await expect(page.getByTestId('settings-pane-deploy')).toBeVisible({ timeout: 8000 })
  await page.locator('.settings-close').click()
  await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })

  // 变更 → 侧栏变更视图（导出补丁下拉所在）
  const modal3 = await openExportCenter(page)
  await modal3.getByTestId('export-center-go-changes').click()
  await expect(page.getByTestId('commit-panel')).toBeVisible({ timeout: 8000 })
})

test('最近导出记录：复用既有审计动作（审计 CSV 导出后出现在记录区）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/project`)

  // 先执行一次真实导出（设置·安全·审计日志·导出 CSV——服务端在 CSV 构建后入账）
  // 活动栏设置按钮走语义锚点（「设置」字面名在主区另有同名钮，strict mode 双中）
  await page.getByTestId('rail-settings').click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
  // 等 download 事件 = 服务端已完成 CSV 构建；入账在构建之后——事件到达即
  // 保证「导出审计 CSV」记录已落（audit-log.spec 同款确定性手法）
  await Promise.all([
    page.waitForEvent('download', { timeout: 15000 }),
    page.getByTestId('audit-export').click(),
  ])
  // 导出成功即关闭设置，动作已入账（audit-log.spec 同款链路）
  await page.locator('.settings-close').click()
  await expect(page.locator('.settings-modal')).toHaveCount(0, { timeout: 5000 })

  // 导出中心记录区出现「导出审计 CSV」（最新事件置顶；标签走 audit.action 词条）
  const modal = await openExportCenter(page)
  const rows = modal.locator('.ec-recent-row')
  await expect(rows.filter({ hasText: '导出审计 CSV' }).first()).toBeVisible({ timeout: 8000 })
  // 非导出动作不混入（过滤集合 = EXPORT_AUDIT_ACTIONS 导出族）
  const texts = await rows.allTextContents()
  for (const line of texts) {
    expect(line).not.toContain('解锁')
    expect(line).not.toContain('登录')
  }
})
