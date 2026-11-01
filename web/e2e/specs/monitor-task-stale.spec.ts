import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 任务进度陈旧失联预警 + 会话关闭清账 E2E（P-20261003-303）：
 * agent 是外部进程，服务端无存活真相——running 上报后进程崩溃/断连时
 * done/failed 永不到达，进度卡永远显示 running（假阳性）。
 *   1. 失联弱预警：running 超阈值（默认 10min）无上报 → 值班大屏任务卡
 *      「可能已失联」徽标 + 弱化样式（不清数据）；真实终态上报仍可覆盖
 *      「注入短阈值」= page.clock 假时钟快进（运行时常量不可注入口留给单测
 *      thresholdMs 参数）；心跳经假时钟连跳，徽标点亮无真实等待
 *   2. 关闭清账：会话关闭 → terminals.changed 快照对账 → bySession running
 *      归属清除（大屏卡消失，且不换位续显全局兜底卡——全局 running 同步收敛）；
 *      done/failed 真终态保留供回看（卡留存，归属名回落「未知会话」）
 *   3. 已失效过渡（P-20261004-31）：清账只随快照到达——归属会话已不在会话表
 *      的 running 卡先置灰标「已失效」过渡（防未知会话假活卡误导值班判读），
 *      任一快照对账一到即随 prune 消失
 *   4. 刷新恢复补账（P-20261004-120）：页面刷新后 bySession 纯内存态全灭，
 *      进度卡由 OpsChannelBridge 挂载时 GET /api/ops-tasks/active 的服务端
 *      per-session 最近上报缓存即时回填（广播不可回放、无需等新事件）
 * 播种方式对齐 monitor-dashboard.spec（API 造会话 + /api/ops-notify 真实
 * WS 链路）；afterEach 清会话防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话混入大屏卡片计数） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** API 造纯终端系统会话（runtime=shell 不拉起 claude TUI），按名返回会话 id */
async function createAgentSession(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sc-task-stale-'))
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name, runtime: 'shell', dir: serverPath(dir) },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === name)
  expect(session, `会话 ${name} 应出现在列表`).toBeTruthy()
  return session!.id
}

/** task.progress 上报（真实链路：ops-notify → ops-channel WS → assistantTask store） */
async function reportProgress(
  request: APIRequestContext,
  headers: Record<string, string>,
  payload: Record<string, unknown>,
): Promise<void> {
  const res = await request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload },
  })
  expect(res.ok()).toBeTruthy()
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test('running 超时 → 失联弱预警徽标；真实终态到达仍可覆盖', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  // 假时钟在页面加载后安装：此后新注册的定时器（含 store 首次上报才懒启动的
  // 陈旧判定心跳）全部走假时钟，fastForward 一次跨过 10min 阈值即点亮徽标
  await page.clock.install()

  const sessionId = await createAgentSession(request, headers, 'mon-stale-agent')
  await reportProgress(request, headers, {
    task: '陈旧任务', step: '长期步骤', status: 'running', terminalId: sessionId,
  })

  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('陈旧任务')
  await expect(taskCard).toContainText('运行中')
  // 未跨阈值：无失联徽标
  await expect(taskCard.locator('.is-stale-badge')).toHaveCount(0)

  // 快进 11 分钟跨过阈值：心跳随假时钟连跳，失联徽标点亮（卡不清数据）
  await page.clock.fastForward(11 * 60 * 1000)
  await expect(taskCard.locator('.is-stale-badge')).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard.locator('.is-stale-badge')).toContainText('可能已失联')
  await expect(taskCard).toContainText('陈旧任务')
  await expect(taskCard).toContainText('运行中')

  // 真实终态到达仍可覆盖：done 上报 → 徽标熄灭、状态翻转已完成
  await reportProgress(request, headers, {
    task: '陈旧任务', status: 'done', terminalId: sessionId,
  })
  await expect(taskCard).toContainText('已完成', { timeout: 10000 })
  await expect(taskCard.locator('.is-stale-badge')).toHaveCount(0)
})

test('关闭会话 → running 进度卡消失（关闭清账），全局兜底卡不换位续显', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  const sessionId = await createAgentSession(request, headers, 'mon-close-agent')
  await reportProgress(request, headers, {
    task: '将死任务', step: '步骤', status: 'running', terminalId: sessionId,
  })

  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('mon-close-agent')

  // 关闭会话 → terminals.changed 快照 → running 归属清账：卡消失且不出现
  // 全局兜底卡（若全局 running 未收敛，__global__ 兜底卡会以运行中续显）
  await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  await expect(taskCard).toHaveCount(0, { timeout: 10000 })
})

test('done 真终态卡在会话关闭后保留供回看（归属名回落未知会话）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  const sessionId = await createAgentSession(request, headers, 'mon-done-agent')
  await reportProgress(request, headers, {
    task: '已完任务', status: 'running', terminalId: sessionId,
  })
  await reportProgress(request, headers, {
    task: '已完任务', status: 'done', terminalId: sessionId,
  })

  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toContainText('已完成', { timeout: 10000 })

  // 关闭会话：done 非 running 态 → 归属保留供回看，卡不消失
  await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('已完成')
  await expect(taskCard).toContainText('未知会话')
})

test('归属会话不在会话表的 running 卡置灰标「已失效」（清账快照未达的过渡）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  // 等首拉完成（.mon-updated 随 refreshAll 落定才出现）：会话表已加载是「已失效」
  // 判定前置（loaded 守卫防冷启动空表误判，断言同样不能在空表窗口期发车）
  await expect(page.locator('.mon-updated')).toBeVisible({ timeout: 10000 })

  // 向不存在的 terminalId 上报 running（agent 竞态/服务端重启后旧 id 重放形态，
  // 即「未知会话」假活卡）：卡出现即置灰标已失效，无需等待任何快照广播
  await reportProgress(request, headers, {
    task: '幽灵任务', step: '步骤', status: 'running', terminalId: 'sc-ghost-session',
  })

  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('幽灵任务')
  await expect(taskCard).toHaveClass(/is-invalid/)
  await expect(taskCard.locator('.is-invalid-badge')).toContainText('已失效')
  // 状态字不撒谎仍「运行中」，但绿点停呼吸（is-invalid 灰化样式，见 .mon-dot）
  await expect(taskCard).toContainText('运行中')
  await expect(taskCard.locator('.mon-dot.is-invalid')).toHaveCount(1)

  // 任一快照对账到达（借一次会话创建的 terminals.changed 广播）→ prune 清账：
  // 过渡卡消失，值班大屏不留死会话假阳性
  await createAgentSession(request, headers, 'mon-invalid-prune')
  await expect(taskCard).toHaveCount(0, { timeout: 10000 })
  // 且不换位续显全局兜底卡（全局 running 随清账收敛）
  await expect(page.locator('.mon-card.is-task')).toHaveCount(0)
})

test('刷新页面 → 进度卡由服务端最近上报快照即时回填（无需等新事件）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()

  const sessionId = await createAgentSession(request, headers, 'mon-seed-agent')
  await reportProgress(request, headers, {
    task: '刷新补账任务', step: '补账步骤', status: 'running', terminalId: sessionId,
  })
  const taskCard = page.locator('.mon-card.is-task')
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('刷新补账任务')

  // 服务端缓存面直接对账（P-20261004-120）：上报已入 per-session 最近上报缓存
  const activeRes = await request.get(`${BASE}/api/ops-tasks/active`, { headers })
  expect(activeRes.ok()).toBeTruthy()
  const active = (await activeRes.json()) as {
    data?: { tasks?: { sessionId: string; payload?: { task?: string } }[] }
  }
  const entry = (active.data?.tasks || []).find(t => t.sessionId === sessionId)
  expect(entry?.payload?.task).toBe('刷新补账任务')

  // 刷新：全部 WS 断开重连、广播不可回放（会话是 shell 运行时，不会再上报）。
  // 卡能再现的唯一数据源是 OpsChannelBridge 挂载补账 GET /api/ops-tasks/active
  await page.reload()
  await waitForAppReady(page)
  await expect(page.locator('.mon-root')).toBeVisible({ timeout: 10000 })
  await expect(taskCard).toHaveCount(1, { timeout: 10000 })
  await expect(taskCard).toContainText('刷新补账任务')
  await expect(taskCard).toContainText('补账步骤')
  // 一分钟内的新鲜条目不应误标失联（receivedAt 对齐的诚实判定）
  await expect(taskCard.locator('.is-stale-badge')).toHaveCount(0)
})
