import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import type { Socket } from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 部署任务重启中断收尾（P-20261003-326）：服务重启会掐断所有在途部署任务，
 * 但存库记录停留在 running/queued——Manager.running 内存态随进程清零，没有
 * 谁再把它们推进终态，历史列表永远显示「进行中」假态。服务端在 module Init
 * 期把两类假态收尾为 failed（Error=稳定标记 "deploy task interrupted by
 * service restart"，server/deploy/module.go RestartInterruptedMarker）。
 *
 * 真重启模拟（本 spec 自管实例生命周期，不依赖编排器重启）：
 *   1. 静默 TCP 服务（deploy-host-mutex 同款）让首任务稳定停在 running；
 *      queued 假态无法经 API 造（queued→running 窗口毫秒级），经数据面直写
 *      deploytasks 文档（approval-timeout.spec 直改数据面同法，新 key 无并发
 *      写者，无竞态）；回环死端口触发真实部署做「重启前已终态」对照样本；
 *   2. 经实例二进制 CLI stop→start 真重启（数据面保留，不清空）——重启链在
 *      独立 detached 进程执行（tests/restart-instance.mjs，防 Playwright
 *      worker 清杀进程树内的孙进程守护），清扫在生产挂载点（Module.Init）
 *      随新进程执行；
 *   3. 断言：原 running 与播种 queued 均为 failed 且 Error=稳定标记（列表
 *      与单查双断言）；重启前已失败的对照记录原因原样（终态不被触碰）。
 *
 * 时序韧性：播种/重启/断言全在用例体内（beforeAll 不随重试重跑，重试需能
 * 自愈重播种）；同名主机若端口漂移（上次运行的静默端口已失效）删旧重建；
 * 重启后的首批请求经 fetchWithRetry 兜住旧 keep-alive 连接的 ECONNRESET。
 *
 * 环境门控：二进制/数据面定位不到、或数据面 PID 文件端口与 API_BASE 不一致
 * （打错实例，如漏设 PLAYWRIGHT_BASE_URL 直跑 npx——重启链会误伤无关实例）
 * 则 skip。直改数据面与实例 CLI 重启依赖测试侧同机文件系统，跨拓扑结构性
 * 不可达。播种主机在 afterAll 清理；清扫产生的 failed 记录留历史（实例重启
 * 清数据面即消失），行定位按任务 id 不受残留影响。
 */

// 无人监听的回环端口：SSH 拒连秒失败（对照终态样本用，不产生真实远端副作用）
const DEAD_PORT = 59999
// 服务端 RestartInterruptedMarker（server/deploy/module.go）——对外契约原文
const RESTART_MARKER = 'deploy task interrupted by service restart'

interface HostMeta {
  id: string
  name: string
  host: string
  port: number
  user: string
}

const PORT = Number(new URL(API_BASE).port) || 9999
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// 静默 TCP 服务：accept 后不发任何字节——SSH 版本交换挂起，任务稳定在途
// （deploy-host-mutex 同款）。socket 必须吞掉 'error'（ECONNRESET）：本 spec
// 会真杀挂连接的服务进程（deploy-host-mutex 不杀进程，无此形态）——对端进程
// 离世其连接以 RST 收场，无 handler 的 socket error 是 uncaught exception，
// 会以裸 `read ECONNRESET` 打死整个用例
function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const sockets = new Set<Socket>()
    const server = net.createServer((socket) => {
      sockets.add(socket)
      socket.on('close', () => sockets.delete(socket))
      socket.on('error', () => sockets.delete(socket))
      // 故意不回应：挂起对端 SSH 握手
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo
      resolve({
        port: addr.port,
        close: () =>
          new Promise((res) => {
            for (const s of sockets) s.destroy()
            server.close(() => res())
          }),
      })
    })
  })
}

// fetch 网络错误重试：重启瞬间旧 keep-alive 连接被进程离世 RST（ECONNRESET），
// undici 不自动重试——新连接重发即可，仅兜网络层错误，HTTP 状态原样放行
async function fetchWithRetry(url: string, init?: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init)
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw lastErr
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetchWithRetry(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// GET + 响应体一起重试：响应头已到（服务端 200 落日志）但 body 读被 keep-alive
// 连接收尾 RST 的形态（read ECONNRESET）在重启窗口实测出现——json() 必须纳入
// 重试面；GET 幂等可安全重发
async function apiGet(path: string, headers: Record<string, string>): Promise<any> {
  let lastErr: unknown
  for (let i = 0; i < 4; i++) {
    try {
      const res = await fetch(`${API_BASE}${path}`, { headers })
      return ((await res.json()) as any)?.data
    } catch (e) {
      lastErr = e
      await new Promise(r => setTimeout(r, 500))
    }
  }
  throw lastErr
}

// 幂等造主机：同名且同地址端口复用；否则删旧重建——静默服务端口每次运行
// 都不同（SO_REUSEADDR 0 随机），沿用上次运行的残留主机只会指向死端口
async function seedHost(headers: Record<string, string>, name: string, port: number): Promise<HostMeta> {
  const hosts = (await apiGet('/api/remotehosts', headers)) || []
  const existing = hosts.find((h: HostMeta) => h.name === name)
  if (existing && existing.host === '127.0.0.1' && existing.port === port) return existing
  if (existing) {
    await fetchWithRetry(`${API_BASE}/api/remotehosts/${existing.id}`, { method: 'DELETE', headers })
  }
  const res = await fetchWithRetry(`${API_BASE}/api/remotehosts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name, host: '127.0.0.1', port,
      user: 'e2erun', authType: 'password', password: 'e2e-not-used',
    }),
  })
  expect(res.ok).toBeTruthy()
  return (await (res.json() as any)).data as HostMeta
}

async function triggerDeploy(headers: Record<string, string>, hostId: string): Promise<string> {
  // init_user 无必填参数，触发载荷最小（deploy-host-mutex 同法）
  const res = await fetchWithRetry(`${API_BASE}/api/deploy`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ hostId, instances: [{ deployerId: 'init_user', params: {} }] }),
  })
  expect(res.ok).toBeTruthy()
  const { taskId } = (await res.json()) as { taskId: string }
  expect(taskId).toBeTruthy()
  return taskId
}

async function getTask(headers: Record<string, string>, taskId: string): Promise<{ status?: string; error?: string }> {
  return (await apiGet(`/api/deploy/${taskId}`, headers)) || {}
}

async function waitTaskStatus(
  headers: Record<string, string>,
  taskId: string,
  want: string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const t = await getTask(headers, taskId)
    if (t?.status && want.includes(t.status)) return t.status
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`task ${taskId} did not reach ${want.join('/')} in time`)
}

// ── 实例工件定位（重启模拟的前提）──

// PID 文件行格式：pid\nport\n（scheme/loopback…），读第二行端口
function pidPort(dir: string): number {
  try {
    const lines = fs.readFileSync(path.join(dir, 'codecombo.pid'), 'utf-8').trim().split('\n')
    return Number(lines[1]) || 0
  } catch {
    return 0
  }
}

// 数据面候选（approval-timeout.spec 同序）：SC_E2E_DATA_DIR（e2e-restart 注入）
// → 全量分片 .e2e-data/full-<port> → 默认 .e2e-data；以 codecombo.pid 在场
// 确认「确是本实例的数据面」
function dataDirCandidates(): string[] {
  const dirs: string[] = []
  if (process.env.SC_E2E_DATA_DIR) dirs.push(path.resolve(repoRoot, process.env.SC_E2E_DATA_DIR))
  dirs.push(path.join(repoRoot, '.e2e-data', `full-${PORT}`))
  dirs.push(path.join(repoRoot, '.e2e-data'))
  return dirs.filter(dir => fs.existsSync(path.join(dir, 'codecombo.pid')))
}

// 实例二进制（e2e-restart.sh 惯例名 .sc-tmp/polish-e2e-<port>.exe；Linux go
// build -o 同名落盘，.exe 后缀无平台语义）
function instanceBinary(): string | undefined {
  for (const name of [`polish-e2e-${PORT}.exe`, `polish-e2e-${PORT}`]) {
    const p = path.join(repoRoot, '.sc-tmp', name)
    if (fs.existsSync(p)) return p
  }
  return undefined
}

// 数据面直写一条 deploytasks 文档（filestore 布局 <dataDir>/data/<kind>/<key>.json；
// key 走 filestore validKey 黑名单语义，纯 ASCII 下划线安全）
function seedQueuedDoc(dataDir: string, taskId: string, host: HostMeta): void {
  const dir = path.join(dataDir, 'data', 'deploytasks')
  fs.mkdirSync(dir, { recursive: true })
  const doc = {
    id: taskId,
    hostId: host.id,
    host: `${host.host}:${host.port}`,
    instances: [{ deployerId: 'init_user', params: {} }],
    status: 'queued',
    currentIndex: 0,
    currentStep: '',
    startedAt: new Date().toISOString(),
  }
  fs.writeFileSync(path.join(dir, `${taskId}.json`), JSON.stringify(doc))
}

// 真重启：交给独立 detached 进程执行 stop→start→就绪轮询（tests/restart-instance.mjs），
// 结果经文件回传。不经本 worker 直接 execFile——Playwright worker 会在用例
// 结束/崩溃时清杀自己进程树内的子进程，CLI start 拉起的守护进程（孙进程）
// 实测刚就绪即随树被收；detached helper 退出后守护进程成孤儿存活，与 worker
// 进程树解耦。清扫在生产挂载点（Module.Init）随新进程执行
async function restartInstance(binary: string, dataDir: string): Promise<void> {
  const resultFile = path.join(repoRoot, '.sc-tmp', `restart-sweep-result-${PORT}.json`)
  fs.rmSync(resultFile, { force: true })
  const helper = path.join(repoRoot, 'web', 'tests', 'restart-instance.mjs')
  const child = spawn(process.execPath, [helper, binary, dataDir, String(PORT), resultFile], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  const deadline = Date.now() + 150000
  while (Date.now() < deadline) {
    if (fs.existsSync(resultFile)) {
      const r = JSON.parse(fs.readFileSync(resultFile, 'utf-8')) as { ok: boolean; error: string }
      if (!r.ok) throw new Error(`instance restart failed: ${r.error}`)
      return
    }
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error('restart helper did not report within 150s')
}

let silentSrv: { port: number; close: () => Promise<void> } | undefined
const queuedTaskId = 'sc_dt_e2e_restart_queued'

test.afterAll(async () => {
  await silentSrv?.close().catch(() => { /* 尽力清理 */ })
  try {
    const headers = await unlockHeaders()
    const hosts = (await apiGet('/api/remotehosts', headers)) || []
    for (const h of hosts.filter((h: HostMeta) => h.name.startsWith('deploy-restart-sweep'))) {
      await fetchWithRetry(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  } catch { /* 实例不可达时尽力而为 */ }
})

test('重启后 running/queued 假态收尾为 failed 且原因注明；终态对照原样', async () => {
  test.setTimeout(180000)

  // 环境门控（测试体内可随重试重估）：PID 文件记录端口必须与 API_BASE 端口
  // 一致——不一致 = API_BASE 指向别的实例（如漏设 PLAYWRIGHT_BASE_URL 直跑
  // npx），重启链会误伤无关实例，拒跑
  const binary = instanceBinary()
  const dataDir = dataDirCandidates().find(dir => pidPort(dir) === PORT) ?? ''
  test.skip(!binary || !dataDir,
    `restart simulation needs the e2e-restart.sh instance layout of :${PORT} ` +
    `(binary under .sc-tmp/, pid file recording the same port); ` +
    `binary=${binary ?? 'none'} dataDir=${dataDir || 'none'}`)

  const headers = await unlockHeaders()

  // 1. running 假态：静默 TCP 服务 + 真实触发（记录先落盘，SSH 握手挂起在途）
  silentSrv = await startSilentServer()
  const host = await seedHost(headers, 'deploy-restart-sweep', silentSrv.port)
  const liveId = await triggerDeploy(headers, host.id)
  expect(await waitTaskStatus(headers, liveId, ['running'], 15000)).toBe('running')

  // 2. queued 假态：毫秒窗口无法经 API 造，数据面直写（重启后随清扫收尾）
  seedQueuedDoc(dataDir, queuedTaskId, host)

  // 3. 终态对照：回环死端口拒连秒失败，重启前已落终态
  const deadHost = await seedHost(headers, 'deploy-restart-sweep-dead', DEAD_PORT)
  const deadId = await triggerDeploy(headers, deadHost.id)
  await waitTaskStatus(headers, deadId, ['failed'], 20000)

  // 4. 真重启（数据面保留）→ Module.Init 清扫
  await restartInstance(binary!, dataDir)

  // 5. 原 running 假态：failed + 稳定标记原因（单查 + 列表双断言）
  const live = await getTask(headers, liveId)
  expect(live.status).toBe('failed')
  expect(live.error).toBe(RESTART_MARKER)
  const list = (await apiGet('/api/deploy/tasks', headers)) || []
  const liveInList = list.find((t: { id: string }) => t.id === liveId)
  expect(liveInList?.status).toBe('failed')
  expect(liveInList?.error).toBe(RESTART_MARKER)

  // 6. 播种 queued 假态：同收尾（running/queued 两类假态一体清扫）
  const queued = await getTask(headers, queuedTaskId)
  expect(queued.status).toBe('failed')
  expect(queued.error).toBe(RESTART_MARKER)

  // 7. 终态对照：重启前真实失败的原样（状态/原因都不被清扫触碰）
  const dead = await getTask(headers, deadId)
  expect(dead.status).toBe('failed')
  expect(dead.error || '').not.toContain(RESTART_MARKER)
  expect(dead.error || '').toContain('ssh dial')
})
