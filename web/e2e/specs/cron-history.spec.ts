import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务运行历史迷你列表 E2E（P-20261002-143）：
 * 环形截断/失败摘要 rune 截断/历史随记账落库由 Go 单测锁定
 * （server/store/agentcron、server/api/agentcron），本用例锁真实服务端
 * 全链路：同一任务连续两次「立即试跑」→ 运行历史落两条 → 设置分区任务行
 * 展开迷你历史列表可见两行（时间/结果）。任务建为停用态——调度器不触发
 * （试跑链不查启停），显式 POST /run 即时返回，无分钟级调度等待。
 * 任务与会话经共享实例 API 清理，不残留测试数据
 */

const CRON_NAME = `e2e-cronhist-${Date.now()}`
const CRON_PREFIX = 'e2e-cronhist-'

interface CronRunEntry { at?: string; result?: string; errSummary?: string }
interface CronItem { id?: string; name?: string; history?: CronRunEntry[] }
interface SessionInfo { id?: string; name?: string }

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
    if (c.name?.startsWith(CRON_PREFIX) && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  // 清试跑产生的同名会话
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith(CRON_PREFIX) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

test.describe('agent cron run history', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('连续两次试跑：服务端历史两条，设置分区行内展开迷你历史两行', async ({ page }) => {
    await cleanup() // 上次中断遗留的同前缀任务/会话先清
    const headers = await unlockHeaders()

    // 停用态任务：调度器跳过，只走显式试跑链（RunNow 不查启停）
    const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: CRON_NAME,
        hour: 23,
        minute: 59,
        weekdays: [],
        runtime: 'shell',
        prompt: 'echo cron-history-e2e',
        dir: '',
        enabled: false,
        missCatchUp: false,
      }),
    })
    expect(createRes.ok).toBeTruthy()
    const created = ((await createRes.json()) as { data?: CronItem }).data
    expect(created?.id).toBeTruthy()

    // 连续两次试跑：与到期触发同一执行链，每次记账一条运行历史
    for (let i = 0; i < 2; i++) {
      const runRes = await fetch(`${API_BASE}/api/agent-crons/${created!.id}/run`, { method: 'POST', headers })
      expect(runRes.ok).toBeTruthy()
    }

    // 服务端历史：两条 launched（最新在尾；成功路径无错误摘要）
    const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
    const items = ((await listRes.json()) as { data?: CronItem[] }).data || []
    const mine = items.find(c => c.name === CRON_NAME)
    expect(mine?.history?.length).toBe(2)
    for (const run of mine?.history ?? []) {
      expect(run.result).toBe('launched')
      expect(run.at).toBeTruthy()
      expect(run.errSummary ?? '').toBe('')
    }

    // 设置「定时任务」分区：任务行展开迷你历史，两行可见（展示最新在前）
    await fixedLocale(page)
    await closeDshConsoleAndClearState(page, page.request, API_BASE)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible()
    await modal.locator('.nav-item').filter({ hasText: '定时任务' }).click()
    const manager = modal.locator('[data-testid="agentcron-manager"]')
    await expect(manager).toBeVisible()
    const row = manager.locator(`[data-testid="agentcron-item-${CRON_NAME}"]`)
    await expect(row).toBeVisible()
    const toggle = row.locator('[data-testid="agentcron-history-toggle"]')
    await expect(toggle).toContainText('2')
    await toggle.click()
    const list = row.locator('[data-testid="agentcron-history-list"]')
    await expect(list).toBeVisible()
    const rows = list.locator('.history-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('已发起')
  })
})
