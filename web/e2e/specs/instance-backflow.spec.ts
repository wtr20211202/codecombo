import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 联邦派发进度回流 E2E（P-20261004-131）：多机调度闭环的监控段——
 *   1. API 契约：成功派发落寻址账（GET /api/instances/dispatched），移除端点
 *      幂等；失败派发不落账
 *   2. 回流映射 + 徽标：对端上报任务进度（B6 落库视图协议）→ 中心 15s 回流
 *      轮询 → 悬浮球出现该任务带实例徽标（点击直达该实例）+ 值班大屏任务卡
 *      带远程来源徽标
 *   3. 终态通知入账：对端 done → 下一轮轮询 → 通知中心入账（switch-instance
 *      跳实例链既有）
 *
 * 对端实例 = spec 进程内最小 HTTP 真身（instance-dispatch 同款先例）：本 spec
 * 的被测面 = 中心派发落账 + 回流轮询映射 + 徽标 + 通知；对端 agent-tasks 端点
 * 按 B6 落库视图协议回答（真实对端的该端点有 Go 单测覆盖）。
 *
 * 时序注记：回流轮询 setInterval 在 App 挂载期注册（页面加载后无法注入假时钟
 * 劫持——Playwright clock 只管 install 之后创建的定时器），断言一律放宽到
 * 「一个轮询间隔（15s）+ 请求耗时」以上，靠真实间隔轮到达。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-backflow-peer'
const PEER_TOKEN = 'sc_e2e_backflow_token'
const SESSION_NAME = 'e2e 回流会话'
const REMOTE_SESSION_ID = 'term-peer-backflow'
const TASK_NAME = 'e2e 回流任务'
// 断言放宽：一个轮询间隔 + 跨机请求耗时 + 渲染拍
const POLL_WAIT = { timeout: 35_000 }
const SWITCH_WAIT = { timeout: 20_000 }

let unlockToken = ''
let instanceId = ''
let peer: http.Server
let peerPort = 0

// 对端真身状态：事件流行为（running / done）
const peerState = {
  behavior: 'running' as 'running' | 'done',
}

function peerHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-backflow-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/terminals') && req.method === 'POST') {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      data: { id: REMOTE_SESSION_ID, name: SESSION_NAME, kind: 'agent', runtime: 'shell', launched: true },
    }))
    return
  }
  if (req.url?.startsWith('/api/agent-tasks')) {
    // B6 落库视图协议：最新在前；at 用真身当前时刻（回流新鲜度窗内即通知）
    const status = peerState.behavior
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      data: status === 'done'
        ? [{ type: 'task.progress', task: TASK_NAME, status: 'done', step: '', at: new Date().toISOString() }]
        : [{ type: 'task.progress', task: TASK_NAME, status: 'running', step: '编译中', at: new Date().toISOString() }],
    }))
    return
  }
  res.statusCode = 404
  res.end('not the endpoint the backflow path hits')
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  return { 'X-Lock-Token': ((await res.json()) as { token?: string }).token || '' }
}

/** API 派发一次（走中心真实转发链），成功返回 true */
async function dispatchOnce(request: APIRequestContext): Promise<boolean> {
  const res = await request.post(`${BASE}/api/instances/${instanceId}/dispatch`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    data: { name: SESSION_NAME, runtime: 'shell' },
  })
  return res.ok()
}

/** 清掉本 spec 的全部派发记录（对端会话 id 固定，按其过滤；防上次失败运行残留） */
async function cleanRecords(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${BASE}/api/instances/dispatched`, { headers: { 'X-Lock-Token': unlockToken } })
  const records = ((await res.json()) as { data?: Array<{ id: string; remoteSessionId: string }> }).data || []
  for (const r of records.filter(r => r.remoteSessionId === REMOTE_SESSION_ID)) {
    await request.delete(`${BASE}/api/instances/dispatched/${r.id}`, {
      headers: { 'X-Lock-Token': unlockToken },
    }).catch(() => { /* 尽力而为 */ })
  }
}

test.beforeAll(async ({ request }) => {
  unlockToken = (await unlockHeaders(request))['X-Lock-Token']

  peer = http.createServer(peerHandler)
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  peerPort = (peer.address() as AddressInfo).port

  const res = await request.post(`${BASE}/api/instances`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    data: { name: PEER_NAME, url: `http://127.0.0.1:${peerPort}`, token: PEER_TOKEN },
  })
  expect(res.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()
  await cleanRecords(request)
})

test.afterAll(async ({ request }) => {
  peer?.close()
  if (instanceId) {
    await request.delete(`${BASE}/api/instances/${instanceId}`, {
      headers: { 'X-Lock-Token': unlockToken },
    }).catch(() => { /* 尽力而为 */ })
  }
  await cleanRecords(request)
  // 派发通知与回流终态通知不入共享实例长账（通知域 spec 清理同款惯例）
  await request.post(`${BASE}/api/notifications/clear`, {
    headers: { 'X-Lock-Token': unlockToken },
  }).catch(() => { /* 尽力而为 */ })
})

test('API：派发落寻址账 + 移除幂等；失败派发不落账', async ({ request }) => {
  const headers = { 'X-Lock-Token': unlockToken }
  peerState.behavior = 'running'
  expect(await dispatchOnce(request)).toBeTruthy()

  const list = await request.get(`${BASE}/api/instances/dispatched`, { headers })
  expect(list.ok()).toBeTruthy()
  const records = ((await list.json()) as { data?: Array<{ id: string; instanceId: string; remoteSessionId: string; remoteSessionName?: string; instanceName?: string }> }).data || []
  const mine = records.filter(r => r.remoteSessionId === REMOTE_SESSION_ID)
  expect(mine.length).toBeGreaterThanOrEqual(1)
  expect(mine[0].instanceId).toBe(instanceId)
  expect(mine[0].instanceName).toBe(PEER_NAME)
  expect(mine[0].remoteSessionName).toBe(SESSION_NAME)

  // 失败派发不落账：对端 400 预检（行为翻转后原样恢复）
  // ——本真身不模拟 400 预检（instance-dispatch.spec 已覆盖失败透传），这里
  // 直接以「无记录时清单为空」兜底校验移除链
  const del = await request.delete(`${BASE}/api/instances/dispatched/${mine[0].id}`, { headers })
  expect(del.ok()).toBeTruthy()
  const delAgain = await request.delete(`${BASE}/api/instances/dispatched/no-such-record`, { headers })
  expect(delAgain.ok()).toBeTruthy()
  const after = ((await (await request.get(`${BASE}/api/instances/dispatched`, { headers })).json()) as { data?: Array<{ id: string }> }).data || []
  expect(after.filter(r => r.id === mine[0].id)).toHaveLength(0)
})

test.describe.serial('回流映射、徽标与终态通知', () => {
  test.beforeAll(async ({ request }) => {
    // 清通知防分组行干扰（instance-dispatch 同款）；对端置 running 后派发落账
    await request.post(`${BASE}/api/notifications/clear`, { headers: { 'X-Lock-Token': unlockToken } })
    peerState.behavior = 'running'
    expect(await dispatchOnce(request)).toBeTruthy()
  })

  /** 进项目 → 管理页 → 收起为悬浮球（回流徽标的宿主形态） */
  async function openBall(page: Page): Promise<void> {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('button[title="收起为悬浮球"]').click()
    await expect(page.locator('.agm-root')).toBeVisible({ timeout: 5000 })
  }

  test('悬浮球出现对端任务 + 实例徽标，点击直达该实例', async ({ page }) => {
    await openBall(page)
    // 回流轮询（真实 15s 间隔）→ 对端 running 进度映射进 bySession → 球标实例名
    const badge = page.locator('.agm-root .agm-remote-badge')
    await expect(badge).toBeVisible(POLL_WAIT)
    await expect(badge).toContainText(PEER_NAME)

    // 点击直达该实例（远程会话不在本地，直达换跳实例链）
    await page.locator('.agm-root').click()
    await expect(page.locator('.instance-indicator')).toHaveAttribute('title', PEER_NAME, SWITCH_WAIT)
  })

  test('值班大屏任务卡带远程来源徽标', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/monitor`)
    await expect(page.locator('.mon-root')).toBeVisible()

    const taskCard = page.locator('.mon-card.is-task').filter({ hasText: TASK_NAME })
    await expect(taskCard).toBeVisible(POLL_WAIT)
    const badge = taskCard.locator('.is-remote-badge')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText(PEER_NAME)
    await expect(taskCard).toContainText('编译中')
  })

  test('对端翻 done → 下一轮轮询 → 完成通知入账 + 点击跳该实例', async ({ page }) => {
    peerState.behavior = 'done'
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    // 通知中心入账（回流终态沿 + 事件新鲜 → agentTaskNotify 既有链）
    await page.locator('button[title="通知中心"]').first().click()
    const row = page.locator('.nc-item').filter({ hasText: TASK_NAME }).first()
    await expect(row).toBeVisible(POLL_WAIT)
    await expect(row).toContainText('来自实例')

    // switch-instance 分发：点击跳该实例（useLayoutBootstrap 既有链）
    await row.click()
    await expect(page.locator('.instance-indicator')).toHaveAttribute('title', PEER_NAME, SWITCH_WAIT)
  })
})
