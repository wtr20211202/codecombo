import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端空闲超时自动分离 E2E（P-20261003-192）：
 * - 注入超时（settings.terminalIdleTimeoutMin=1 分钟档——UI 档位以小时起步，
 *   1 分钟是 API/e2e 注入档，服务端校验 0 或 1~43200）→ 无客户端附着且空闲
 *   的会话在巡检后分离 + 通知中心入账。e2e 实例为 Windows native 后端（无
 *   持久化层），通知落 bodyEphemeral 档且不带跳转 Action（会话已终结无处可
 *   跳——tmux 实例会落 bodyPersistent + terminal Action，本机拓扑断言不到）。
 * - 活动会话不受影响：有 WS 客户端附着的会话同窗不被分离（在用会话绝不动，
 *   免「分离→前端重连」抖动）；客户端断开后同会话在下一轮扫描即纳入回收。
 * - 默认关零变化：阈值 0（默认）时空闲会话原样保留、无通知。
 * - 设置链路：档位写入回读 + 越界 400 + 设置页档位选择保存落盘。
 *
 * 确定性触发：列表消费即巡检（GET /api/terminals 内联扫描，P-157「下次列表
 * 消费延迟触达」同哲学），expect.poll 轮询即触发判定；60s ticker 只是生产
 * 兜底，本用例不等表。
 */

const BASE = API_BASE

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setSettings(request: APIRequestContext, patch: Record<string, unknown>): Promise<number> {
  const res = await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: patch,
  })
  return res.status()
}

async function readSetting(request: APIRequestContext, key: string): Promise<unknown> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: Record<string, unknown> }).data?.[key]
}

async function listSessions(request: APIRequestContext): Promise<{ id: string; lastActivity?: string }[]> {
  const res = await request.get(`${BASE}/api/terminals`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: { id: string; lastActivity?: string }[] }).data || []
}

async function createSession(request: APIRequestContext, name: string): Promise<string> {
  const res = await request.post(`${BASE}/api/terminals`, {
    headers: await unlockHeaders(request),
    data: { kind: 'agent', name, runtime: 'shell' },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data?: { id?: string } }
  const id = body.data?.id
  expect(id, 'session id in create response').toBeTruthy()
  return id!
}

/** 清理全部终端会话（服务端全局共享，session-time-chips 同款约定） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  for (const s of await listSessions(request)) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

async function clearNotifications(request: APIRequestContext): Promise<void> {
  await request.post(`${BASE}/api/notifications/clear`, { headers: await unlockHeaders(request) })
}

async function idleDetachNotifications(request: APIRequestContext) {
  const res = await request.get(`${BASE}/api/notifications`, { headers: await unlockHeaders(request) })
  const list = ((await res.json()) as { data?: { titleKey?: string; bodyKey?: string; action?: string; actionPayload?: string; msgParams?: Record<string, unknown> }[] }).data || []
  return list.filter(n => n.titleKey === 'terminal.idleDetach.notify.title')
}

/** 在页面里开一条真实终端 WS 并保持（返回关闭函数）——native 后端握手即
 *  EnsureAttached 直连，无 tmux reattach 依赖；锁定功能被金态播种关闭时
 *  握手免 token（WithWSLockAuth 与 LockMiddleware 同语义） */
async function attachTerminalWS(page: Page, sessionId: string): Promise<() => void> {
  const wsUrl = BASE.replace(/^http/, 'ws') + `/ws/terminal/${sessionId}`
  const opened = await page.evaluate(url => new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(url)
    ;(window as unknown as { __e2eIdleWS?: WebSocket }).__e2eIdleWS = ws
    ws.onopen = () => resolve('open')
    ws.onerror = () => reject(new Error('terminal ws handshake failed'))
  }), wsUrl)
  expect(opened).toBe('open')
  return () => {
    void page.evaluate(() => {
      (window as unknown as { __e2eIdleWS?: WebSocket }).__e2eIdleWS?.close()
    })
  }
}

test.describe('终端空闲超时自动分离（P-20261003-192）', () => {
  test.afterEach(async ({ request }) => {
    // 阈值先归零再清会话：防 afterEach 清理自身的 DELETE 与扫描赛跑
    await setSettings(request, { terminalIdleTimeoutMin: 0 })
    await cleanupTerminals(request).catch(() => { /* 服务不在：无残留面 */ })
  })

  test('注入超时：空闲会话被分离 + 通知入账；快照携服务端活动时钟', async ({ request }) => {
    // 60s 阈值 + 轮询余量：默认 30s 用例超时撑不到分离时刻
    test.setTimeout(150_000)
    await cleanupTerminals(request)
    await clearNotifications(request)
    expect(await setSettings(request, { terminalIdleTimeoutMin: 1 })).toBe(200)
    expect(await readSetting(request, 'terminalIdleTimeoutMin')).toBe(1)

    const id = await createSession(request, '[e2e-idle] 会消失的会话')

    // 创建响应/列表快照携服务端活动时钟（观测面字段，可选消费）
    const snap = (await listSessions(request)).find(s => s.id === id)
    expect(snap, 'session listed right after create').toBeTruthy()
    expect(snap!.lastActivity, 'server-side lastActivity present').toBeTruthy()

    // 列表轮询即巡检：60s 阈值过后第一轮 GET 就地分离（90s 上限含时钟余量）
    await expect.poll(async () => (await listSessions(request)).some(s => s.id === id), {
      timeout: 90_000,
      message: 'idle session should be detached and removed from list',
    }).toBe(false)

    // 通知中心入账：native 后端（无持久化层）落 ephemeral 档——会话已终结，
    // 诚实面不带跳转 Action；tmux 实例才是 persistent+Action 档
    const hits = await idleDetachNotifications(request)
    const hit = hits[0]
    expect(hit, 'idle detach notification recorded').toBeTruthy()
    expect(hit!.bodyKey).toBe('terminal.idleDetach.notify.bodyEphemeral')
    expect(hit!.action, 'ephemeral detach has no jump action').toBeUndefined()
  })

  test('活动会话不受影响：WS 附着豁免分离，断开后纳入回收', async ({ page, request }) => {
    test.setTimeout(180_000)
    await cleanupTerminals(request)
    await clearNotifications(request)
    expect(await setSettings(request, { terminalIdleTimeoutMin: 1 })).toBe(200)

    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`) // WS 需要页面源（浏览器 WebSocket）

    const idleId = await createSession(request, '[e2e-idle] 空闲会话')
    const liveId = await createSession(request, '[e2e-idle] 在用会话')
    const closeWS = await attachTerminalWS(page, liveId)

    // 阈值过后：无附着的空闲会话被分离；同批的在用会话（WS 附着）原样保留
    await expect.poll(async () => (await listSessions(request)).some(s => s.id === idleId), {
      timeout: 90_000,
    }).toBe(false)
    expect((await listSessions(request)).some(s => s.id === liveId)).toBe(true)

    // 在用会话无分离通知（豁免面与分离面同源对账）
    const names = await idleDetachNotifications(request)
    expect(names.find(n => n.msgParams?.name === '[e2e-idle] 在用会话')).toBeUndefined()

    // 客户端断开 → 下一轮扫描即纳入回收（空闲时钟未因附着而重置）
    await closeWS()
    await expect.poll(async () => (await listSessions(request)).some(s => s.id === liveId), {
      timeout: 30_000,
    }).toBe(false)
  })

  test('默认关零变化 + 设置链路：阈值 0 空闲保留；越界 400；设置页档位落盘', async ({ page, request }) => {
    await cleanupTerminals(request)
    await clearNotifications(request)
    expect(await setSettings(request, { terminalIdleTimeoutMin: 0 })).toBe(200)

    const id = await createSession(request, '[e2e-idle] 默认关不分离')
    // 阈值 0 时判定直返（Go 单测已覆盖百小时空闲不分离）；此处真实等待一档
    // e2e 注入阈值的时间量级，确认无分离无通知
    await page.waitForTimeout(8000)
    expect((await listSessions(request)).some(s => s.id === id)).toBe(true)
    expect((await idleDetachNotifications(request)).length).toBe(0)

    // 设置链路：有效档回读 / 负数与超上限 400 / 回 0 再走 UI 改档
    expect(await setSettings(request, { terminalIdleTimeoutMin: 480 })).toBe(200)
    expect(await readSetting(request, 'terminalIdleTimeoutMin')).toBe(480)
    for (const bad of [-1, 43201]) {
      expect(await setSettings(request, { terminalIdleTimeoutMin: bad })).toBe(400)
    }
    expect(await readSetting(request, 'terminalIdleTimeoutMin')).toBe(480)
    expect(await setSettings(request, { terminalIdleTimeoutMin: 0 })).toBe(200)

    // 设置页档位选择（n-select）+ 保存落盘：关闭（当前值）→ 8 小时 → 服务端回读
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible({ timeout: 5000 })

    const select = page.locator('[data-testid="settings-terminal-idle-timeout"]')
    await expect(select).toBeVisible()
    // NSelect 点 .n-base-selection 开菜单（approval-rules / approve-all-confirm 同款交互）
    await select.locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '8 小时' }).click()
    await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
    expect(await readSetting(request, 'terminalIdleTimeoutMin')).toBe(480)
  })
})
