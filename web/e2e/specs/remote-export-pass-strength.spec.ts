import { test, expect, type Page } from '@playwright/test'
import { gotoAndUnlock, fixedLocale, fetchWslHost } from '../../tests/helpers'

/**
 * 凭据导出口令强度提示（P-20261003-101）E2E——回归三条：
 *   1. 弱口令（长度 <12 或单字符类，如 123456）→ 黄色警示「口令过弱，导出文件
 *      可被暴力破解」随输入实时出现；
 *   2. 强口令 → 无警示；
 *   3. 弱口令不阻断：警示在场仍可走完两次口令输入并成功导出（下载事件落定）。
 * 入口走首页远程管理 overlay 的「导出」钮（播种态含 WSL 主机，导出钮可用）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

const WEAK_HINT = '口令过弱，导出文件可被暴力破解'
const WEAK_PASS = '123456'
// 8 位纯数字：满足既有 validate 下限（≥8）但仍属弱口令（<12 + 单字符类）——
// 用于验证「警示不阻断、可继续导出」；警示本身的阈值是 12/字符类，与 8 位下限正交
const WEAK_PASS_EXPORTABLE = '12345678'
const STRONG_PASS = 'Corr3ct-Horse-Battery-9'

/** 打开首页远程管理 overlay 并点出导出口令弹窗（第一次输入） */
async function openExportPassDialog(page: Page) {
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.home-action-btn[title="远程管理"]').click()
  const overlay = page.locator('.remote-console-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await overlay.locator('.remote-header button').filter({ hasText: '导出' }).click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '设置导出文件口令' })
  await expect(dialog).toBeVisible({ timeout: 5000 })
  return dialog
}

test('导出口令强度提示：弱口令黄警示 / 强口令无警示 / 弱口令仍可继续导出', async ({ page }) => {
  test.setTimeout(60000)
  // 导出钮以「存在远程主机记录」为可用前提（头注播种态），记录缺失（跨拓扑
  // 金态无 WSL 域）= 环境边界，按门控 skip（P-20261005-187）
  test.skip(!(await fetchWslHost(BASE)), '远程主机记录未播种（跨拓扑金态无 WSL 域），跳过')
  await fixedLocale(page)
  const dialog = await openExportPassDialog(page)
  const input = dialog.locator('input')
  const hint = dialog.getByText(WEAK_HINT)

  // ① 典型弱口令 123456：警示出现且为黄色（inline style 用主题变量 --accent-yellow）
  await input.fill(WEAK_PASS)
  await expect(hint).toBeVisible()
  await expect(hint).toHaveAttribute('style', /var\(--accent-yellow\)/)

  // ② 强口令（≥12 位 + 多字符类）：警示消失
  await input.fill(STRONG_PASS)
  await expect(hint).toHaveCount(0)

  // ③ 弱口令不阻断：警示在场（8 位纯数字仍命中弱口令）仍可确认 → 确认口令 → 导出下载落定
  await input.fill(WEAK_PASS_EXPORTABLE)
  await expect(hint).toBeVisible()
  await dialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  const confirmDialog = page.locator('.n-dialog').filter({ hasText: '请再次输入口令以确认' })
  await expect(confirmDialog).toBeVisible({ timeout: 5000 })
  await confirmDialog.locator('input').fill(WEAK_PASS_EXPORTABLE)
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 })
  await confirmDialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toMatch(/^remotehosts-export-\d{4}-\d{2}-\d{2}\.json$/)

  // 收尾：关 overlay（防 remoteConsole 视图残留写回服务端 uiState 影响后续用例）
  const overlay = page.locator('.remote-console-overlay')
  if (await overlay.isVisible().catch(() => false)) {
    await overlay.getByRole('button', { name: '关闭' }).click()
    await expect(overlay).toBeHidden()
  }
})
