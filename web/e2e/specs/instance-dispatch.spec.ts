import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import http from 'node:http'
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 联邦会话派发 E2E（P-20261004-101）：
 *   1. API 契约：POST /api/instances/:id/dispatch 转发创建——对端真身收到的
 *      请求携 Bearer 实例令牌与 kind=agent 载荷；响应回传远端会话标识；
 *      对端 400 预检稳定标记原文透传（KNOWN_ERROR_I18N 跨实例同文案映射的
 *      契约面）；审计 instance.dispatch 成功/失败双入账
 *   2. UI 双入口：新建会话对话框「目标实例」下拉选从实例 → 提交派发 →
 *      就地成功反馈 + 对端收到创建；通知中心「已派发到…」点击跳该实例
 *      （switch-instance action → 实例切换链）
 *
 * 对端实例用 spec 进程内的最小 HTTP 真身模拟（fleet-overview 同款先例）：
 * dispatch 的被测面 = 中心转发 + 失败透传 + 双入口 + 通知跳转；对端
 * terminals 业务（运行时预检/命名/降级）有自己的 Go 单测，真身不重复实现，
 * 按 /api/terminals 协议回答即可走通同一转发路径。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-dispatch-peer'
const PEER_TOKEN = 'sc_e2e_dispatch_token'
const PEER_CLAIM_ID = 'e2e-dispatch-claim'
const CLAIM_PROJ_NAME = 'e2e-dispatch-anchor'
const DISPATCH_NAME = 'e2e 派发会话'
// 对端 400 预检稳定标记（与本地 POST /api/terminals 同文案，透传契约）
const PRECHECK_400 = 'runtime codex is not installed or not in the service process path'

let unlockToken = ''
let instanceId = ''
let peer: http.Server
let peerPort = 0
// fleet 行动入口夹具：临时 git 仓作 claim 锚点（fleet-overview 同款）
let claimRepo = ''
let claimProjectId = ''

// 对端真身状态：记录最后一次转发请求 + 可注入行为
const peerState = {
  lastAuth: '',
  lastBody: {} as Record<string, unknown>,
  // 'ok' 正常创建 / 'precheck400' 预检失败稳定标记
  behavior: 'ok',
}

function peerHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-dispatch-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/terminals') && req.method === 'POST') {
    peerState.lastAuth = req.headers.authorization || ''
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c.toString() })
    req.on('end', () => {
      try { peerState.lastBody = JSON.parse(raw || '{}') } catch { peerState.lastBody = {} }
      if (peerState.behavior === 'precheck400') {
        res.setHeader('Content-Type', 'application/json')
        res.statusCode = 400
        res.end(JSON.stringify({ error: PRECHECK_400 }))
        return
      }
      const body = peerState.lastBody as { name?: string }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        data: {
          id: 'term-peer-e2e',
          name: body.name || 'peer-auto-named',
          kind: 'agent',
          runtime: 'shell',
          launched: true,
        },
      }))
    })
    return
  }
  res.statusCode = 404
  res.end('not the endpoint the dispatch path hits')
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  return { 'X-Lock-Token': ((await res.json()) as { token?: string }).token || '' }
}

test.beforeAll(async ({ request }) => {
  unlockToken = (await unlockHeaders(request))['X-Lock-Token']

  peer = http.createServer(peerHandler)
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  peerPort = (peer.address() as AddressInfo).port

  // 注册对端为实例（带令牌——派发鉴权的前提）
  const res = await request.post(`${BASE}/api/instances`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    data: { name: PEER_NAME, url: `http://127.0.0.1:${peerPort}`, token: PEER_TOKEN },
  })
  expect(res.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()

  // fleet 行动入口夹具：临时 git 仓注册为项目 + 播对端 claim（端口指真身，
  // 族表探活即判活）——fleet-overview.spec 同款手法
  claimRepo = mkdtempSync(path.join(tmpdir(), 'sc-dispatch-e2e-'))
  execSync('git init', { cwd: claimRepo })
  const addRes = await request.post(`${BASE}/api/projects`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    // 注册路径交服务端必须经 serverPath 翻译（跨拓扑对账口径，dualpath 门禁）；
    // 测试侧 git init/claim 播种/清理维持本地原路径
    data: { name: CLAIM_PROJ_NAME, path: serverPath(claimRepo) },
  })
  expect(addRes.ok(), '注册 claim 锚点项目应成功').toBeTruthy()
  claimProjectId = ((await addRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(claimProjectId).toBeTruthy()
  const now = new Date().toISOString()
  const claimDir = path.join(claimRepo, '.git', 'simple-coding', 'project-claims')
  mkdirSync(claimDir, { recursive: true })
  writeFileSync(path.join(claimDir, `${PEER_CLAIM_ID}.json`), JSON.stringify({
    instanceId: PEER_CLAIM_ID,
    port: peerPort,
    startedAt: now,
    updatedAt: now,
  }))
})

test.afterAll(async ({ request }) => {
  peer?.close()
  if (instanceId) {
    await request.delete(`${BASE}/api/instances/${instanceId}`, {
      headers: { 'X-Lock-Token': unlockToken },
    }).catch(() => { /* 尽力而为 */ })
  }
  if (claimProjectId) {
    await request.delete(`${BASE}/api/projects/${claimProjectId}`, {
      headers: { 'X-Lock-Token': unlockToken },
    }).catch(() => { /* 尽力而为 */ })
  }
  if (claimRepo) rmSync(claimRepo, { recursive: true, force: true })
  // 派发通知不入共享实例长账（notify-jump 等通知域 spec 的清理同款惯例）
  await request.post(`${BASE}/api/notifications/clear`, {
    headers: { 'X-Lock-Token': unlockToken },
  }).catch(() => { /* 尽力而为 */ })
})

test('API：派发转发创建 + 失败透传 + 审计', async ({ request }) => {
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  // 成功路径：转发形态与响应回传
  peerState.behavior = 'ok'
  const res = await request.post(`${BASE}/api/instances/${instanceId}/dispatch`, {
    headers,
    data: { name: DISPATCH_NAME, runtime: 'shell' },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as {
    data?: { remoteSessionId?: string; remoteSessionName?: string; instanceId?: string; instanceUrl?: string; runtime?: string }
  }
  expect(body.data?.remoteSessionId).toBe('term-peer-e2e')
  expect(body.data?.remoteSessionName).toBe(DISPATCH_NAME)
  expect(body.data?.instanceId).toBe(instanceId)
  expect(body.data?.instanceUrl).toContain(`127.0.0.1:${peerPort}`)
  // 对端收到的请求形态：Bearer 令牌 + kind=agent 载荷
  expect(peerState.lastAuth).toBe(`Bearer ${PEER_TOKEN}`)
  expect(peerState.lastBody.kind).toBe('agent')
  expect(peerState.lastBody.name).toBe(DISPATCH_NAME)

  // 失败路径：对端 400 预检稳定标记原文透传（状态码 + error 原文）
  peerState.behavior = 'precheck400'
  const res2 = await request.post(`${BASE}/api/instances/${instanceId}/dispatch`, {
    headers,
    data: { runtime: 'codex' },
  })
  expect(res2.status()).toBe(400)
  const err2 = (await res2.json()) as { error?: string }
  expect(err2.error).toBe(PRECHECK_400)
  peerState.behavior = 'ok'

  // 审计：成功 + 失败均入账（跨实例操作可溯）
  const audit = await request.get(`${BASE}/api/audit?limit=100`, { headers: { 'X-Lock-Token': unlockToken } })
  const events = ((await audit.json()) as { data?: Array<{ action?: string; result?: string; detail?: string }> }).data || []
  const mine = events.filter(e => e.action === 'instance.dispatch')
  expect(mine.length).toBeGreaterThanOrEqual(2)
  expect(mine.some(e => e.result === 'success' && (e.detail || '').includes(`instance=${PEER_NAME}`))).toBeTruthy()
  expect(mine.some(e => e.result === 'failure')).toBeTruthy()
})

test.describe.serial('UI 双入口与通知跳转', () => {
  async function openSessionDialog(page: Page) {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    // 活动栏「终端会话管理」→ 管理页 → 新建会话对话框
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.getByRole('button', { name: '新建会话' }).first().click()
    const dlg = page.locator('.n-modal', { hasText: '新建智能体会话' })
    await expect(dlg).toBeVisible({ timeout: 5000 })
    return dlg
  }

  test('对话框选从实例派发：成功反馈 + 对端会话出现', async ({ page }) => {
    const dlg = await openSessionDialog(page)

    // 「目标实例」下拉出现（注册了从实例），选对端（可用态徽标可能后缀 ●，
    // hasText 锚名称即可）
    await dlg.locator('.n-form-item').filter({ hasText: '目标实例' }).locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: PEER_NAME }).click()

    // 运行时 = 纯终端（shell 一等选项，确定性不依赖本机 agent）
    await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
    // 会话名（按表单行定位，勿用裸 input 下标——目标实例/运行时两枚选择器
    // 各含一个 filter input，下标随表单行漂移）
    await dlg.locator('.n-form-item').filter({ hasText: '会话名' }).locator('input').first().fill(DISPATCH_NAME)

    await dlg.getByRole('button', { name: '创建', exact: true }).click()
    await expect(dlg).toBeHidden({ timeout: 15000 })
    // 就地成功反馈（「已派发到 <实例>：<会话名>」）
    await expect(page.locator('.n-message').filter({ hasText: '已派发到' })).toBeVisible({ timeout: 10000 })
    // 对端收到创建（会话出现在对端 = 转发创建落地）
    expect(peerState.lastBody.kind).toBe('agent')
    expect(peerState.lastBody.name).toBe(DISPATCH_NAME)
  })

  test('通知「已派发到…」点击跳转该实例', async ({ page }) => {
    // 清通知后走一次真实派发：同文案通知会聚合成分组行（groupKey 含
    // title+body），分组行首击是展开而非激活——单条未分组行才能驱动点击跳转
    await page.request.post(`${BASE}/api/notifications/clear`, {
      headers: { 'X-Lock-Token': unlockToken },
    })
    peerState.behavior = 'ok'
    const res = await page.request.post(`${BASE}/api/instances/${instanceId}/dispatch`, {
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
      data: { name: DISPATCH_NAME, runtime: 'shell' },
    })
    expect(res.ok()).toBeTruthy()

    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })

    const row = page.locator('.nc-item').filter({ hasText: '已派发到' }).first()
    await expect(row).toBeVisible({ timeout: 5000 })
    await row.click()

    // switch-instance 分发：实例切换链到达对端（指示器 title = 当前实例展示名）
    await expect(page.locator('.instance-indicator')).toHaveAttribute('title', PEER_NAME, { timeout: 15000 })
  })

  test('fleet 总览行动作「在此实例新建会话」：对话框预选目标实例', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/project`)

    // 实例菜单直达族表（fleet-overview 同款）；claim 播了对端端口 → 行在列且判活
    await page.locator('.rail-instance').first().click()
    await page.locator('[data-testid="menu-instance-fleet"]').click()
    const modal = page.locator('.n-modal').filter({ hasText: '实例族总览' }).first()
    await expect(modal).toBeVisible({ timeout: 8000 })
    const peerRow = modal.locator('[data-testid="fleet-row"]').filter({ hasText: `:${peerPort}` })
    await expect(peerRow).toHaveCount(1)
    // 按端口回查注册实例成立 → 派发行动作在场
    const dispatchBtn = peerRow.locator('[data-testid="fleet-dispatch"]')
    await expect(dispatchBtn).toBeVisible({ timeout: 15000 })
    await dispatchBtn.click()

    // 族表收起、智能体管理页拉起、对话框打开且目标实例已预选对端
    await expect(modal).toBeHidden({ timeout: 5000 })
    const dlg = page.locator('.n-modal', { hasText: '新建智能体会话' })
    await expect(dlg).toBeVisible({ timeout: 10000 })
    const selection = dlg.locator('.n-form-item').filter({ hasText: '目标实例' }).locator('.n-base-selection')
    await expect(selection).toContainText(PEER_NAME, { timeout: 5000 })
    await dlg.getByRole('button', { name: '取消' }).click()
    await expect(dlg).toBeHidden({ timeout: 5000 })
  })
})
