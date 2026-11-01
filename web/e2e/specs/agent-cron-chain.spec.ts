import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务依赖链 E2E（P-20261003-124）：
 * 触发类型扩展 / 环检测 / 两档档位判定由 Go 单测锁定（server/api/agentcron），
 * 本用例锁真实服务端全链路——父任务（立即试跑发起）→ 经 ops-notify 上报
 * task.progress 终态（模拟智能体回执，AgentTask 落库流即调度器监听面）→
 * 调度器分钟巡检级联发起子任务（前序完成触发）：
 *   1. 父 done → 子自动发起（成功档）
 *   2. 父 failed → 成功档子任务标 skipped 入运行历史，不发起（失败传播）
 * 设置分区行内可见依赖描述。任务与会话经共享实例 API 清理，不残留
 */

const PREFIX = 'e2e-cronchain'

interface CronItem { id?: string; name?: string; lastResult?: string; history?: Array<{ result?: string; errSummary?: string }>; trigger?: string; afterCronId?: string }
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
  // 先删子再删父（有子任务的父会被 409 拒绝）
  for (const pass of [true, false]) {
    for (const c of crons) {
      if (!c.name?.startsWith(PREFIX) || !c.id) continue
      const isChild = c.trigger === 'after'
      if (isChild !== pass) continue
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

/** 建任务：默认 shell 运行时（会话即刻起来，父用「立即试跑」免去分钟级等槽） */
async function createCron(headers: Record<string, string>, body: Record<string, unknown>): Promise<CronItem> {
  const res = await fetch(`${API_BASE}/api/agent-crons`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      runtime: 'shell',
      prompt: 'echo tick',
      enabled: true,
      missCatchUp: true,
      weekdays: [],
      ...body,
    }),
  })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: CronItem }).data || {}
}

async function findCron(headers: Record<string, string>, name: string): Promise<CronItem | undefined> {
  const res = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  const items = ((await res.json()) as { data?: CronItem[] }).data || []
  return items.find(c => c.name === name)
}

/** 等某 agent 会话出现（级联由分钟巡检驱动，最长 ~1.5 分钟） */
async function waitSession(headers: Record<string, string>, name: string, page: import('@playwright/test').Page, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000)
    const res = await fetch(`${API_BASE}/api/terminals`, { headers })
    const sessions = ((await res.json()) as { data?: SessionInfo[] }).data || []
    const hit = sessions.find(s => s.name === name && s.kind === 'agent')
    if (hit?.id) return hit.id
  }
  return ''
}

/** 模拟智能体回执：task.progress 终态经 AgentTask 落库流（调度器监听面） */
async function reportProgress(headers: Record<string, string>, terminalId: string, status: string, step: string) {
  const res = await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e', status, step, terminalId } }),
  })
  expect(res.ok).toBeTruthy()
}

test.describe('agent cron dependency chain', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('父完成 → 子自动发起（成功档），设置行内可见依赖描述', async ({ page }) => {
    test.setTimeout(360_000)
    await cleanup()
    const headers = await unlockHeaders()
    const parentName = `${PREFIX}-p-${Date.now()}`
    const childName = `${PREFIX}-c-${Date.now()}`

    const parent = await createCron(headers, { name: parentName, prompt: `echo ${PREFIX}-parent` })
    expect(parent.id).toBeTruthy()
    const child = await createCron(headers, {
      name: childName,
      prompt: `echo ${PREFIX}-child`,
      trigger: 'after',
      afterCronId: parent.id,
      afterMode: 'success',
    })
    expect(child.id).toBeTruthy()

    // 父任务立即试跑（与到期触发同一执行链），返回即带会话 ID
    const runRes = await fetch(`${API_BASE}/api/agent-crons/${parent.id}/run`, { method: 'POST', headers })
    expect(runRes.ok).toBeTruthy()
    const runData = ((await runRes.json()) as { data?: { id?: string } }).data
    expect(runData?.id).toBeTruthy()

    // 智能体上报 done → 巡检回执命中 → 子任务级联发起
    await reportProgress(headers, runData!.id!, 'done', '构建完成')
    const childSession = await waitSession(headers, childName, page, 150_000)
    expect(childSession, 'child cron should cascade-launch after parent done receipt').toBeTruthy()

    // 运行期事实：父 done、子 launched
    const p = await findCron(headers, parentName)
    expect(p?.lastResult).toBe('done')
    const c = await findCron(headers, childName)
    expect(c?.lastResult).toBe('launched')

    // 设置分区：子任务行内计划描述 = 前序依赖 + 档位；无「下次运行」时刻
    await fixedLocale(page)
    await closeDshConsoleAndClearState(page, page.request, API_BASE)
    await gotoAndUnlock(page, '/')
    await page.locator('.project-card').filter({ hasText: 'simple-coding' }).first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible()
    await modal.locator('.nav-item').filter({ hasText: '定时任务' }).click()
    const manager = modal.locator('[data-testid="agentcron-manager"]')
    await expect(manager).toBeVisible()
    const row = manager.locator(`[data-testid="agentcron-item-${childName}"]`)
    await expect(row).toBeVisible()
    await expect(row).toContainText(`前序: ${parentName}`)
    await expect(row).toContainText('成功才触发')
  })

  test('父失败 → 成功档子任务标 skipped 不发起（失败传播）', async ({ page }) => {
    test.setTimeout(360_000)
    const headers = await unlockHeaders()
    const parentName = `${PREFIX}-fp-${Date.now()}`
    const childName = `${PREFIX}-fc-${Date.now()}`

    const parent = await createCron(headers, { name: parentName, prompt: `echo ${PREFIX}-fail-parent` })
    const child = await createCron(headers, {
      name: childName,
      prompt: `echo ${PREFIX}-fail-child`,
      trigger: 'after',
      afterCronId: parent.id,
      afterMode: 'success',
    })

    const runRes = await fetch(`${API_BASE}/api/agent-crons/${parent.id}/run`, { method: 'POST', headers })
    const runData = ((await runRes.json()) as { data?: { id?: string } }).data
    expect(runData?.id).toBeTruthy()

    // 父智能体上报 failed：成功档子任务必须标 skipped 入历史、零发起
    await reportProgress(headers, runData!.id!, 'failed', '编译错误')
    await page.waitForTimeout(75_000) // 跨一个分钟巡检周期
    const c = await findCron(headers, childName)
    expect(c?.lastResult, 'child should be marked skipped on parent failure').toBe('skipped')
    const skippedRun = (c?.history ?? []).find(h => h.result === 'skipped')
    expect(skippedRun, 'skipped entry should land in run history').toBeTruthy()
    expect(skippedRun?.errSummary ?? '').toContain(parentName)

    const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
    const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
    expect(sessions.find(s => s.name === childName), 'skipped child must not launch').toBeUndefined()
  })
})
