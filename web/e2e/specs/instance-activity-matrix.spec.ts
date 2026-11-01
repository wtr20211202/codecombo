import { test, expect, type APIRequestContext } from '@playwright/test'
import http from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 联邦活动热力 E2E（P-20261004-98）：多实例负载对比矩阵 + 值班大屏联邦活动卡。
 *   1. API：GET /api/instances/activity-matrix——本机行（self 恒排最前，直读
 *      本地序列）+ 对端行三态（ok 带 series/totals / unreachable 死对端失败
 *      隔离 / unsupported 旧对端无 activity 端点 404 降级）+ Bearer 令牌透传
 *      + TTL 缓存（窗口内重复调用零对端扇出）
 *   2. UI：值班大屏联邦活动卡渲染（每实例一行迷你热力 + 活跃度汇总值 + 状态
 *      标签），点击 ok 行沿实例切换链到达对端（切换流程向对端拉项目清单 =
 *      切换链完成的可观测信号）
 *
 * 对端实例用 spec 进程内最小 HTTP 真身模拟（fleet-overview/instance-dispatch
 * 同款先例）：被测面 = 中心聚合 + 失败隔离 + 缓存 + 卡片渲染；对端 activity
 * 产数业务（日报发报链）有 Go 单测，真身按 /api/reports/activity 协议回答即可。
 *
 * 缓存与重跑鲁棒性：服务端聚合缓存 5 分钟、e2e 数据面跨跑复用（.e2e-data）——
 * 断言全部做成「相对」形态（行按名过滤、缓存命中数比较增量而非绝对值），
 * 前跑残留缓存/残留实例不产生假红；beforeAll 先清自己前缀的历史注册防同名行。
 */

const BASE = API_BASE
const OK_NAME = 'e2e-matrix-ok'
const OK_TOKEN = 'sc_e2e_matrix_token'
const OLD_NAME = 'e2e-matrix-old'
const DEAD_NAME = 'e2e-matrix-dead'
const SELF_BADGE = '本机'
const MATRIX_DAYS = 14

let unlockToken = ''
let okInstanceId = ''
let oldInstanceId = ''
let deadInstanceId = ''
let okPeer: http.Server
let oldPeer: http.Server
let okPort = 0

// ok 对端请求记账：activity 拉取次数（缓存断言）、Bearer 令牌（透传断言）、
// days query（参数透传断言）、projects 拉取次数（UI 切换链断言——背景探活只打
// /api/settings，只有切换流程的 fetchProjects 会打 /api/projects）
const okState = {
  activityHits: 0,
  projectsHits: 0,
  lastAuth: '',
  lastDays: '',
}

function okHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/reports/activity')) {
    okState.activityHits++
    okState.lastAuth = req.headers.authorization || ''
    okState.lastDays = new URL(req.url, 'http://x').searchParams.get('days') || ''
    res.setHeader('Content-Type', 'application/json')
    // 两天静态序列（形状与 server/api/report.ListActivity 同 envelope）
    res.end(JSON.stringify({
      data: [
        { date: '2026-10-17', commits: 2, sessions: 1, commands: 3 },
        { date: '2026-10-18', commits: 4, sessions: 2, commands: 5 },
      ],
    }))
    return
  }
  if (req.url?.startsWith('/api/projects')) {
    okState.projectsHits++
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: [] }))
    return
  }
  if (req.url?.startsWith('/api/settings')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-matrix-e2e' } }))
    return
  }
  res.statusCode = 404
  res.end('not the endpoint the matrix path hits')
}

function oldHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '0.0.9-pre-p37' } }))
    return
  }
  // P-37 前旧版本：activity 端点不存在（404 降级路径的被测面）
  res.statusCode = 404
  res.end(JSON.stringify({ error: '404 page not found' }))
}

async function api(request: APIRequestContext, method: string, url: string, body?: unknown) {
  return request.fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    data: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function registerInstance(request: APIRequestContext, name: string, url: string, token: string): Promise<string> {
  const res = await api(request, 'POST', '/api/instances', { name, url, token })
  expect(res.ok(), `注册实例 ${name} 应成功`).toBeTruthy()
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(id).toBeTruthy()
  return id
}

test.beforeAll(async ({ request }) => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 前跑残留清理（崩溃跳过 afterAll 的形态）：清自己前缀的注册防同名行干扰
  const listRes = await api(request, 'GET', '/api/instances')
  const existing = ((await listRes.json()) as { data?: Array<{ id: string; name: string }> }).data || []
  for (const inst of existing) {
    if ([OK_NAME, OLD_NAME, DEAD_NAME].includes(inst.name)) {
      await api(request, 'DELETE', `/api/instances/${inst.id}`).catch(() => { /* 尽力而为 */ })
    }
  }

  okPeer = http.createServer(okHandler)
  await new Promise<void>(resolve => okPeer.listen(0, '127.0.0.1', resolve))
  okPort = (okPeer.address() as AddressInfo).port
  oldPeer = http.createServer(oldHandler)
  await new Promise<void>(resolve => oldPeer.listen(0, '127.0.0.1', resolve))

  // 死对端：找一个当前无人监听的端口（连接拒绝即时失败，无须等超时）
  const deadPort = await new Promise<number>(resolve => {
    const l = net.createServer()
    l.listen(0, '127.0.0.1', () => {
      const port = (l.address() as AddressInfo).port
      l.close(() => resolve(port))
    })
  })

  okInstanceId = await registerInstance(request, OK_NAME, `http://127.0.0.1:${okPort}`, OK_TOKEN)
  oldInstanceId = await registerInstance(request, OLD_NAME, `http://127.0.0.1:${(oldPeer.address() as AddressInfo).port}`, '')
  deadInstanceId = await registerInstance(request, DEAD_NAME, `http://127.0.0.1:${deadPort}`, '')
})

test.afterAll(async ({ request }) => {
  okPeer?.close()
  oldPeer?.close()
  for (const id of [okInstanceId, oldInstanceId, deadInstanceId]) {
    if (id) {
      await api(request, 'DELETE', `/api/instances/${id}`).catch(() => { /* 尽力而为 */ })
    }
  }
})

interface MatrixRow {
  instanceId: string
  name: string
  self: boolean
  status: 'ok' | 'unreachable' | 'unsupported'
  series?: Array<{ date: string; commits: number; sessions: number; commands: number }>
  totals?: { commits: number; sessions: number; commands: number }
}

async function fetchMatrix(request: APIRequestContext, query = '') {
  const res = await api(request, 'GET', `/api/instances/activity-matrix${query}`)
  expect(res.ok(), '矩阵端点应 200').toBeTruthy()
  return ((await res.json()) as { data?: { days: number; rows: MatrixRow[] } }).data || { days: 0, rows: [] }
}

test('API：聚合三态行 + Bearer 透传 + TTL 缓存', async ({ request }) => {
  // 对端真身与注册 URL 都在测试侧 127.0.0.1：跨拓扑（Windows Playwright 打
  // WSL 服务实例）结构性不可达——服务端拉取全落 unreachable，仅同机拓扑
  //（Windows 全量 / WSL 门禁）可断言三态（fleet-overview 存活态门控同款）
  test.skip(serverIsRemote, '对端真身在测试侧 127.0.0.1，跨拓扑 NAT 不可达——仅同机拓扑')
  const body = await fetchMatrix(request)
  expect(body.days).toBe(MATRIX_DAYS)

  // 本机行恒排最前（self 基线，直读本地序列——序列可能为空，状态必 ok）
  const selfRow = body.rows[0]
  expect(selfRow.self, '首行恒为本机行').toBeTruthy()
  expect(selfRow.status).toBe('ok')

  const byName = new Map(body.rows.map(r => [r.name, r]))
  const okRow = byName.get(OK_NAME)
  const oldRow = byName.get(OLD_NAME)
  const deadRow = byName.get(DEAD_NAME)
  expect(okRow && oldRow && deadRow, '三个对端行都在列').toBeTruthy()

  // ok 对端：序列升序 + 合计 + Bearer 实例令牌透传 + days 缺省 14
  expect(okRow!.status).toBe('ok')
  expect(okRow!.series?.map(e => e.date)).toEqual(['2026-10-17', '2026-10-18'])
  expect(okRow!.totals).toEqual({ commits: 6, sessions: 3, commands: 8 })
  // 服务端缓存命中时本跑可能零拉取（重跑鲁棒），拉过则形态必对
  if (okState.activityHits > 0) {
    expect(okState.lastAuth).toBe(`Bearer ${OK_TOKEN}`)
    expect(okState.lastDays).toBe(String(MATRIX_DAYS))
  }

  // 旧对端（P-37 前无 activity 端点）：404 降级 unsupported，不带序列
  expect(oldRow!.status).toBe('unsupported')
  expect(oldRow!.series).toBeUndefined()

  // 死对端：连接拒绝 → unreachable（失败隔离——ok 行不受影响，上面已断言）
  expect(deadRow!.status).toBe('unreachable')
  expect(deadRow!.series).toBeUndefined()

  // TTL 缓存：窗口内重复调用零对端扇出（增量比较对重跑缓存免疫）
  const hitsBefore = okState.activityHits
  await fetchMatrix(request)
  expect(okState.activityHits).toBe(hitsBefore)
})

test('UI：大屏联邦活动卡渲染 + 行点击切换实例', async ({ page }) => {
  test.skip(serverIsRemote, 'ok 行状态与切换目标依赖服务端可达测试侧对端——仅同机拓扑')
  test.setTimeout(60_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/monitor`)

  const card = page.locator('[data-testid="monitor-federation-card"]')
  await expect(card).toBeVisible({ timeout: 10_000 })

  // 本机行恒首（self 徽标），三个对端行按名在列
  const selfRow = card.locator('[data-testid="monitor-federation-row"]').first()
  await expect(selfRow).toContainText(SELF_BADGE)
  const okRow = card.locator('[data-testid="monitor-federation-row"]').filter({ hasText: OK_NAME })
  const oldRow = card.locator('[data-testid="monitor-federation-row"]').filter({ hasText: OLD_NAME })
  const deadRow = card.locator('[data-testid="monitor-federation-row"]').filter({ hasText: DEAD_NAME })
  await expect(okRow).toHaveCount(1)
  await expect(oldRow).toHaveCount(1)
  await expect(deadRow).toHaveCount(1)

  // ok 行：14 格迷你热力（date/level 属性）+ 活跃度汇总值；无失败标签
  await expect(okRow.locator('[data-testid="monitor-federation-cells"] .fac-cell')).toHaveCount(MATRIX_DAYS)
  await expect(okRow.locator('[data-testid="monitor-federation-score"]')).not.toHaveText('')
  await expect(okRow.locator('[data-testid="monitor-federation-status"]')).toHaveCount(0)

  // 失败隔离两行：状态标签不打断整卡渲染
  await expect(oldRow.locator('[data-testid="monitor-federation-status"]')).toHaveText('不支持')
  await expect(deadRow.locator('[data-testid="monitor-federation-status"]')).toHaveText('不可达')

  // 点击 ok 行沿实例切换链到达对端：切换流程向对端拉项目清单（背景探活只打
  // /api/settings，projects 计数增长 = 切换链完成的可观测信号）
  const projectsBefore = okState.projectsHits
  await okRow.click()
  await expect.poll(() => okState.projectsHits, { timeout: 15_000 }).toBeGreaterThan(projectsBefore)
})
