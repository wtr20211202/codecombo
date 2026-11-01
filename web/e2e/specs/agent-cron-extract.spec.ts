import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务指标抽取 E2E（P-20261005-237）：
 * 规则校验/抽取矩阵/环形存储由 Go 单测锁定（server/api/agentcron + server/store），
 * 波动判定与 sparkline 坐标由前端单测锁定（utils/cronTrend），本用例锁真实服务端
 * 全链路：配置 extract 规则的任务 → 立即试跑 echo 数值 → ops-notify 上报 done
 * （模拟智能体回执）→ 调度器巡检抽取落点 → 列表 API 透出 metric 时序 →
 * 设置行内迷你趋势渲染（≥2 点出 sparkline，最新点波动标黄）。
 * 三轮抽取（3.5 → 4 → 20）：第三轮较前均值 3.75 偏差超 50% → 行内波动标记。
 * 任务与会话经共享实例 API 清理，不残留测试数据
 */

const PREFIX = 'e2e-cronmetric'
const RULE = `(?:build in) (?P<sec>[0-9.]+)s`

interface CronItem { id?: string; name?: string; extract?: string; metric?: { name?: string; points?: Array<{ value?: number }> } }
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

/** 模拟智能体回执：task.progress 终态经 AgentTask 落库流（调度器监听面） */
async function reportDone(headers: Record<string, string>, terminalId: string) {
  const res = await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e', status: 'done', step: '构建完成', terminalId } }),
  })
  expect(res.ok).toBeTruthy()
}

test.describe('agent cron metric extraction', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('完成回执抽取落点 → API 透出时序 → 行内迷你趋势与波动标记', async ({ page }) => {
    test.setTimeout(480_000) // 三轮抽取各等一次分钟级巡检（最长 ~75s/轮）
    await cleanup()
    const headers = await unlockHeaders()
    const name = `${PREFIX}-${Date.now()}`

    // 建任务：shell 运行时 echo 构建耗时行，extract 规则取秒数
    const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name,
        hour: 3,
        minute: 0,
        weekdays: [],
        runtime: 'shell',
        prompt: 'echo CRONMETRIC_E2E build in 3.5s',
        dir: '',
        enabled: true,
        missCatchUp: true,
        extract: RULE,
      }),
    })
    expect(createRes.ok).toBeTruthy()
    const created = ((await createRes.json()) as { data?: CronItem }).data
    expect(created?.id).toBeTruthy()

    const findMine = async (): Promise<CronItem | undefined> => {
      const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
      const items = ((await listRes.json()) as { data?: CronItem[] }).data || []
      return items.find(c => c.name === name)
    }

    /**
     * 一轮抽取：试跑（prompt 临时换成 echo 目标值）→ 等 scrollback 回显 →
     * 上报 done → 等分钟巡检抽取落点（收敛条件 = 期望点数）
     */
    async function runAndExtract(echoValue: string, expectedPoints: number): Promise<CronItem | undefined> {
      await fetch(`${API_BASE}/api/agent-crons/${created!.id}`, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          name, hour: 3, minute: 0, weekdays: [], runtime: 'shell',
          prompt: `echo CRONMETRIC_E2E build in ${echoValue}s`,
          dir: '', enabled: true, missCatchUp: true, extract: RULE,
        }),
      })
      const runRes = await fetch(`${API_BASE}/api/agent-crons/${created!.id}/run`, { method: 'POST', headers })
      expect(runRes.ok).toBeTruthy()
      const runData = ((await runRes.json()) as { data?: { id?: string } }).data
      expect(runData?.id).toBeTruthy()

      // 等 echo 落进会话滚回（抽取在巡检读尾窗，先保证素材在手）
      let echoed = false
      for (let i = 0; i < 15 && !echoed; i++) {
        const sb = await fetch(`${API_BASE}/api/terminals/${runData!.id}/scrollback`, { headers })
        echoed = (await sb.text()).includes(`build in ${echoValue}s`)
        if (!echoed) await page.waitForTimeout(2000)
      }
      expect(echoed, 'scrollback should echo the metric line before reporting done').toBeTruthy()
      await reportDone(headers, runData!.id!)

      // 等分钟巡检处理回执并抽取（最长 ~90s）
      const deadline = Date.now() + 100_000
      while (Date.now() < deadline) {
        await page.waitForTimeout(4000)
        const mine = await findMine()
        if ((mine?.metric?.points?.length ?? 0) >= expectedPoints) return mine
      }
      return findMine()
    }

    // 三轮：3.5 → 4 → 20（第三轮较前均值 3.75 偏差超 50% = 波动点）
    let mine = await runAndExtract('3.5', 1)
    expect(mine?.metric?.name, 'metric name derives from the regex group').toBe('sec')
    expect(mine?.metric?.points?.[0]?.value).toBe(3.5)

    mine = await runAndExtract('4', 2)
    expect(mine?.metric?.points?.length).toBe(2)
    expect(mine?.metric?.points?.[1]?.value).toBe(4)

    mine = await runAndExtract('20', 3)
    expect(mine?.metric?.points?.length).toBe(3)
    expect(mine?.metric?.points?.[2]?.value).toBe(20)

    // 设置 → 定时任务：行内迷你趋势（sparkline + 最近值 + 波动标记）渲染
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
    const row = manager.locator(`[data-testid="agentcron-item-${name}"]`)
    await expect(row).toBeVisible()
    const chip = row.locator('[data-testid="agentcron-metric"]')
    await expect(chip).toBeVisible()
    await expect(chip).toContainText('sec 20')
    await expect(chip.locator('svg.metric-spark polyline')).toBeVisible() // ≥2 点出折线
    await expect(chip).toHaveClass(/is-anomaly/) // 最新点 20 偏离前均值 → 波动标黄

    // 表单回读：编辑弹窗 extract 字段带规则（配置面与存储态闭环）
    await row.getByRole('button', { name: '编辑' }).click()
    await expect(page.locator('[data-testid="agentcron-form-extract"] input')).toHaveValue(RULE)
  })
})
