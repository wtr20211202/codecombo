import { rm } from 'node:fs/promises'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 会话静默提示（P-20261003-53）E2E：
 *   1. 值班大屏卡：running 且最后活动超 3 分钟的会话卡亮「无输出 N 分钟」弱标
 *      （title 含「可能等待输入或已停滞」hover 提示）；活跃会话与非 running
 *      会话不亮标（弱标不打扰正常会话）
 *   2. 管理页侧栏会话行：同判据亮同款弱标；点击行即选中该会话（跳会话人工判断）
 *   3. 大屏卡点击：跳回首页并激活该会话（docked 管理页打开 + 行选中）
 *   4. 静默特化（P-20261003-198）：pending+静默 → 「等待裁决 N 分钟」，裁决后
 *      回落泛化；无 pending 静默 → 泛化文案不变（真服务端 pending 记录播种）
 * 判据数据（runningMap/activityMap）是前端 store 状态（OSC 133 事件驱动，服务端
 * 无此数据），经 #app.__vue_app__ 的 Pinia 注册表注入过期/活跃样本；会话本体走
 * API 播种（runtime=shell 纯终端不拉起 TUI），afterEach 清理全部终端会话
 */

const STALE_MIN = 4 // 注入的过期活动：4.5 分钟前 → 弱标「无输出 4 分钟」（向下取整）

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 本用例集创建的临时工作目录（会话关闭后删除） */
const tempDirs: string[] = []

/** API 造纯终端系统会话（runtime=shell 不拉起 claude TUI），按名返回会话 id。
 *  建会话原语走共享层 createAgentSessionApi（e2e-api，P-20261004-48，dir 缺省
 *  自动建临时目录）；本用例集的清理义务（目录登记 + 会话关闭后删除）留在 spec 侧 */
async function createTrackedSession(request: APIRequestContext, name: string): Promise<string> {
  const created = await createAgentSessionApi(request, { name })
  tempDirs.push(created.dir)
  return created.id
}

/** 注入会话运行态/活动时间样本（前端 store 状态，服务端无此数据）：
 *  staleMin > 0 = 过期样本（N 分钟前），否则 = 刚刚（活跃） */
async function injectSessionState(page: Page, samples: { id: string; running: boolean; staleMin: number }[]) {
  await page.evaluate((items) => {
    const container = document.getElementById('app') as Element & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, {
          runningMap: Record<string, boolean>
          activityMap: Record<string, number>
        }> } } }
      }
    }
    const store = container.__vue_app__?.config.globalProperties.$pinia?._s.get('terminal-sessions')
    if (!store) throw new Error('terminal-sessions store 未注册（页面未完成引导）')
    const runningMap = { ...store.runningMap }
    const activityMap = { ...store.activityMap }
    for (const it of items) {
      runningMap[it.id] = it.running
      activityMap[it.id] = it.staleMin > 0 ? Date.now() - it.staleMin * 60_000 : Date.now()
    }
    // 整体替换触发响应式（与 store.reportOsc 内部同款展开写法）
    store.runningMap = runningMap
    store.activityMap = activityMap
  }, samples)
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例；同 approval-* spec 惯例） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    }).catch(() => {})
  }
}

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test.afterAll(async () => {
  for (const d of tempDirs) {
    try { await rm(d, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

test('值班大屏卡：静默会话亮「无输出 N 分钟」弱标，活跃/非 running 会话不亮', async ({ page, request }) => {
  const idleId = await createTrackedSession(request, 'idle-hint-stale')
  const activeId = await createTrackedSession(request, 'idle-hint-active')
  const quietId = await createTrackedSession(request, 'idle-hint-quiet')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const cardOf = (name: string) => page.locator('.mon-card.is-session').filter({ hasText: name })
  await expect(cardOf('idle-hint-stale')).toBeVisible({ timeout: 10000 })

  // 注入：stale = running + 过期 / active = running + 活跃 / quiet = 非 running + 过期
  await injectSessionState(page, [
    { id: idleId, running: true, staleMin: STALE_MIN },
    { id: activeId, running: true, staleMin: 0 },
    { id: quietId, running: false, staleMin: STALE_MIN },
  ])

  // 静默卡：弱标出现且文案含分钟数，title 含 hover 提示（②）
  const idleCard = cardOf('idle-hint-stale')
  await expect(idleCard.locator('.mon-sess-idle')).toHaveText('无输出 4 分钟')
  await expect(idleCard).toHaveAttribute('title', /可能等待输入或已停滞/)
  // 活跃会话与非 running 会话不亮标（④ 弱样式不打扰）
  await expect(cardOf('idle-hint-active').locator('.mon-sess-idle')).toHaveCount(0)
  await expect(cardOf('idle-hint-quiet').locator('.mon-sess-idle')).toHaveCount(0)
})

test('管理页侧栏会话行：静默弱标 + 点击行选中会话', async ({ page, request }) => {
  const sid = await createTrackedSession(request, 'idle-hint-row')

  await fixedLocale(page)
  // docked 管理页开合状态持久化在 localStorage：预置打开意图，首页引导即恢复
  await page.addInitScript(() => {
    localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'docked' }))
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  const row = view.locator('.ats-item').filter({ hasText: 'idle-hint-row' })
  await expect(row).toBeVisible({ timeout: 15000 })

  await injectSessionState(page, [{ id: sid, running: true, staleMin: STALE_MIN }])
  await expect(row.locator('.ats-item-idle')).toHaveText('无输出 4 分钟')
  await expect(row).toHaveAttribute('title', /可能等待输入或已停滞/)

  // 点击行 = 跳会话（③ 管理页内选中该会话）
  await row.click()
  await expect(row).toHaveClass(/active/, { timeout: 5000 })
})

test('大屏静默卡点击：跳首页激活该会话（docked 打开 + 行选中）', async ({ page, request }) => {
  const sid = await createTrackedSession(request, 'idle-hint-jump')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('.mon-card.is-session').filter({ hasText: 'idle-hint-jump' })
  await expect(card).toBeVisible({ timeout: 10000 })

  await injectSessionState(page, [{ id: sid, running: true, staleMin: STALE_MIN }])
  await card.click()

  // 跳回首页且 docked 管理页打开、该会话行选中（人工判断落点）
  await page.waitForURL(`${API_BASE}/`)
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  const row = view.locator('.ats-item').filter({ hasText: 'idle-hint-jump' })
  await expect(row).toHaveClass(/active/, { timeout: 15000 })
})

// ---- 静默标特化（P-20261003-198）：有 pending 审批 → 「等待裁决 N 分钟」 ----

/** 播种绑定到会话的 pending 审批（真服务端记录：广播 + 大屏冷启动补账双路入 store） */
async function seedApprovalFor(request: APIRequestContext, sessionId: string): Promise<void> {
  const res = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op: 'write_file', target: 'notes.md', detail: 'P-20261003-198 静默特化验证' },
  })
  expect(res.ok()).toBeTruthy()
}

test('静默特化（P-20261003-198）：pending+静默亮「等待裁决 N 分钟」，裁决后回落泛化；无 pending 仍「无输出 N 分钟」', async ({ page, request }) => {
  const pendingId = await createTrackedSession(request, 'idle-hint-appr')
  const plainId = await createTrackedSession(request, 'idle-hint-plain')
  await seedApprovalFor(request, pendingId)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  // 注入：两会话同款 running+静默，唯一差异 = 有无 pending 审批
  await injectSessionState(page, [
    { id: pendingId, running: true, staleMin: STALE_MIN },
    { id: plainId, running: true, staleMin: STALE_MIN },
  ])

  // pending+静默 → 特化文案与 hover 提示（归因精确到等裁决）
  const apprCard = page.locator('.mon-card.is-session').filter({ hasText: 'idle-hint-appr' })
  await expect(apprCard.locator('.mon-sess-idle')).toHaveText('等待裁决 4 分钟')
  await expect(apprCard).toHaveAttribute('title', /正在等待你的裁决/)

  // 无 pending 静默 → 泛化文案不变（P-53 基线回归）
  const plainCard = page.locator('.mon-card.is-session').filter({ hasText: 'idle-hint-plain' })
  await expect(plainCard.locator('.mon-sess-idle')).toHaveText('无输出 4 分钟')
  await expect(plainCard).toHaveAttribute('title', /可能等待输入或已停滞/)

  // 裁决后 pending 清账（approval.resolved 广播 → store），特化文案即时回落泛化
  const headers = await unlockHeaders(request)
  const list = ((await (await request.get(`${API_BASE}/api/ops-confirm`, { headers })).json()) as { data?: { id: string; status: string }[] }).data || []
  const approvalId = list.find(a => a.status === 'pending')?.id
  expect(approvalId, 'pending 审批应在库').toBeTruthy()
  await request.post(`${API_BASE}/api/ops-confirm/${approvalId}/resolve`, { headers, data: { allow: true, always: false } })
  await expect(apprCard.locator('.mon-sess-idle')).toHaveText('无输出 4 分钟', { timeout: 10000 })
})
