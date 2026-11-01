import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 今日日报通知 E2E（P-20261001-30）：
 * 定时触发与聚合逻辑无法 e2e（聚合由 Go 单测锁定，Emit 产物形状见
 * server/report/aggregator_test.go），本用例经 POST /api/notifications 播种
 * 与服务端 DailyNotification 相同形状的通知（titleKey/bodyKey/msgParams +
 * projectId + panel:git），锁定前端两段契约：
 *   1. 模板化渲染：通知中心按 i18n key 渲染摘要行，提交主题明细附于其后；
 *   2. 跳转闭环：点击先切项目再打开底部 Git 面板（pendingAction 分发）。
 * 通知经共享实例 API 播种/清理，不残留测试数据
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('日报通知：模板 i18n 渲染，点击切项目并打开 Git 面板', async ({ page }) => {
  const headers = await unlockHeaders()

  // 目标项目（e2e-restart.sh 预置的 simple-coding 卡片）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id).toBeTruthy()

  // 播种与服务端 DailyNotification 相同形状的日报通知
  const seedRes = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'info',
      category: 'system',
      title: 'simple-coding · 今日动态',
      titleKey: 'report.daily.title',
      body: 'feat(report): 今日改动站内日报\nfix(e2e): 播种样例',
      bodyKey: 'report.daily.body',
      msgParams: {
        name: 'simple-coding',
        commits: 2,
        approvalsDone: 1,
        approvalsPending: 0,
        deploysOk: 1,
        deploysFail: 0,
        sessions: 1,
        cmds: 9,
      },
      projectId: proj!.id,
      projectName: 'simple-coding',
      action: 'panel',
      actionPayload: 'git',
    }),
  })
  expect(seedRes.ok).toBeTruthy()

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  const row = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: '今日动态' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  // 摘要行走 i18n 模板（zh-CN 固定语言），提交主题明细原文附后
  await expect(row).toContainText('提交 2 条')
  await expect(row).toContainText('部署 成功 1 / 失败 0')
  await expect(row).toContainText('feat(report): 今日改动站内日报')

  // 点击 → 先切项目再打开底部 Git 面板（pendingAction：projectId + panel:git）
  await row.click()
  await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.bottom-panel .git-panel')).toBeVisible({ timeout: 5000 })
})
