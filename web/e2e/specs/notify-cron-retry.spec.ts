import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务发起失败通知一键重试 E2E（P-20261006-14，失败态行动化对称）：
 * 通知中心 cron-retry 动作条目（行内「一键重试」按钮）点击 → 既有试跑端点
 * POST /api/agent-crons/:id/run 重新发起 → agent 会话出现（任务重跑）+
 * 成功 toast（试跑同族文案）。
 *
 * 真实发起失败流依赖端口抖动/临时目录问题，不可稳定制造——通知经共享实例
 * API 播种与服务端 notifyLaunchFailed 落档相同形状（action='cron-retry' +
 * payload=JSON {cronId,slot}；服务端构造由 Go 单测锁定：module_test.go
 * TestRunDue_FailureRecordedAndNotified / TestRunNow_FailurePayloadStampsNow）。
 * 任务以 enabled:false 创建：调度巡检跳过停用任务（runDue 首闸），试跑端点
 * 不设启停闸——重跑仅由本次点击驱动，判定无调度并发干扰。任务与会话经共享
 * 实例 API 清理，不残留测试数据
 */

const CRON_NAME = `e2e-cron-retry-${Date.now()}`

interface CronItem { id?: string; name?: string }
interface SessionInfo { id?: string; name?: string; kind?: string }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanup() {
  const headers = await unlockHeaders()
  // 清本前缀任务（重跑遗留）
  const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  const crons = ((await listRes.json()) as { data?: CronItem[] }).data || []
  for (const c of crons) {
    if (c.name?.startsWith('e2e-cron-retry-') && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  // 清同名会话
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith('e2e-cron-retry-') && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers }).catch(() => {})
}

test.describe('cron failure notification one-click retry', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('失败通知 → 点一键重试 → 任务重跑（agent 会话出现）+ 成功 toast', async ({ page }) => {
    test.setTimeout(90_000)
    await cleanup()
    const headers = await unlockHeaders()

    // 停用任务（调度器跳过，重跑只由重试点击驱动）
    const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: CRON_NAME,
        hour: 3,
        minute: 30,
        weekdays: [],
        runtime: 'shell',
        prompt: `echo ${CRON_NAME}`,
        dir: '',
        enabled: false,
        missCatchUp: false,
      }),
    })
    expect(createRes.ok).toBeTruthy()
    const created = ((await createRes.json()) as { data?: CronItem }).data
    expect(created?.id).toBeTruthy()

    // 播种与服务端 notifyLaunchFailed 落档相同形状的通知（titleKey 模板形态 +
    // cron-retry 动作，payload=JSON {cronId,slot}）
    const seedRes = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'error',
        category: 'task',
        titleKey: 'agentcron.notify.launchFailed.title',
        bodyKey: 'agentcron.notify.launchFailed.body',
        title: '定时任务发起失败',
        body: `${CRON_NAME}: launch probe failure`,
        msgParams: { name: CRON_NAME, error: 'launch probe failure' },
        action: 'cron-retry',
        actionPayload: JSON.stringify({ cronId: created!.id, slot: new Date().toISOString() }),
      }),
    })
    expect(seedRes.ok).toBeTruthy()

    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

    // 失败态行动化：条目带行内「一键重试」按钮（actionInlineLabel 登记）
    const row = page.locator('.nc-item').filter({ hasText: CRON_NAME }).first()
    await expect(row).toBeVisible({ timeout: 5000 })
    const retryBtn = row.locator('[data-testid^="notif-action-"]')
    await expect(retryBtn).toHaveText('一键重试')

    // 点击 → pendingAction 分发 cronRetry → 试跑端点重新发起
    await retryBtn.click()
    await expect(page.locator('.n-message').filter({ hasText: '已发起，正在打开智能体终端' })).toBeVisible({ timeout: 10000 })

    // 任务重跑证据：agent 会话出现（会话名 = 任务名，与调度触发同链）
    let sessionId = ''
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline && !sessionId) {
      const res = await fetch(`${API_BASE}/api/terminals`, { headers })
      const sessions = ((await res.json()) as { data?: SessionInfo[] }).data || []
      const hit = sessions.find(s => s.name === CRON_NAME && s.kind === 'agent')
      if (hit?.id) sessionId = hit.id
      else await page.waitForTimeout(1000)
    }
    expect(sessionId, 'retry should relaunch the task via the run endpoint').toBeTruthy()

    // 运行期事实随行：任务 lastRunAt/lastResult 被本次重试翻写（任务面板
    // 刷新联动读取的就是这份数据面）
    const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
    const items = ((await listRes.json()) as { data?: Array<CronItem & { lastResult?: string; lastRunAt?: string }> }).data || []
    const mine = items.find(c => c.id === created!.id)
    expect(mine?.lastResult).toBe('launched')
    expect(mine?.lastRunAt).toBeTruthy()
  })

  test('陈旧载荷防御：cron-retry payload 缺 cronId → 就地报错不发起', async ({ page }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders()
    const seedRes = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'error',
        category: 'task',
        title: '定时任务发起失败：损坏载荷',
        body: 'corrupt payload probe',
        action: 'cron-retry',
        actionPayload: 'not-json',
      }),
    })
    expect(seedRes.ok).toBeTruthy()

    await fixedLocale(page)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

    const row = page.locator('.nc-item').filter({ hasText: '损坏载荷' }).first()
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.locator('[data-testid^="notif-action-"]').click()

    // 解析失败就地 toast 报错，不产生任何会话（无 crons 前缀新会话即证据：
    // 本用例未创建任务，仅断言失败反馈可见）
    await expect(page.locator('.n-message').filter({ hasText: '发起失败' })).toBeVisible({ timeout: 10000 })
  })
})
