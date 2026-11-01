import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务错过槽可视化 E2E（P-20261006-22）：错过判定/环形截断/三态记账由 Go
 * 单测锁定（server/api/agentcron module_test.go、server/store/agentcron_test.go），
 * 本用例锁真实调度器全链路——造两个「今日已过窗口」的槽点任务：
 *   A 未开补偿（missCatchUp=false）→ 调度器判 Missed 只标记 → missedHistory
 *     记 skipped（前端灰档）；
 *   B 开补偿（missCatchUp=true）→ 同一轮巡检补跑发起 → missedHistory 记
 *     caught-up（前端绿档；补跑失败红档依赖发起失败现场，不可稳定制造，
 *     与 notify-cron-retry 同口径由 Go 单测锁定）。
 * 调度巡检为分钟级，用例轮询 API 至错过条目落账（上限 ~100s）；槽点取
 * 30 分钟前的今日时刻，跨零点窗口（本地 00:00–00:30）跳过。
 * 任务与会话经共享实例 API 清理，不残留测试数据
 */

const PREFIX = 'e2e-cronmissed-'

interface CronMissedEntry { slot?: string; action?: string; errSummary?: string }
interface CronRunEntry { at?: string; result?: string }
interface CronItem { id?: string; name?: string; history?: CronRunEntry[]; missedHistory?: CronMissedEntry[] }
interface SessionInfo { id?: string; name?: string }

function pastSlot(): { hour: number; minute: number; crossedMidnight: boolean } {
  const now = new Date()
  const past = new Date(now.getTime() - 30 * 60 * 1000)
  return { hour: past.getHours(), minute: past.getMinutes(), crossedMidnight: past.getDate() !== now.getDate() }
}

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
  const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  const crons = ((await listRes.json()) as { data?: CronItem[] }).data || []
  for (const c of crons) {
    if (c.name?.startsWith(PREFIX) && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith(PREFIX) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

async function createCron(headers: Record<string, string>, name: string, slot: { hour: number; minute: number }, missCatchUp: boolean) {
  const res = await fetch(`${API_BASE}/api/agent-crons`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      hour: slot.hour,
      minute: slot.minute,
      weekdays: [],
      runtime: 'shell',
      prompt: `echo ${name}`,
      dir: '',
      enabled: true,
      missCatchUp,
    }),
  })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: CronItem }).data
}

test.describe('agent cron missed slot visualization', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('造错过槽：未补偿记灰档、开补偿补跑记绿档，详情历史区三态可见', async ({ page }) => {
    test.setTimeout(180_000)
    await cleanup()
    const headers = await unlockHeaders()
    const slot = pastSlot()
    test.skip(slot.crossedMidnight, '槽点会跨零点变成未来时刻，错过语义不成立')

    const nameA = `${PREFIX}nocatchup-${Date.now()}`
    const nameB = `${PREFIX}catchup-${Date.now()}`
    await createCron(headers, nameA, slot, false)
    await createCron(headers, nameB, slot, true)

    // 轮询服务端（分钟级巡检）：两任务错过条目落账（A=skipped 灰，B=caught-up
    // 绿）。任务本体创建即可见，等的是错过条目——循环以「两账齐」为退出条件，
    // 上限 ~100s 覆盖一个完整巡检周期
    let itemA: CronItem | undefined
    let itemB: CronItem | undefined
    for (let i = 0; i < 50; i++) {
      await page.waitForTimeout(2000)
      const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
      const items = ((await listRes.json()) as { data?: CronItem[] }).data || []
      itemA = items.find(c => c.name === nameA)
      itemB = items.find(c => c.name === nameB)
      if (itemA?.missedHistory?.length && itemB?.missedHistory?.length) break
    }
    expect(itemA?.missedHistory?.length, `task A missedHistory: ${JSON.stringify(itemA?.missedHistory)}`).toBe(1)
    expect(itemA?.missedHistory?.[0]?.action).toBe('skipped')
    expect(itemB?.missedHistory?.length, `task B missedHistory: ${JSON.stringify(itemB?.missedHistory)}`).toBe(1)
    expect(itemB?.missedHistory?.[0]?.action).toBe('caught-up')
    // 补跑的运行账照常：B 的 history 落了 launched（两账分工，Go 单测同口径）
    expect(itemB?.history?.some(r => r.result === 'launched')).toBeTruthy()

    // 设置「定时任务」分区：展开历史区，灰/绿两态行内可见（混排列表）
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

    // A：单条灰档错过条目
    const rowA = manager.locator(`[data-testid="agentcron-item-${nameA}"]`)
    await expect(rowA).toBeVisible()
    await expect(rowA.locator('[data-testid="agentcron-history-toggle"]')).toContainText('1')
    await rowA.locator('[data-testid="agentcron-history-toggle"]').click()
    const listA = rowA.locator('[data-testid="agentcron-history-list"]')
    await expect(listA.locator('.history-row')).toHaveCount(1)
    await expect(listA.locator('.history-row').first()).toContainText('未开补偿未补跑')
    await expect(listA.locator('.history-row .history-result').first()).toHaveClass(/is-muted/)

    // B：错过绿档 + 补跑 launched 混排（2 行），绿档错过行可见
    const rowB = manager.locator(`[data-testid="agentcron-item-${nameB}"]`)
    await expect(rowB).toBeVisible()
    await expect(rowB.locator('[data-testid="agentcron-history-toggle"]')).toContainText('2')
    await rowB.locator('[data-testid="agentcron-history-toggle"]').click()
    const listB = rowB.locator('[data-testid="agentcron-history-list"]')
    await expect(listB.locator('.history-row')).toHaveCount(2)
    const greenRow = listB.locator('.history-row').filter({ hasText: '已补跑' })
    await expect(greenRow).toHaveCount(1)
    await expect(greenRow.locator('.history-result')).toHaveClass(/is-ok/)
    await expect(listB.locator('.history-row').filter({ hasText: '已发起' })).toHaveCount(1)
  })
})
