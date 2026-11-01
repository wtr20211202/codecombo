import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 运行中会话的指令队列 E2E（P-20261003-248）：
 *   1. 排队 2 条（busy=running）→ 完成回执（ops-notify task.progress done，
 *      真实链路）命中 → 服务端依次发送队首（scrollback 可见 + 徽标递减）
 *   2. 队列编辑/删除：行内编辑改写、单条删除（整表替换写口）
 *   3. 降级路径：会话从未上报进度（busy 缺失）→ 注记「不自动发送」+
 *      手动「立即发送」生效
 *   4. 项目树会话行同款入口（P-20261007-12 补 P-248 自认缝）：项目会话
 *      （kind shell + projectId，只渲染在项目分组树——两树会话集不相交）
 *      行内排队→计数徽标→回执依次发送；计数走 agentQueue store 全局单例
 *      （queue.changed → 拉全量对账），另一树的行如果渲染同会话将读到同一
 *      份数据——此处以服务端权威 GET /terminals/queues + 本树徽标递减作证
 *   5. 排队输入防丢草稿（P-20261005-229）：半成品指令防抖落 sessionStorage
 *      （sc.agentQueue.draft.<sessionId>）→ 刷新同 tab 存活回填；入队成功即清
 * 播种方式对齐 monitor-task-stale.spec（API 造 shell 会话 + /api/ops-notify
 * 真实 WS 链路）；自动发送断言走服务端 scrollback（PTY 事实源，不依赖前端）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话混入侧栏行计数） */
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
  const dir = await mkdtemp(path.join(tmpdir(), 'sc-agent-queue-'))
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

/** API 造项目会话（kind shell + projectId → 挂项目分组树，terminal.go 项目分支） */
async function createProjectSession(
  request: APIRequestContext,
  headers: Record<string, string>,
  name: string,
): Promise<string> {
  const plist = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  const project = ((plist?.data || []) as { id: string; name: string }[])
    .find(p => p.name === 'simple-coding')
  expect(project, 'e2e 环境应有 simple-coding 项目（openAgentSidebar 同款夹具）').toBeTruthy()
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'shell', projectId: project!.id, name },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === name)
  expect(session, `会话 ${name} 应出现在列表`).toBeTruthy()
  return session!.id
}

/** task.progress 上报（真实链路：ops-notify → ops-channel 广播 → 服务端回执引擎） */
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

/** 轮询等待指令文本出现在会话 scrollback（自动发送是异步 goroutine，PTY 回显有延迟） */
async function waitForScrollbackText(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  text: string,
): Promise<void> {
  await expect
    .poll(async () => {
      const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
      return (await res.body()).toString('utf-8')
    }, { timeout: 15000, message: `scrollback 应出现「${text}」` })
    .toContain(text)
}

/** 进入项目页并打开 agent docked 管理页（侧栏会话树宿主） */
async function openAgentSidebar(page: Page): Promise<void> {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
}

/** 按名定位会话行并展开排队面板 */
async function openQueuePanel(page: Page, name: string): Promise<void> {
  const row = page.locator('.ats-item', { hasText: name }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.hover()
  await row.locator('[data-testid="session-queue-toggle"]').click()
  await expect(page.locator('[data-testid="session-queue-panel"]')).toBeVisible()
}

async function queueInstruction(page: Page, text: string): Promise<void> {
  const panel = page.locator('[data-testid="session-queue-panel"]')
  await panel.locator('input').first().fill(text)
  await panel.locator('input').first().press('Enter')
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test('排队 2 条 → 完成回执依次自动发送，队列清空', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  const sessionId = await createAgentSession(request, headers, 'queue-seq-agent')
  // busy=running：排队等回执（不打断运行中智能体）
  await reportProgress(request, headers, { task: '排队任务', status: 'running', terminalId: sessionId })

  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-seq-agent')
  await queueInstruction(page, 'echo queue-instr-one')
  await queueInstruction(page, 'echo queue-instr-two')
  const panel = page.locator('[data-testid="session-queue-panel"]')
  await expect(panel.locator('.asq-item')).toHaveCount(2)
  // 行尾徽标常显计数 2
  const row = page.locator('.ats-item', { hasText: 'queue-seq-agent' }).first()
  await expect(row.locator('.ats-item-queue-count')).toHaveText('2')
  // 排队期不得抢跑：scrollback 无指令
  const early = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
  expect((await early.body()).toString('utf-8')).not.toContain('queue-instr')

  // 第一条完成回执 → 自动发送队首；第二条继续等
  await reportProgress(request, headers, { task: '排队任务', status: 'done', terminalId: sessionId })
  await waitForScrollbackText(request, headers, sessionId, 'queue-instr-one')
  await expect(row.locator('.ats-item-queue-count')).toHaveText('1', { timeout: 10000 })
  await expect(panel.locator('.asq-item')).toHaveCount(1)

  // 第二条完成回执 → 发送第二条，队列清空
  await reportProgress(request, headers, { task: '排队任务', status: 'done', terminalId: sessionId })
  await waitForScrollbackText(request, headers, sessionId, 'queue-instr-two')
  await expect(panel.locator('.asq-empty')).toBeVisible({ timeout: 10000 })
  await expect(row.locator('.ats-item-queue-count')).toHaveCount(0)
})

test('项目树会话行排队入口：入队 → 计数徽标 → 回执依次自动发送（P-20261007-12）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  const sessionId = await createProjectSession(request, headers, 'queue-proj-agent')
  // busy=running：排队等回执（与用例 1 同链，会话类别无关——队列端点无 kind 门）
  await reportProgress(request, headers, { task: '项目树排队任务', status: 'running', terminalId: sessionId })

  await openAgentSidebar(page)
  // 两树会话集不相交（项目会话只渲染在项目分组树）——按名唯一命中的 section
  // 即项目树分组，组名断言钉死「入口长在项目树行上」而非会话树
  const section = page.locator('.ats-section').filter({ hasText: 'queue-proj-agent' }).first()
  await expect(section.locator('.ats-group-name')).toHaveText('simple-coding', { timeout: 10000 })
  const row = section.locator('.ats-item', { hasText: 'queue-proj-agent' }).first()
  await openQueuePanel(page, 'queue-proj-agent')
  const panel = page.locator('[data-testid="session-queue-panel"]')

  await queueInstruction(page, 'echo proj-queue-one')
  await queueInstruction(page, 'echo proj-queue-two')
  await expect(panel.locator('.asq-item')).toHaveCount(2)
  // 行尾徽标常显计数 2（项目树行同款）
  await expect(row.locator('.ats-item-queue-count')).toHaveText('2')
  // 服务端权威态 = 会话树同读的 agentQueue store 数据源（两树计数同步的结构保证）
  const qres = await request.get(`${BASE}/api/terminals/queues`, { headers })
  const queues = ((await qres.json()) as { data?: { queues?: Array<{ sessionId: string; items: Array<{ text: string }> }> } }).data?.queues || []
  expect(queues.find(q => q.sessionId === sessionId)?.items.map(i => i.text))
    .toEqual(['echo proj-queue-one', 'echo proj-queue-two'])

  // 第一条完成回执 → 自动发送队首 + 本树徽标递减（queue.changed → store 拉全量对账）
  await reportProgress(request, headers, { task: '项目树排队任务', status: 'done', terminalId: sessionId })
  await waitForScrollbackText(request, headers, sessionId, 'proj-queue-one')
  await expect(row.locator('.ats-item-queue-count')).toHaveText('1', { timeout: 10000 })

  // 第二条完成回执 → 发送第二条，队列清空、徽标摘除
  await reportProgress(request, headers, { task: '项目树排队任务', status: 'done', terminalId: sessionId })
  await waitForScrollbackText(request, headers, sessionId, 'proj-queue-two')
  await expect(panel.locator('.asq-empty')).toBeVisible({ timeout: 10000 })
  await expect(row.locator('.ats-item-queue-count')).toHaveCount(0)
})

test('队列编辑与删除：行内改写生效，单条删除后计数递减', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  const sessionId = await createAgentSession(request, headers, 'queue-edit-agent')
  await reportProgress(request, headers, { task: '编辑任务', status: 'running', terminalId: sessionId })

  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-edit-agent')
  await queueInstruction(page, '原始指令甲')
  await queueInstruction(page, '原始指令乙')
  const panel = page.locator('[data-testid="session-queue-panel"]')

  // 行内编辑第一条
  await panel.locator('.asq-item').first().locator('.asq-item-btn[title="编辑"]').click()
  const editInput = panel.locator('.asq-item').first().locator('input')
  await expect(editInput).toBeVisible()
  await editInput.fill('改写后的指令')
  await editInput.press('Enter')
  await expect(panel.locator('.asq-item').first()).toContainText('改写后的指令')

  // 删除第二条 → 计数 1，服务端权威态对账
  await panel.locator('[data-testid="queue-delete-1"]').click()
  await expect(panel.locator('.asq-item')).toHaveCount(1)
  const qres = await request.get(`${BASE}/api/terminals/queues`, { headers })
  const queues = ((await qres.json()) as { data?: { queues?: Array<{ sessionId: string; items: Array<{ text: string }> }> } }).data?.queues || []
  const mine = queues.find(q => q.sessionId === sessionId)
  expect(mine?.items.map(i => i.text)).toEqual(['改写后的指令'])
})

test('busy 缺失降级：注记不自动发送，手动「立即发送」写入 PTY', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  // 从不创建任何 task.progress 上报：busy 无从判定 → 降级手动发送
  const sessionId = await createAgentSession(request, headers, 'queue-manual-agent')

  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-manual-agent')
  await queueInstruction(page, 'echo manual-send-check')
  const panel = page.locator('[data-testid="session-queue-panel"]')
  // 降级注记可见 + 手动发送按钮出现
  await expect(panel.locator('[data-testid="queue-manual-note"]')).toBeVisible()
  await expect(panel.locator('[data-testid="queue-send-now-0"]')).toBeVisible()
  // 降级入队不抢跑
  const early = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
  expect((await early.body()).toString('utf-8')).not.toContain('manual-send-check')

  // 手动发送 → scrollback 可见 + 队列摘除
  await panel.locator('[data-testid="queue-send-now-0"]').click()
  await waitForScrollbackText(request, headers, sessionId, 'manual-send-check')
  await expect(panel.locator('.asq-empty')).toBeVisible({ timeout: 10000 })
})

test('排队上限 5 条：第 6 条 409 拒绝（服务端硬上限）', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const sessionId = await createAgentSession(request, headers, 'queue-cap-agent')
  for (let i = 0; i < 5; i++) {
    const res = await request.post(`${BASE}/api/terminals/${sessionId}/queue`, {
      headers,
      data: { text: `指令 ${i}` },
    })
    expect(res.ok()).toBeTruthy()
  }
  const res = await request.post(`${BASE}/api/terminals/${sessionId}/queue`, {
    headers,
    data: { text: '第六条' },
  })
  expect(res.status()).toBe(409)
  // 稳定标记原文即 KNOWN_ERROR_I18N 映射契约（errors.known.queueFull）
  expect((await res.text())).toContain('queue is full')
})

test('排队输入防丢草稿：刷新后回填半成品指令（P-20261005-229）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  // 刷新前管理页开着 → openState 持久化让 home 路由自恢复成全屏 overlay，
  // 拦项目卡点击（agent-new-session-draft.spec 同款预清；本用例断言只认
  // sessionStorage 草稿键与队列面板，管理页开合态预清不影响链路）
  await page.addInitScript(() => { localStorage.removeItem('sc.agentTerminal.openState') })
  const sessionId = await createAgentSession(request, headers, 'queue-draft-agent')
  const draftKey = `sc.agentQueue.draft.${sessionId}`

  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-draft-agent')
  const input = page.locator('[data-testid="session-queue-panel"] input').first()
  // 只键入不提交（半成品场景）：防抖 1s 落 sessionStorage
  await input.fill('echo half-written-draft-instr')
  await expect.poll(
    () => page.evaluate(key => sessionStorage.getItem(key), draftKey),
    { timeout: 5000, interval: 200 },
  ).toBe('echo half-written-draft-instr')

  // 刷新（同 tab：sessionStorage 天然存活，草稿不在服务端、纯本地车道）
  await page.reload()
  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-draft-agent')
  // 静默回填：文本重现于输入框即「从上次继续」，无提示条
  await expect(page.locator('[data-testid="session-queue-panel"] input').first())
    .toHaveValue('echo half-written-draft-instr')
  // 未入队：服务端无此指令（草稿是纯本地态，不产生服务端副作用）
  const qres = await request.get(`${BASE}/api/terminals/queues`, { headers })
  const queues = ((await qres.json()) as { data?: { queues?: Array<{ sessionId: string; items: Array<{ text: string }> }> } }).data?.queues || []
  expect(queues.find(q => q.sessionId === sessionId)).toBeUndefined()
})

test('排队输入草稿：入队成功即清（P-20261005-229）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  const sessionId = await createAgentSession(request, headers, 'queue-draft-clear-agent')
  const draftKey = `sc.agentQueue.draft.${sessionId}`

  await openAgentSidebar(page)
  await openQueuePanel(page, 'queue-draft-clear-agent')
  const input = page.locator('[data-testid="session-queue-panel"] input').first()
  await input.fill('echo queued-and-drafted')
  await expect.poll(
    () => page.evaluate(key => sessionStorage.getItem(key), draftKey),
    { timeout: 5000, interval: 200 },
  ).toBe('echo queued-and-drafted')

  // 入队成功（回执驱动链，无需 progress 播种）：草稿键清除 + 输入框清空
  await input.press('Enter')
  await expect(page.locator('[data-testid="session-queue-panel"] .asq-item')).toHaveCount(1)
  await expect.poll(
    () => page.evaluate(key => sessionStorage.getItem(key), draftKey),
    { timeout: 3000, interval: 200 },
  ).toBe(null)
  await expect(input).toHaveValue('')
})
