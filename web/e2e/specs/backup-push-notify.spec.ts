import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 推送备份告警通知 E2E（P-20261003-103）：
 * git-push-origin.sh 推送失败经 POST /api/notifications 告警（error 项）、
 * 恢复后 info 闭环——脚本侧真实 bash 行为无法 e2e（依赖真实 origin 失败
 * 拓扑，与 daily-report 同款理由），本用例播种与脚本完全相同形状的载荷
 * （category git + titleKey/bodyKey/msgParams），锁定前端模板渲染契约
 * （zh-CN 固定语言）。通知经共享实例 API 播种/清理，不残留测试数据
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

// 与 scripts/git-push-origin.sh notif_post 的载荷逐字段同形：
// {"type":"error","category":"git","title":"推送备份失败·N commits 未同步",
//  "titleKey":"backupPush.notify.failed.title","bodyKey":"...failed.body",
//  "msgParams":{"n":N,"branch":"feature/0.0.1"}}
async function seedScriptShapePayload(headers: Record<string, string>): Promise<void> {
  const seed = async (payload: Record<string, unknown>) => {
    const res = await fetch(`${API_BASE}/api/notifications`, { method: 'POST', headers, body: JSON.stringify(payload) })
    expect(res.ok).toBeTruthy()
  }
  await seed({
    type: 'error',
    category: 'git',
    title: '推送备份失败·3 commits 未同步',
    titleKey: 'backupPush.notify.failed.title',
    bodyKey: 'backupPush.notify.failed.body',
    msgParams: { n: 3, branch: 'feature/0.0.1' },
  })
  await seed({
    type: 'info',
    category: 'git',
    title: '推送备份已恢复',
    titleKey: 'backupPush.notify.recovered.title',
    bodyKey: 'backupPush.notify.recovered.body',
    msgParams: { branch: 'feature/0.0.1' },
  })
}

test('推送备份告警：失败 error 项与恢复 info 项均按 i18n 模板渲染', async ({ page }) => {
  const headers = await unlockHeaders()
  await seedScriptShapePayload(headers)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  // error 项：标题走 titleKey 模板（{n} 注入），摘要行走 bodyKey 模板
  const failed = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: '推送备份失败' }).first()
  await expect(failed).toBeVisible({ timeout: 5000 })
  await expect(failed).toContainText('推送备份失败·3 commits 未同步')
  await expect(failed).toContainText('远端备份已落后 3 个提交')

  // info 项：恢复闭环同款模板渲染
  const recovered = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: '推送备份已恢复' }).first()
  await expect(recovered).toBeVisible({ timeout: 5000 })
  await expect(recovered).toContainText('推送备份已恢复')
  await expect(recovered).toContainText('feature/0.0.1 已重新推送成功')
})
