import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时智能体任务 E2E（P-20261002-43）：
 * 到期判定/错过补偿/停用跳过由 Go 单测锁定（server/api/agentcron），
 * 本用例锁真实服务端全链路：造「下一分钟」任务 → 等调度器到点自动发起 →
 * agent 终端出现（会话名 = 任务名）且 scrollback 回显注入的 launchArgs
 * （prompt 经服务端常量模板组装）→ 设置「定时任务」分区可见任务与
 * 下次运行预览。调度为分钟级巡检，触发等待以真实时钟为目标槽点。
 * 任务与会话经共享实例 API 清理，不残留测试数据
 */

const CRON_NAME = `e2e-agentcron-${Date.now()}`
const MARKER = `AGENTCRON_E2E_${Date.now()}`

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
    if (c.name?.startsWith('e2e-agentcron-') && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  // 清同名会话
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith('e2e-agentcron-') && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

test.describe('agent cron scheduled tasks', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('到点自动发起：agent 终端出现且注入 prompt，设置分区可见下次运行预览', async ({ page }) => {
    test.setTimeout(300_000) // 分钟级调度：触发等待最长 ~2 分钟，留余量
    await cleanup() // 上次中断遗留的同前缀任务/会话先清（前缀清，时间戳名不冲突也兜底）
    const headers = await unlockHeaders()

    // 目标槽点 = 下一分钟边界（每日模型 + 周几空集 = 每天）：调度器在该槽点
    // 起的到期窗口内首个巡检触发
    const slot = new Date()
    slot.setSeconds(0, 0)
    slot.setMinutes(slot.getMinutes() + 1)
    const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: CRON_NAME,
        hour: slot.getHours(),
        minute: slot.getMinutes(),
        weekdays: [],
        runtime: 'shell',
        prompt: `echo ${MARKER}`,
        dir: '',
        enabled: true,
        missCatchUp: true,
      }),
    })
    expect(createRes.ok).toBeTruthy()
    const created = ((await createRes.json()) as { data?: CronItem }).data
    expect(created?.id).toBeTruthy()

    // 等调度器到点：会话列表出现同名 agent 会话（会话名 = 任务名）
    let sessionId = ''
    const deadline = Date.now() + 220_000
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000)
      const res = await fetch(`${API_BASE}/api/terminals`, { headers })
      const sessions = ((await res.json()) as { data?: SessionInfo[] }).data || []
      const hit = sessions.find(s => s.name === CRON_NAME && s.kind === 'agent')
      if (hit?.id) {
        sessionId = hit.id
        break
      }
    }
    expect(sessionId, 'scheduler should launch the due task within ~2 minutes').toBeTruthy()

    // launchArgs 含 prompt 的证据：会话 scrollback 回显注入的指令（shell 运行时
    // 下 prompt 作为首条命令注入执行）
    let echoed = false
    for (let i = 0; i < 10 && !echoed; i++) {
      const sb = await fetch(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers })
      echoed = (await sb.text()).includes(MARKER)
      if (!echoed) await page.waitForTimeout(2000)
    }
    expect(echoed, 'scrollback should echo the injected launchArgs prompt').toBeTruthy()

    // 运行期事实回填：lastResult=launched、lastRunAt/nextRunAt 有值
    const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
    const items = ((await listRes.json()) as { data?: Array<CronItem & { lastResult?: string; lastRunAt?: string; nextRunAt?: string }> }).data || []
    const mine = items.find(c => c.name === CRON_NAME)
    expect(mine?.lastResult).toBe('launched')
    expect(mine?.lastRunAt).toBeTruthy()
    expect(mine?.nextRunAt).toBeTruthy()

    // 设置「定时任务」分区：任务行 + 计划/下次运行/结果可见
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
    await expect(row).toContainText(`${String(slot.getHours()).padStart(2, '0')}:${String(slot.getMinutes()).padStart(2, '0')}`)
    await expect(row).toContainText('下次运行')
    await expect(row).toContainText('已发起')
  })
})
