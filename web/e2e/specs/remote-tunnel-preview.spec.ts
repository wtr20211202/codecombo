import { test, expect } from '@playwright/test'
import net from 'node:net'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, projectCardByName, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程主机端口预览穿透 E2E（P-20261004-5，SSH 本地转发隧道）：
 *   1. 隧道 REST 生命周期：开（同 key 幂等复用）/ 列表 / 特权端口 400 / 关（二连 404）
 *   2. 转发实流：远端 python http.server → 本机映射口 fetch 200（目录列表文案）
 *   3. 预览联动：ops-notify preview.port 带 hostId → 悬浮球「预览 :N」→ 面板
 *      iframe 实打隧道口（/preview/<localPort>/）+「remote:N → local:M」徽标
 *   4. 回收：DELETE 后映射口拒绝连接（列表清空）
 * 环境门控（与 remote-console 的 wslUp 同惯例）：WSL sshd 可达（端口以播种的
 * WSL 主机记录为准，槽位专用实例非 23，P-20261004-115）+ 播种的
 * WSL 主机记录（scripts/e2e-seed-wsl.sh）；远端测试服务经 exec API 在 WSL 内
 * 起 python http.server，起不来时仅转发/联动/回收用例 skip，REST 生命周期不受影响。
 * 重试安全：beforeAll 起服务先 pkill（幂等），开隧道服务端幂等复用（重跑自愈）
 */

const BASE = API_BASE
const RPORT = 8977 // 远端测试服务端口（WSL 内回环）
const SVC_TAG = `http.server ${RPORT}`

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface TunnelInfo { hostId?: string; remotePort?: number; localPort?: number }

let hostId = ''
let wslUp = false
let svcUp = false

/** 开（或复用）隧道并返回映射口（服务端同 key 幂等）。Node 全局 fetch：ok 为属性 */
async function ensureTunnel(headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ remotePort: RPORT }),
  })
  expect(res.ok, `open tunnel: ${res.status}`).toBeTruthy()
  const info = ((await res.json()) as { data?: TunnelInfo }).data
  expect(info?.localPort, 'localPort should be allocated').toBeTruthy()
  return info!.localPort!
}

/** 经 exec API 在远端起/探测试服务：返回 curl HTTP 码文本（非 200 即未就绪） */
async function remoteExec(headers: Record<string, string>, cmd: string): Promise<string> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/exec`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ cmd }),
  })
  const body = (await res.json()) as { ok?: boolean; stdout?: string; error?: string }
  return body.error ? `EXEC_ERR:${body.error}` : (body.stdout || '').trim()
}

async function startRemoteService(headers: Record<string, string>): Promise<boolean> {
  // pkill 单独一发（模式用 [.] 防自杀匹配）：与启动命令合并在同一条里会命中
  // 该条命令行后半段的 python3 -m http.server，把整个会话杀掉（exit 143）
  await remoteExec(headers, `pkill -f 'http[.]server ${RPORT}' 2>/dev/null; true`)
  const start =
    `nohup python3 -m ${SVC_TAG} --bind 127.0.0.1 >/tmp/.e2e-tunnel-svc.log 2>&1 & sleep 1; ` +
    `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${RPORT}/`
  for (let i = 0; i < 3; i++) {
    const out = await remoteExec(headers, start)
    if (out === '200') return true
    await new Promise(resolve => setTimeout(resolve, 1500))
  }
  return false
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 先取播种记录再探针：端口以记录为准（槽位专用实例非 23，P-20261004-115）
  const wslHost = await fetchWslHost(BASE)
  hostId = wslHost?.id || ''
  wslUp = await tcpReachable(wslHost?.port || 23)
  if (wslUp && hostId) svcUp = await startRemoteService(headers)
})

test.afterAll(async () => {
  // 清隧道 + 远端服务 + 通知（重试/失败中断兜底；全部幂等尽力而为）
  if (!hostId) return
  const headers = await unlockHeaders()
  const list = ((await (await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, { headers })).json()) as {
    data?: TunnelInfo[]
  }).data || []
  for (const t of list) {
    if (t.localPort) await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels/${t.localPort}`, { method: 'DELETE', headers })
  }
  if (wslUp) await remoteExec(headers, `pkill -f 'http[.]server ${RPORT}' 2>/dev/null; true`)
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('隧道 REST 生命周期：开（幂等复用）→ 列表 → 特权端口 400 → 关（二连 404）', async () => {
  test.skip(!hostId, 'WSL 主机记录未播种（scripts/e2e-seed-wsl.sh）')
  test.setTimeout(60000)
  const headers = await unlockHeaders()

  const localPort = await ensureTunnel(headers)
  // 幂等复用：同 host+remotePort 二开返回同一映射口（不重复占口）
  expect(await ensureTunnel(headers)).toBe(localPort)

  // 列表：含该隧道（localPort 对得上）
  const list = ((await (await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, { headers })).json()) as {
    data?: TunnelInfo[]
  }).data || []
  expect(list.some(t => t.localPort === localPort && t.remotePort === RPORT)).toBe(true)

  // 特权端口拒绝（与预览面板 1024~65535 同口径）
  for (const p of [23, 80, 0, 70000]) {
    const res = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, {
      method: 'POST', headers, body: JSON.stringify({ remotePort: p }),
    })
    expect(res.status, `remotePort=${p}`).toBe(400)
  }

  // 关闭：二连 404（第二次已不存在）
  const del = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels/${localPort}`, { method: 'DELETE', headers })
  expect(del.ok).toBeTruthy()
  const del2 = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels/${localPort}`, { method: 'DELETE', headers })
  expect(del2.status).toBe(404)
})

test('隧道转发实流：远端 http.server → 本机映射口 fetch 200', async () => {
  test.skip(!hostId || !svcUp, 'WSL/远端测试服务未就绪')
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  const localPort = await ensureTunnel(headers)

  // 经隧道口 fetch：远端 python http.server 的目录列表页应原样可达
  const deadline = Date.now() + 10000
  let body = ''
  let lastErr: unknown = null
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${localPort}/`)
      body = await res.text()
      if (res.ok) break
    } catch (e) {
      lastErr = e
    }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  expect(body, `forward failed: ${String(lastErr)}`).toContain('Directory listing for')
})

test('预览联动：preview.port 带 hostId → 悬浮球直达 → 隧道口 iframe + remote→local 徽标', async ({ page }) => {
  test.skip(!hostId || !svcUp, 'WSL/远端测试服务未就绪')
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  const localPort = await ensureTunnel(headers)

  // 预置悬浮球形态 + 进项目页（预览面板挂在项目页底部，同 preview-port-event 范式）
  await page.addInitScript(([key, value]) => {
    localStorage.setItem(key, value)
  }, ['sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' })])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)

  // 等 WS 桥建立后播种 preview.port 带 hostId；页面应自行调 tunnels 端点开隧道
  const tunnelResp = page.waitForResponse(
    r => r.url().includes(`/api/remotehosts/${hostId}/tunnels`) && r.request().method() === 'POST',
    { timeout: 15000 },
  ).catch(() => null)
  await page.request.post(`${BASE}/api/ops-notify`, {
    headers,
    data: { type: 'preview.port', payload: { port: RPORT, label: 'e2e remote dev', hostId } },
  })
  // 前端隧道桥就位（映射口可能与服务端既有隧道不同：以页面实际响应为准）
  const resp = await tunnelResp
  expect(resp, '前端应经隧道桥调 POST tunnels').not.toBeNull()
  const bridged = ((await resp!.json()) as { data?: TunnelInfo }).data
  expect(bridged?.localPort).toBeTruthy()
  await page.waitForTimeout(500) // attachTunnel 微任务落位

  // 悬浮球按钮（展示口径为远端端口）→ 点击直达
  const mini = page.locator('body > .agm-root')
  const previewBtn = mini.locator('.agm-preview-btn')
  await expect(previewBtn).toContainText(`预览 :${RPORT}`, { timeout: 8000 })
  await previewBtn.click()

  // 面板：输入框/iframe 都是实际加载的隧道口（面板既有语义：输入=实打端口），
  // 徽标回显用户口径的远端口映射 remote:N → local:M
  await expect(page.locator('.preview-panel')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.preview-port-input input')).toHaveValue(String(bridged!.localPort))
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', new RegExp(`/preview/${bridged!.localPort}/`), { timeout: 8000 })
  await expect(page.locator('.preview-tunnel-badge')).toContainText(`远程 :${RPORT} → 本机 :${bridged!.localPort}`)
})

test('隧道回收：DELETE 后映射口拒绝连接、列表清空', async () => {
  test.skip(!hostId, 'WSL 主机记录未播种')
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  const localPort = await ensureTunnel(headers)

  const del = await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels/${localPort}`, { method: 'DELETE', headers })
  expect(del.ok).toBeTruthy()

  const list = ((await (await fetch(`${BASE}/api/remotehosts/${hostId}/tunnels`, { headers })).json()) as {
    data?: TunnelInfo[]
  }).data || []
  expect(list.some(t => t.remotePort === RPORT)).toBe(false)

  // 映射口拒绝连接（监听已关；同口理论可被内核复用，轮询数秒内必拒绝）
  let refused = false
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (!(await tcpReachable(localPort, 800))) { refused = true; break }
    await new Promise(resolve => setTimeout(resolve, 300))
  }
  expect(refused, 'localPort should refuse connections after close').toBe(true)
})
