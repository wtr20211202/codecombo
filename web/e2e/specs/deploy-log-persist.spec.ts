import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 部署日志长期留档落盘（P-20261007-8，P-142 二阶段）E2E：GET /api/deploy/
 * :taskId/log 从「1h 内存窗直出」升级为双源幂等——内存窗内（终态 1h TTL）优先
 * 内存直出（X-Deploy-Log-Source: memory），内存 miss（TTL 过期/进程重启）回源
 * 车道 2 留档快照 <DataDir>/artifacts/deploy-logs/<taskId>.log（终态收尾点落
 * 盘，寿命同任务记录 30 天），双源皆无维持 410 稳定标记语义。
 *
 * 真实部署依赖远端 SSH，本 spec 沿 deploy-log-download 先例种「注定失败」任务
 * （回环死端口拒连秒失败），终态收尾点真实执行落盘链。锁定三段契约：
 *   1. API 链路（无数据面依赖）：真实失败部署 → 窗内下载 200 + memory 来源
 *      标注 + 全文（终态行在位）——P-142 原语义不回退；
 *   2. 落盘写路径（需数据面定位）：留档文件随终态真实产出，含任务头与终态行；
 *   3. 读回链路（需数据面直写，approval-timeout「数据面直改」同法）：
 *      播种「内存窗外」历史任务（deploytasks 文档 + 留档文件——运行中服务的
 *      filestore Get 每次读盘即时可见）→ 200 + persisted 来源标注 + 全文回放；
 *      只播种任务记录不落留档（升级前终态/首启前历史任务形态）→ 410 + 稳定
 *      标记 deploy log expired 语义不变。
 *
 * 数据面直写与文件断言依赖测试侧与实例同机文件系统，跨拓扑结构性不可达：
 * 数据面按候选探测（SC_E2E_DATA_DIR → .e2e-data/full-<port> → .e2e-data）且
 * 以 pid 文件端口与 API_BASE 一致确认「确是本实例」，定位不到则 skip（环境
 * 门控，deploy-restart-sweep 同法），用例 1 不依赖数据面恒可跑。
 * 播种主机在 afterAll 清理；播种的任务文档与留档文件一并在数据面移除。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const HOST_NAME = 'deploy-log-persist'
const DEAD_PORT = 59997
// 数据面播种的历史任务 id（filestore validKey 黑名单语义：纯 ASCII 下划线安全）
const HIST_TASK_ID = 'sc_dt_e2e_logpersist_hist'
const NOART_TASK_ID = 'sc_dt_e2e_logpersist_noart'
// 服务端 410 稳定标记原文（server/deploy/logexport.go LogExpiredMarker——对外契约）
const EXPIRED_MARKER = 'deploy log expired'

const PORT = Number(new URL(BASE).port) || 9999
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

interface HostMeta { id: string; name: string; host: string }

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 幂等造主机 + 触发死端口部署并等到 failed（拒连秒失败，任务记录/日志/落盘链照常真跑）
async function seedFailedDeploy(
  request: APIRequestContext,
  headers: Record<string, string>,
): Promise<string> {
  const hosts = await (await request.get(`${BASE}/api/remotehosts`, { headers })).json()
  let host = ((hosts?.data || []) as HostMeta[]).find(h => h.name === HOST_NAME)
  if (!host) {
    const createRes = await fetch(`${BASE}/api/remotehosts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: HOST_NAME, host: '127.0.0.1', port: DEAD_PORT, user: 'e2e', authType: 'password', password: 'e2e' }),
    })
    expect(createRes.ok).toBeTruthy()
    host = ((await createRes.json()) as { data?: HostMeta }).data
  }
  expect(host?.id).toBeTruthy()

  const trigRes = await fetch(`${BASE}/api/deploy`, {
    method: 'POST',
    headers,
    // init_user 无必填参数（deploy-restart-sweep 同法，触发载荷最小）
    body: JSON.stringify({ hostId: host!.id, instances: [{ deployerId: 'init_user', params: {} }] }),
  })
  expect(trigRes.ok).toBeTruthy()
  const taskId = ((await trigRes.json()) as { taskId?: string }).taskId || ''
  expect(taskId).toBeTruthy()

  let status = ''
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`${BASE}/api/deploy/${taskId}`, { headers })
    status = ((await r.json()) as { data?: { status?: string } }).data?.status || ''
    if (status === 'failed' || status === 'completed' || status === 'cancelled') break
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  expect(status).toBe('failed')
  return taskId
}

// ── 数据面定位（deploy-restart-sweep 同款：pid 文件确认本实例）──

function pidPort(dir: string): number {
  try {
    const lines = fs.readFileSync(path.join(dir, 'codecombo.pid'), 'utf-8').trim().split('\n')
    return Number(lines[1]) || 0
  } catch {
    return 0
  }
}

function instanceDataDir(): string {
  const dirs: string[] = []
  if (process.env.SC_E2E_DATA_DIR) dirs.push(path.resolve(repoRoot, process.env.SC_E2E_DATA_DIR))
  dirs.push(path.join(repoRoot, '.e2e-data', `full-${PORT}`))
  dirs.push(path.join(repoRoot, '.e2e-data'))
  return dirs.find(dir => pidPort(dir) === PORT) ?? ''
}

// 数据面直写一条 deploytasks 文档（filestore 布局 <dataDir>/data/<kind>/<key>.json，
// seedQueuedDoc 同法；status failed=内存窗外历史任务的终态形态）
function seedTaskDoc(dataDir: string, taskId: string, hostLabel: string): void {
  const dir = path.join(dataDir, 'data', 'deploytasks')
  fs.mkdirSync(dir, { recursive: true })
  const now = new Date().toISOString()
  const doc = {
    id: taskId,
    hostId: 'e2e-persist-host',
    host: hostLabel,
    instances: [{ deployerId: 'init_user', params: {} }],
    status: 'failed',
    error: 'init_user: boom',
    currentIndex: 0,
    currentStep: '',
    startedAt: now,
    finishedAt: now,
  }
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(doc))
}

// 数据面直写留档快照（RenderLogText 渲染终形——服务端读回即纯字节直出）
function seedPersistedLog(dataDir: string, taskId: string, hostLabel: string): void {
  const dir = path.join(dataDir, 'artifacts', 'deploy-logs')
  fs.mkdirSync(dir, { recursive: true })
  const body = [
    'codecombo deploy log',
    `task:     ${taskId}`,
    `host:     ${hostLabel}`,
    'status:   failed',
    'error:    init_user: boom',
    '',
    `${new Date().toISOString()} [info] start: task started, 1 instances`,
    `${new Date().toISOString()} [fail] done: task failed: e2e seeded historical line`,
    '',
  ].join('\n')
  fs.writeFileSync(path.join(dir, `${taskId}.log`), body)
}

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const hosts = await (await request.get(`${BASE}/api/remotehosts`, { headers })).json()
  for (const h of ((hosts?.data || []) as HostMeta[])) {
    if (h.name === HOST_NAME) {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
  // 播种的任务文档与留档文件一并清（实例数据面留残留会进部署历史列表）
  const dataDir = instanceDataDir()
  if (dataDir) {
    for (const id of [HIST_TASK_ID, NOART_TASK_ID]) {
      fs.rmSync(path.join(dataDir, 'data', 'deploytasks', `${id}.json`), { force: true })
      fs.rmSync(path.join(dataDir, 'artifacts', 'deploy-logs', `${id}.log`), { force: true })
    }
  }
})

test('API 链路：真实失败部署窗内下载 200 + memory 来源标注 + 全文（P-142 语义不回退）', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const taskId = await seedFailedDeploy(request, headers)

  const res = await request.get(`${BASE}/api/deploy/${taskId}/log`, { headers })
  expect(res.status()).toBe(200)
  // 双源读路之实时窗源：终态 1h 内存窗内优先内存直出
  expect(res.headers()['x-deploy-log-source']).toBe('memory')
  expect(res.headers()['content-type']).toContain('text/plain')
  expect(res.headers()['content-disposition'] || '').toContain('attachment')
  const body = await res.text()
  expect(body).toContain('codecombo deploy log')
  expect(body).toContain(`task:     ${taskId}`)
  expect(body).toContain('status:   failed')
  expect(body).toContain('start: task started')
  expect(body).toContain('done: task failed')
})

test('落盘写路径：留档文件随终态真实产出且含任务头与终态行', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const dataDir = instanceDataDir()
  test.skip(!dataDir,
    `persisted-file assertion needs the instance data dir of :${PORT} (pid file recording the same port)`)

  const taskId = await seedFailedDeploy(request, headers)
  const logFile = path.join(dataDir, 'artifacts', 'deploy-logs', `${taskId}.log`)
  expect(fs.existsSync(logFile)).toBe(true)
  const content = fs.readFileSync(logFile, 'utf-8')
  expect(content).toContain(`task:     ${taskId}`)
  expect(content).toContain('status:   failed')
  expect(content).toContain('done: task failed')
})

test('读回链路：内存窗外历史任务回源落盘得全文 + persisted 标注；无留档 410 语义不变', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const dataDir = instanceDataDir()
  test.skip(!dataDir,
    `data-plane seeding needs the instance data dir of :${PORT} (pid file recording the same port)`)

  const hostLabel = `127.0.0.1:${DEAD_PORT}`
  // 播种「内存窗外」历史任务：任务记录 + 留档快照（进程从未见过它，内存必 miss）
  seedTaskDoc(dataDir, HIST_TASK_ID, hostLabel)
  seedPersistedLog(dataDir, HIST_TASK_ID, hostLabel)

  const res = await request.get(`${BASE}/api/deploy/${HIST_TASK_ID}/log`, { headers })
  expect(res.status()).toBe(200)
  // 双源读路之留档回放源：内存 miss 回源落盘快照
  expect(res.headers()['x-deploy-log-source']).toBe('persisted')
  expect(res.headers()['content-disposition'] || '').toContain('attachment')
  const body = await res.text()
  expect(body).toContain(`task:     ${HIST_TASK_ID}`)
  expect(body).toContain('start: task started')
  expect(body).toContain('e2e seeded historical line')

  // 只播种任务记录不落留档（升级前终态/首启前历史任务形态）→ 410 + 稳定标记，
  // 「明确不可下载」契约原样（blob 错误体解析契约不回退）
  seedTaskDoc(dataDir, NOART_TASK_ID, hostLabel)
  const gone = await request.get(`${BASE}/api/deploy/${NOART_TASK_ID}/log`, { headers })
  expect(gone.status()).toBe(410)
  expect(await gone.text()).toContain(EXPIRED_MARKER)
})
