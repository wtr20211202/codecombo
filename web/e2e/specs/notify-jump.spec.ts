import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 长任务通知跳转闭环 E2E（P-20261001-31）：
 *   1. 部署完成通知 panel:deploy 分发契约：POST /api/notifications 播种与
 *      服务端 notifyTaskDone 成功分支相同形状的通知（action=panel、
 *      payload=deploy），点击直达 设置·远程部署 分区——真实部署成功流依赖
 *      远端 SSH，播种面与克隆段同款（服务端构造由 Go 单测锁定）。
 *      失败部署通知自 P-20261003-289 起主动作改为 agent-fix（交给智能体修复），
 *      真实失败流端到端移至 deploy-agent-fix.spec
 *   2. 克隆成功通知跳转：真实克隆流过重（网络+git 子进程），改经
 *      POST /api/notifications 播种与服务端 notifyCloneDone 相同的通知形状
 *      （projectId/projectName + panel:changes），验证前端 pendingAction
 *      「先切项目再开变更面板」分发契约；服务端构造由 Go 单测锁定
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

async function openNotificationPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('部署完成通知 → 点击直达设置·远程部署分区（panel:deploy）', async ({ page }) => {
  const headers = await unlockHeaders()

  // 播种与服务端 notifyTaskDone 成功分支相同形状的通知（panel:deploy）。
  // 失败分支自 P-20261003-289 起为 agent-fix（真实流见 deploy-agent-fix.spec）
  const seedRes = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'success',
      category: 'task',
      title: '部署完成：e2e-notify-jump · simple_coding',
      body: '',
      action: 'panel',
      actionPayload: 'deploy',
    }),
  })
  expect(seedRes.ok).toBeTruthy()

  await openNotificationPanel(page)
  const row = page.locator('.nc-item').filter({ hasText: '部署完成' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })

  // 点击 → 设置弹窗直达远程部署分区（panel:deploy 分发）
  await row.click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.settings-modal .content-pane:visible .pane-title')).toHaveText('远程部署')
  await expect(page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' })).toHaveClass(/active/)
})

test('克隆成功通知 → 切项目并打开变更面板', async ({ page }) => {
  const headers = await unlockHeaders()

  // 目标项目 id（e2e-restart.sh 预置的 simple-coding 卡片）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id).toBeTruthy()

  // 播种与服务端 notifyCloneDone 相同形状的通知
  const seedRes = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      type: 'success',
      category: 'clone',
      title: '克隆成功',
      body: 'e2e-notify-jump-克隆 已添加到项目列表',
      projectId: proj!.id,
      projectName: 'simple-coding',
      action: 'panel',
      actionPayload: 'changes',
    }),
  })
  expect(seedRes.ok).toBeTruthy()

  await openNotificationPanel(page)
  const row = page.locator('.nc-item').filter({ hasText: '克隆成功' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })

  // 点击 → 变更面板打开（pendingAction：projectId 切项目 + panel:changes）
  await row.click()
  await expect(page.locator('#side-panel .commit-panel')).toBeVisible({ timeout: 10000 })
})
