import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 远程接入（SSH 反向隧道，P-20261019-11）E2E：
 *   用 WSL 里的投掷 sshd 充当用户自有 VPS 中继（AllowTcpForwarding +
 *   GatewayPorts clientspecified），实例主动连它并请求远端监听；随后从
 *   Windows 侧访问 relay 端口，请求应经 SSH 隧道回到本实例主服务。
 *
 * 覆盖：
 *   1. API 生命周期：预检 → 启动 → status=online/publicUrl → 经 relay 端口
 *      访问 /api/health → 停止 → 端口不可达 + 审计 remoteaccess.tunnel.start
 *   2. UI：设置·远程接入分区——预检通过、启用（TLS 未启用时显式确认）、
 *      在线状态与公网 URL/二维码、停止
 *
 * 环境门控（remote-* 实流用例同惯例）：WSL sshd 可达 + 播种的 WSL 主机记录
 * + e2e 密钥。sshd 生命周期全部经服务端 exec API 在 WSL 内完成。
 */

const BASE = API_BASE
const SSH_PORT = 2491 // 投掷中继的 SSH 端口（WSL→Windows 转发可达）
const RELAY_PORT = 22291 // 远端监听端口（经隧道回到实例主端口）
const HK = '/tmp/.e2e-ra-hk'
const PIDFILE = '/tmp/.e2e-ra-sshd.pid'
const PROFILE_NAME = `ra-e2e-${Math.random().toString(36).slice(2, 8)}`

function authKeysFile(port: number): string {
  return port === 23 ? '/root/.ssh/authorized_keys' : `/root/.ssh/authorized_keys-e2e-${port}`
}

function resolveKeyFile(): string {
  const cwd = process.cwd()
  for (const p of [
    path.resolve(cwd, '..', '.e2e-data', 'keys', 'wsl-e2e'),
    path.resolve(cwd, '.e2e-data', 'keys', 'wsl-e2e'),
  ]) {
    if (fs.existsSync(p)) return p
  }
  return path.resolve(cwd, '..', '.e2e-data', 'keys', 'wsl-e2e')
}
const KEY_FILE = resolveKeyFile()

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

async function waitTcpReady(port: number, timeoutMs = 12000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tcpReachable(port, 800)) return true
    await new Promise(r => setTimeout(r, 500))
  }
  return false
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

interface ExecBody { ok?: boolean; stdout?: string; error?: string; exitCode?: number }

async function execOn(headers: Record<string, string>, hostId: string, cmd: string): Promise<ExecBody> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/exec`, {
    method: 'POST', headers, body: JSON.stringify({ cmd }),
  })
  return (await res.json()) as ExecBody
}

async function startRelaySshd(headers: Record<string, string>, wslHostId: string, wslPort: number): Promise<boolean> {
  const opts = `-o ListenAddress=0.0.0.0 -o AllowTcpForwarding=yes -o GatewayPorts=clientspecified ` +
    `-o PasswordAuthentication=no -o PubkeyAuthentication=yes -o StrictModes=no ` +
    `-o PidFile=${PIDFILE} -o AuthorizedKeysFile=${authKeysFile(wslPort)}`
  const reap =
    `TP=$(cat ${PIDFILE} 2>/dev/null); CP=$(ps -o pid= --ppid "$TP" 2>/dev/null | tr -s ' \\t' '\\n'); ` +
    `kill -TERM $CP 2>/dev/null; kill "$TP" 2>/dev/null; sleep 0.3; kill -KILL $CP 2>/dev/null; true`
  const cmd =
    `${reap}; rm -f ${PIDFILE} ${HK} ${HK}.pub; ` +
    `ssh-keygen -t ed25519 -N '' -f ${HK} -q && mkdir -p /run/sshd && ` +
    `/usr/sbin/sshd -p ${SSH_PORT} -h ${HK} ${opts}; sleep 0.5; ` +
    `ss -tln | grep -q ':${SSH_PORT} ' && echo RELAY_SSHD_UP`
  for (let i = 0; i < 3; i++) {
    const out = await execOn(headers, wslHostId, cmd)
    if ((out.stdout || '').includes('RELAY_SSHD_UP')) return true
    await new Promise(r => setTimeout(r, 1200))
  }
  return false
}

async function getSettings(headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${BASE}/api/settings`, { headers })
  return ((await res.json()) as any).data || {}
}

async function putRemoteAccess(headers: Record<string, string>, profiles: any[]): Promise<boolean> {
  const res = await fetch(`${BASE}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ remoteAccess: { profiles } }),
  })
  return res.ok
}

async function control(headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${BASE}/api/remoteaccess/tunnel`, {
    method: 'POST', headers, body: JSON.stringify(body),
  })
}

async function getStatus(headers: Record<string, string>): Promise<any> {
  const res = await fetch(`${BASE}/api/remoteaccess/tunnel`, { headers })
  return ((await res.json()) as any).data || {}
}

async function relayHealth(): Promise<string> {
  try {
    const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/api/health`, { signal: AbortSignal.timeout(3000) })
    return res.ok ? await res.text() : ''
  } catch {
    return ''
  }
}

let wslHostId = ''
let wslPort = 23
let sshdUp = false
let keyID = ''
let profileID = ''
let baselineProfiles: any[] = []
let lockWasEnabled = false
const headers: Record<string, string> = {}

/** 启停锁定功能（特权操作需当前密码；金态默认关闭，隧道门槛要求开启） */
async function setRelayLockEnabled(enabled: boolean): Promise<boolean> {
  const res = await fetch(`${BASE}/api/lock/config`, {
    method: 'PUT', headers,
    body: JSON.stringify({ enabled, currentPassword: DEFAULT_PASSWORD }),
  })
  return res.ok
}

test.beforeAll(async () => {
  Object.assign(headers, await unlockHeaders())
  // 金态锁定关闭（e2e-seed 默认），但远程接入门槛要求锁定启用：本用例临时
  // 开启并在 afterAll 还原；默认密码 admin 仍在（仅告警不阻断）
  const lockState = await (await fetch(`${BASE}/api/lock/state`, { headers })).json() as any
  lockWasEnabled = !!lockState.enabled
  if (!lockWasEnabled && !await setRelayLockEnabled(true)) return

  const wslHost = await fetchWslHost(BASE)
  wslHostId = wslHost?.id || ''
  wslPort = wslHost?.port || 23
  const reachable = await tcpReachable(wslPort)
  let pem = ''
  try { pem = fs.readFileSync(KEY_FILE, 'utf8') } catch { pem = '' }
  if (!reachable || !wslHostId || !pem) return

  sshdUp = await startRelaySshd(headers, wslHostId, wslPort) && await waitTcpReady(SSH_PORT)
  if (!sshdUp) return

  // 导入 e2e 密钥（档案走既有 SSH 密钥库；测试结束删除）
  const imp = await fetch(`${BASE}/api/sshkeys/import`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: `${PROFILE_NAME}-key`, privateKey: pem }),
  })
  if (!imp.ok) { sshdUp = false; return }
  keyID = ((await imp.json()) as any)?.data?.id || ''
  if (!keyID) { sshdUp = false; return }

  // 归一基线：停掉可能残留的隧道；保留其它档案，只替换本用例同名档案
  await control(headers, { action: 'stop' })
  const settings = await getSettings(headers)
  baselineProfiles = (settings?.remoteAccess?.profiles || []).filter((p: any) => p.name !== PROFILE_NAME)
  const profiles = baselineProfiles.concat([{
    name: PROFILE_NAME, host: '127.0.0.1', port: SSH_PORT, user: 'root',
    authType: 'sshkey', sshKeyId: keyID,
    remoteBindHost: '0.0.0.0', remotePort: RELAY_PORT, domain: '',
  }])
  if (!await putRemoteAccess(headers, profiles)) { sshdUp = false; return }
  const saved = (await getSettings(headers))?.remoteAccess?.profiles || []
  profileID = saved.find((p: any) => p.name === PROFILE_NAME)?.id || ''
  if (!profileID) { sshdUp = false; return }
  // 每次运行投掷 sshd 都生成新主机钥：清掉上一轮/上一次重试的 TOFU 钉扎
  await fetch(`${BASE}/api/remoteaccess/tunnel/hostkey/reset`, {
    method: 'POST', headers, body: JSON.stringify({ profileId: profileID }),
  }).catch(() => undefined)
})

test.afterAll(async () => {
  if (!headers['X-Lock-Token']) return
  await control(headers, { action: 'stop' }).catch(() => undefined)
  if (profileID) {
    try { await putRemoteAccess(headers, baselineProfiles) } catch { /* best effort */ }
  }
  if (keyID) {
    await fetch(`${BASE}/api/sshkeys/${keyID}`, { method: 'DELETE', headers }).catch(() => undefined)
  }
  if (sshdUp && wslHostId) {
    await execOn(headers, wslHostId, `kill $(cat ${PIDFILE}) 2>/dev/null; rm -f ${PIDFILE} ${HK} ${HK}.pub; true`)
  }
  // 还原锁定开关（关闭会 RevokeAllTokens，必须最后做；恢复后 headers 中
  // 的 token 失效，本用例也到此为止）
  if (!lockWasEnabled) {
    await fetch(`${BASE}/api/lock/unlock`, {
      method: 'POST', headers,
      body: JSON.stringify({ password: DEFAULT_PASSWORD }),
    }).catch(() => undefined)
    await setRelayLockEnabled(false).catch(() => undefined)
  }
})

test('API 生命周期：预检→启动→经中继访问→停止', async () => {
  test.skip(!sshdUp || !profileID, 'WSL / 投掷 sshd / e2e 密钥未就绪')
  test.setTimeout(120_000)

  // 预检：全链路检查通过（WSL 侧 GatewayPorts 已开）
  const probeRes = await fetch(`${BASE}/api/remoteaccess/tunnel/test`, {
    method: 'POST', headers, body: JSON.stringify({ profileId: profileID }),
  })
  expect(probeRes.ok).toBeTruthy()
  const probe = ((await probeRes.json()) as any).data
  expect(probe.ok, `probe steps: ${JSON.stringify(probe.steps)}`).toBe(true)

  // 启动（TLS 未启用时显式确认风险）
  const started = await control(headers, { action: 'start', profileId: profileID, confirmInsecureTls: true })
  expect(started.ok, await started.text()).toBeTruthy()
  const st = await getStatus(headers)
  expect(st.state).toBe('online')
  expect(st.profileId).toBe(profileID)
  expect(st.publicUrl).toContain(`:${RELAY_PORT}`)

  // 从 Windows 直连中继端口：请求经 SSH 隧道回到实例主服务
  await expect.poll(relayHealth, { timeout: 15000 }).toContain('"status":"ok"')

  // 停止：远端监听随连接关闭，端口不再可达
  const stopped = await control(headers, { action: 'stop' })
  expect(stopped.ok).toBeTruthy()
  expect((await getStatus(headers)).state).toBe('stopped')
  await expect.poll(relayHealth, { timeout: 10000 }).toBe('')

  // 审计：启停入账
  const audit = await (await fetch(`${BASE}/api/audit?limit=30`, { headers })).json() as any
  const actions = (audit.data || []).map((e: any) => e.action)
  expect(actions).toContain('remoteaccess.tunnel.start')
  expect(actions).toContain('remoteaccess.tunnel.stop')
})

test('UI：预检/启用/状态与二维码/停止', async ({ page }) => {
  test.skip(!sshdUp || !profileID, 'WSL / 投掷 sshd / e2e 密钥未就绪')
  test.setTimeout(150_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('[data-testid="settings-nav-remoteaccess"]').click()
  const pane = page.locator('[data-testid="settings-pane-remoteaccess"]')
  await expect(pane).toBeVisible({ timeout: 10000 })

  const row = pane.locator('[data-testid^="settings-remote-access-profile-"]').filter({ hasText: PROFILE_NAME })
  await expect(row).toBeVisible({ timeout: 10000 })

  // 预检（编辑态「测试连接」）：逐步结果与总通过态
  await row.getByRole('button', { name: '编辑' }).click()
  await pane.locator('[data-testid="settings-remote-access-test"]').click()
  const probe = pane.locator('[data-testid="settings-remote-access-probe"]')
  await expect(probe).toBeVisible({ timeout: 30000 })
  await expect(probe).toContainText('预检通过', { timeout: 30000 })
  await pane.getByRole('button', { name: '取消' }).click()

  // 启用：先过「切换/启用」确认（若档案已是当前项），再过 TLS 强警示确认
  await row.getByRole('button', { name: '启用 / 切换' }).click()
  const switchDlg = page.locator('.n-dialog').filter({ hasText: '切换到中继' })
  if (await switchDlg.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await switchDlg.getByRole('button', { name: '切换' }).click()
  }
  const tlsDlg = page.locator('.n-dialog').filter({ hasText: 'TLS 未启用' })
  if (await tlsDlg.waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false)) {
    await tlsDlg.getByRole('button', { name: '仍然启用' }).click()
  }
  await expect(pane.locator('.ra-card').first()).toContainText('在线', { timeout: 20000 })
  const urlInput = pane.locator('[data-testid="settings-remote-access-url"] input')
  await expect(urlInput).toHaveValue(new RegExp(`:${RELAY_PORT}`), { timeout: 10000 })

  // 二维码：公网 URL 扫码入口
  await pane.getByRole('button', { name: '二维码', exact: true }).click()
  await expect(pane.locator('.n-qr-code')).toBeVisible()

  // 停止 → 未启用
  await pane.locator('[data-testid="settings-remote-access-stop"]').click()
  await expect(pane.locator('.ra-card').first()).toContainText('未启用', { timeout: 15000 })
})
