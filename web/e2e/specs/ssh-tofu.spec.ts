import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * SSH 主机密钥 TOFU 指纹钉扎 E2E（P-20261003-34）：
 *   1. 生命周期（API 层，实流）：一次性投掷 sshd（WSL 内高端口 2488、独立
 *      主机钥）→ 首连钉扎 → 同端口换钥 → 连接被拒（host key has changed）→
 *      重置恢复（重新钉新钥）→ per-host 关闭开关旁路换钥
 *   2. 主机设置分区（UI）：编辑弹窗展示钉扎指纹 + 重置入口走通（入审计/通知）
 *
 * 环境门控（与 remote-* 实流用例同惯例）：WSL sshd 可达（端口以播种的主机
 * 记录为准，槽位专用实例非 23，P-20261004-115）+ 播种的 WSL 主机
 * 记录（scripts/e2e-seed-wsl.sh）+ e2e 密钥文件。投掷 sshd 的生命周期全部经
 * 服务端 exec API 在 WSL 内完成（spec 不直接调 wsl.exe），sshd 以 pidfile 管理，
 * 换钥 = kill → ssh-keygen 重生成 → 同端口重启（真实的密钥轮换场景）。
 * 审计断言走 /api/audit（变更拒绝/重置都应留痕——P-13 同路记账口）。
 */

const BASE = API_BASE
const RPORT = 2488 // 投掷 sshd 端口（WSL 内 0.0.0.0 监听，Windows 经 WSL 端口转发可达）
const HK = '/tmp/.e2e-tofu-hk' // 投掷 sshd 主机钥路径（换钥即重生成此文件）
const PIDFILE = '/tmp/.e2e-tofu-sshd.pid'
const MARKER = 'host key has changed' // 服务端稳定标记（hostKeyChangedMarker，前端映射同源）
const HOST_NAME = `tofu-e2e-${Math.random().toString(36).slice(2, 8)}`

// 投掷 sshd 的授权键文件：默认读 ~/.ssh/authorized_keys，槽位专用实例（
// P-20261004-115）下播种只装 authorized_keys-e2e-<port>、共享文件不保证有本槽
// 钥匙——显式指定播种器维护的文件，两种形态都自洽
function authKeysFile(port: number): string {
  return port === 23 ? '/root/.ssh/authorized_keys' : `/root/.ssh/authorized_keys-e2e-${port}`
}

// e2e 密钥（仓库级 keys/ 共享层）：playwright 调用方 cwd 有两种形态——
// web/（e2e-worktree.sh / 全量分片）或仓库根；逐一探测兼容（ESM 无 __dirname）
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

/** 等 Windows→WSL 端口转发就绪：WSL 内已监听 ≠ Windows 侧立即可达
 *（localhostForwarding 对新端口的转发异步建立），轮询到真连通为止 */
async function waitTcpReady(port: number, timeoutMs = 10000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await tcpReachable(port, 800)) return true
    await new Promise(resolve => setTimeout(resolve, 500))
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

/** 经指定主机的 exec API 在远端跑命令（拨号本身即被测 TOFU 面的一部分） */
async function execOn(headers: Record<string, string>, hostId: string, cmd: string): Promise<ExecBody> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/exec`, {
    method: 'POST', headers, body: JSON.stringify({ cmd }),
  })
  return (await res.json()) as ExecBody
}

/** 在 WSL 内（重）起投掷 sshd：kill 旧实例（pidfile）→ 重生成主机钥 → 同端口重启。
 *  杀旧必须连「会话子进程」一并收割：sshd 的每连接会话子进程各自 setsid()
 *  （自成会话/进程组，为控管终端铺路），按监听器 pgid 组杀够不着它们——且
 *  「杀监听器不断既有会话」本就是 sshd 惯常行为（systemctl restart sshd 同理），
 *  服务端 SSH 连接池（P-20261005-159）对存活连接跳过 Dial/TOFU 复检（「同一
 *  信任连接」语义，pool.go 注记），漏杀会话会让换钥后的 exec 仍跑在旧会话上
 *  绕过拒绝断言（实测：ESTAB 连接的 sshd 会话子进程跨轮换存活）。本用例模拟
 *  的是「服务器重装」（真实场景所有连接全断），收割即对该场景的忠实模拟；
 *  子进程必须在监听器在世时按 --ppid 枚举收割（监听器先死会孤儿化 reparent），
 *  再杀监听器本体 */
async function restartThrowawaySshd(headers: Record<string, string>, wslHostId: string): Promise<boolean> {
  const sshdOpts = `-o ListenAddress=0.0.0.0 -o PasswordAuthentication=no -o PubkeyAuthentication=yes ` +
    `-o StrictModes=no -o PidFile=${PIDFILE} -o AuthorizedKeysFile=${authKeysFile(wslPort)}`
  const reap =
    `TP=$(cat ${PIDFILE} 2>/dev/null); ` +
    `CP=$(ps -o pid= --ppid "$TP" 2>/dev/null | tr -s ' \\t' '\\n'); ` +
    `kill -TERM $CP 2>/dev/null; kill "$TP" 2>/dev/null; sleep 0.3; kill -KILL $CP 2>/dev/null; true`
  const cmd =
    `${reap}; rm -f ${PIDFILE} ${HK} ${HK}.pub; ` +
    `ssh-keygen -t ed25519 -N '' -f ${HK} -q && mkdir -p /run/sshd && ` +
    `/usr/sbin/sshd -p ${RPORT} -h ${HK} ${sshdOpts}; sleep 0.5; ss -tln | grep -q ':${RPORT} ' && echo ROTATED`
  for (let i = 0; i < 3; i++) {
    const out = await execOn(headers, wslHostId, cmd)
    if ((out.stdout || '').includes('ROTATED')) return true
    await new Promise(resolve => setTimeout(resolve, 1200))
  }
  return false
}

async function getHostKey(headers: Record<string, string>, hostId: string): Promise<{ pinned?: boolean; fingerprint?: string; algo?: string }> {
  const res = await fetch(`${BASE}/api/remotehosts/${hostId}/hostkey`, { headers })
  return ((await res.json()) as { data?: { pinned?: boolean; fingerprint?: string; algo?: string } }).data || {}
}

async function auditHasAction(headers: Record<string, string>, action: string): Promise<boolean> {
  const res = await fetch(`${BASE}/api/audit?limit=50`, { headers })
  const events = ((await res.json()) as { data?: Array<{ action?: string }> }).data || []
  return events.some(e => e.action === action)
}

let wslUp = false
let wslHostId = ''
let wslPort = 23
let tofuHostId = ''
let rotated = false
const headers: Record<string, string> = {}

test.beforeAll(async () => {
  Object.assign(headers, await unlockHeaders())
  // 先取播种记录再探针：端口以记录为准（槽位专用实例非 23，P-20261004-115）
  const wslHost = await fetchWslHost(BASE)
  wslHostId = wslHost?.id || ''
  wslPort = wslHost?.port || 23
  wslUp = await tcpReachable(wslPort)
  let pem = ''
  try { pem = fs.readFileSync(KEY_FILE, 'utf8') } catch { pem = '' }
  if (wslUp && wslHostId && pem) {
    const create = await fetch(`${BASE}/api/remotehosts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: HOST_NAME, host: '127.0.0.1', port: RPORT, user: 'root',
        authType: 'pem', protocol: 'sftp', pemContent: pem,
      }),
    })
    const created = ((await create.json()) as { data?: { id?: string } }).data
    tofuHostId = created?.id || ''
    if (tofuHostId) rotated = await restartThrowawaySshd(headers, wslHostId) && await waitTcpReady(RPORT)
  }
})

test.afterAll(async () => {
  if (!headers['X-Lock-Token']) return
  if (tofuHostId) {
    await fetch(`${BASE}/api/remotehosts/${tofuHostId}`, { method: 'DELETE', headers }) // 级联清指纹钉扎
  }
  if (wslUp && wslHostId) {
    await execOn(headers, wslHostId, `kill $(cat ${PIDFILE}) 2>/dev/null; rm -f ${PIDFILE} ${HK} ${HK}.pub; true`)
  }
  await fetch(`${BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('TOFU 生命周期：首连钉扎 → 换钥拒绝 → 重置恢复 → 关闭开关旁路', async () => {
  test.skip(!tofuHostId || !rotated, 'WSL / 投掷 sshd 未就绪（需 WSL sshd + e2e 密钥）')
  test.setTimeout(120_000)

  // 归一化：重置到未钉扎基线（重跑自愈）
  const reset0 = await fetch(`${BASE}/api/remotehosts/${tofuHostId}/hostkey/reset`, { method: 'POST', headers })
  expect(reset0.ok).toBeTruthy()
  expect((await getHostKey(headers, tofuHostId!)).pinned).toBe(false)

  // 首连：TOFU 记录指纹并放行
  const first = await execOn(headers, tofuHostId!, 'echo tofu-first-ok')
  expect(first.ok, `first exec should pass: ${JSON.stringify(first)}`).toBe(true)
  const pin1 = await getHostKey(headers, tofuHostId!)
  expect(pin1.pinned).toBe(true)
  expect(pin1.fingerprint, 'fingerprint should be SHA256: style').toMatch(/^SHA256:[A-Za-z0-9+/]+=*$/)
  expect(pin1.algo).toBe('ssh-ed25519')
  const fpA = pin1.fingerprint!

  // 同端口换钥（模拟服务器重装）→ 连接拒绝、旧钉扎保留、审计留痕
  expect(await restartThrowawaySshd(headers, wslHostId!) && await waitTcpReady(RPORT), 'rotate host key').toBe(true)
  const rejected = await execOn(headers, tofuHostId!, 'echo should-not-run')
  expect(rejected.ok).toBe(false)
  expect(rejected.error || '').toContain(MARKER)
  const pin2 = await getHostKey(headers, tofuHostId!)
  expect(pin2.fingerprint).toBe(fpA)
  expect(await auditHasAction(headers, 'hostkey.mismatch')).toBe(true)

  // 重置（合法迁移入口）→ 重连放行并钉新钥；重置入审计与通知中心
  const reset = await fetch(`${BASE}/api/remotehosts/${tofuHostId}/hostkey/reset`, { method: 'POST', headers })
  expect(reset.ok).toBeTruthy()
  expect((await getHostKey(headers, tofuHostId!)).pinned).toBe(false)
  expect(await auditHasAction(headers, 'hostkey.reset')).toBe(true)
  const notifs = ((await (await fetch(`${BASE}/api/notifications`, { headers })).json()) as {
    data?: Array<{ title?: string }>
  }).data || []
  expect(notifs.some(n => (n.title || '').includes('主机指纹')), 'reset should notify').toBe(true)

  const recovered = await execOn(headers, tofuHostId!, 'echo tofu-recovered')
  expect(recovered.ok, `exec after reset should pass: ${JSON.stringify(recovered)}`).toBe(true)
  const pin3 = await getHostKey(headers, tofuHostId!)
  expect(pin3.pinned).toBe(true)
  expect(pin3.fingerprint).not.toBe(fpA)
  const fpB = pin3.fingerprint!

  // per-host 关闭开关：再换钥后放行（旁路），钉扎不更新
  const put = await fetch(`${BASE}/api/remotehosts/${tofuHostId}`, {
    method: 'PUT', headers, body: JSON.stringify({ hostKeyVerifyDisabled: true }),
  })
  expect(put.ok).toBeTruthy()
  expect(await restartThrowawaySshd(headers, wslHostId!) && await waitTcpReady(RPORT), 'rotate again for bypass').toBe(true)
  const bypassed = await execOn(headers, tofuHostId!, 'echo tofu-bypassed')
  expect(bypassed.ok, `exec with verify disabled should bypass TOFU: ${JSON.stringify(bypassed)}`).toBe(true)
  expect((await getHostKey(headers, tofuHostId!)).fingerprint).toBe(fpB)

  // 还原开关（删除主机在 afterAll 级联清理）
  await fetch(`${BASE}/api/remotehosts/${tofuHostId}`, {
    method: 'PUT', headers, body: JSON.stringify({ hostKeyVerifyDisabled: false }),
  })
})

test('主机设置分区：钉扎指纹展示 + 重置入口走通（UI）', async ({ page }) => {
  test.skip(!tofuHostId, 'WSL / 投掷 sshd 未就绪')
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.home-action-btn[title="设置"]').click()
  await page.locator('.settings-nav .nav-item').filter({ hasText: '远程部署' }).click()
  const row = page.locator('.host-row').filter({ hasText: `root@127.0.0.1:${RPORT}` }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.host-actions .n-button').last().click()
  await page.locator('.n-dropdown-option').filter({ hasText: '编辑' }).first().click()

  // 主机密钥校验分区可见：开关 + 指纹/未记录态
  const section = page.locator('.n-modal').filter({ hasText: '主机密钥校验' })
  await expect(section).toBeVisible({ timeout: 10000 })
  await expect(section.locator('.hostkey-switch')).toBeVisible()
  // 等「更多」下拉浮层完全退场——残留浮层会吞掉弹窗内后续首次点击（实测 flaky 源）
  await expect(page.locator('.n-dropdown-option')).toHaveCount(0)
  const fp = section.locator('.hostkey-fp')
  if (await fp.count() > 0) {
    await expect(fp).toContainText('SHA256:')
    // 重置入口走通：确认后回到未记录态。阳性按钮文案随 naive-ui locale 变化
    //（zh=确认 / en=Confirm），按动作区末位按钮定位，不依赖文案
    await section.getByRole('button', { name: '重置指纹' }).click()
    const positive = page.locator('.n-popconfirm .n-popconfirm__action button').last()
    await expect(positive).toBeVisible({ timeout: 5000 })
    await positive.click()
    await expect(section.locator('.hostkey-unpinned')).toBeVisible({ timeout: 10000 })
  } else {
    await expect(section.locator('.hostkey-unpinned')).toBeVisible()
  }
})
