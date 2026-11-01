import { test, expect } from '@playwright/test'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 本地-远端同项目 Git 对照（P-20261004-34）E2E：
 *   「远端现在跑的是什么版本？落后本地多少？有没有未提交改动？」一键对照。
 *   0. API：本地项目（Windows 临时仓库，领先远端 1 个提交）对照 WSL 真实
 *      仓库（clone 自本地、含 1 个未跟踪文件）——两端 HEAD/分支/脏计数、
 *      behind=remoteBehind 1、路径记忆回填/清除、非 git 目录降级
 *   1. UI：远程主机卡片「⋯」菜单「与本地对照」→ 弹窗 → 选项目 + 填远端路径
 *      → 三行对照（HEAD 不一致高亮 + 落后文案 + 脏计数）
 * 环境敏感用例（WSL sshd 不可达时）条件跳过；API 用例同样依赖 WSL（远端侧
 * 是真实 SSH 往返），不可达时全部 skip——本地侧解析已有 Go 单测覆盖。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'e2e-gitcmp'
const WSL_DIR = '/tmp/sc-gitcmp-e2e'
const FILE = '.gitcmp-untracked.tmp'
// 环境漂移兜底（仅 legacy 共享形态）：金态 WSL 主机记录是 root@127.0.0.1:23
//（NAT localhost 转发，WSL 重启后可能失联）；本机惯例走 netsh portproxy
// 127.0.0.1:2222 → WSL :22（同一共享 sshd 同一 root 授权，公钥已由 legacy
// 播种装入）。兜底建 spec 私有主机记录指向 2222，金态不动。槽位专用实例
//（记录端口非 23，P-20261004-115）不走此兜底——共享 sshd 的授权键文件与本槽
// 独立实例互不相通，兜底必 auth rejected 假红，不可达时按环境门控 skip
const FALLBACK_PORT = 2222
const FALLBACK_NAME = 'WSL-gitcmp'

let wslUp = false
let projectId = ''
let hostId = ''
let hostName = 'WSL'
let tmpHostCreated = false
let localDir = ''
let localHead = ''
let remoteHead = ''

// WSL sshd 端口可达性预检（端口取播种记录，与 remote-console 同款）
function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

/** 固定参数调用 git（无 shell 拼接），身份 -c 内联不依赖本机 git 配置 */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' }).trim()
}

/** 以 root 在 WSL 内逐「运行中发行版」执行命令。
 *  为什么逐发行版：wsl.exe 缺省发行版名 = 用户默认 distro，而共享 sshd :23 的
 *  持有者由 Windows localhost 转发裁决，两者可以不同（本机默认 distro 漂移后
 *  实测：夹具建在默认 distro、服务端 SSH 落在另一发行版，对照远端读到旧 clone
 *  → 四例同红）。夹具类操作（建仓/建非 git 目录/清理）对每个运行中发行版各跑
 *  一遍（幂等；无 git/无 /mnt/c 的发行版单发静默失败——服务端所在发行版成功
 *  即可，由下方 serverExec 探针定论），远端期望值一律取服务端通道读数 */
function wslEach(script: string): void {
  let distros: string[] = []
  try {
    // wsl.exe -l 输出 UTF-16LE：Node 侧剥 \0
    distros = execFileSync('wsl.exe', ['-l', '-q', '--running'], { encoding: 'utf8', timeout: 30000 })
      .replace(/\0/g, '').split('\n').map(s => s.trim()).filter(Boolean)
  } catch { /* 列举失败：单默认发行版形态退化为零份，探针处报环境门控 */ }
  for (const d of distros) {
    try {
      execFileSync('wsl.exe', ['-d', d, '-u', 'root', '-e', 'bash', '-c', script],
        { encoding: 'utf8', timeout: 60000, env: { ...process.env, WSL_UTF8: '1' } })
    } catch { /* 单发行版失败静默：serverExec 探针兜底定论 */ }
  }
}

/** 服务端 SSH 通道执行（POST /api/remotehosts/:id/exec）——与 git-compare 同一条
 *  远端通路，是远端期望值的权威来源。失败（连接/非零退出）返回空串交调用方
 *  环境门控，不抛——exec 探针兼作「服务端落点发行版 git 可用」的预检 */
async function serverExec(cmd: string): Promise<string> {
  const headers = await unlockHeaders()
  try {
    const res = await fetch(`${API_BASE}/api/remotehosts/${hostId}/exec`, {
      method: 'POST', headers, body: JSON.stringify({ cmd }),
    })
    if (!res.ok) return ''
    const body = (await res.json()) as { ok?: boolean; stdout?: string }
    return body.ok ? (body.stdout || '').trim() : ''
  } catch {
    return ''
  }
}

/** Windows 路径 → WSL /mnt/ 形态（clone 源路径换算） */
function winToWsl(winPath: string): string {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(winPath)
  if (!m) throw new Error(`not a windows path: ${winPath}`)
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

/** e2e 密钥定位：playwright 从 web/ 运行（ESM 无 __dirname），向上找仓库根 */
function findKeyPath(): string {
  let dir = process.cwd()
  for (let i = 0; i < 4; i++) {
    const p = path.join(dir, '.e2e-data', 'keys', 'wsl-e2e')
    if (fs.existsSync(p)) return p
    dir = path.dirname(dir)
  }
  throw new Error('e2e key not found: .e2e-data/keys/wsl-e2e upward from cwd')
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** GET 对照（裸 fetch，带解锁头；400/404 也返回解析后的 body；成功体 = {data: 对照结果}） */
async function apiCompare(host: string, query: string): Promise<{ status: number; body: any }> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/remotehosts/${host}/git-compare?${query}`, { headers })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, body: json?.data ?? json }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 清理历史残留（失败重跑防撞名）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  const hosts = await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()
  const wslHost = ((hosts?.data || []) as { id: string; name: string; port: number; protocol?: string }[])
    .find(h => h.name === 'WSL' && h.protocol !== 'ftp')

  // 环境可达性：播种记录端口先探，失联时仅 legacy（:23 共享 sshd）走 2222
  // portproxy 兜底（spec 私有主机，金态不动）；槽位专用实例不共享授权键，skip。
  // 记录缺失（播种未跑——如跨拓扑金态无 WSL 域）同属环境边界：按门控 skip 而
  // 非 expect 失败（与 helpers.fetchWslHost 契约同口径，P-20261005-187 收口）
  if (wslHost && await tcpReachable(wslHost.port)) {
    hostId = wslHost.id
    wslUp = true
  } else if (wslHost && Number(wslHost.port) === 23 && await tcpReachable(FALLBACK_PORT)) {
    const pem = fs.readFileSync(findKeyPath(), 'utf8')
    // 同名残留先清（上次失败中断的兜底主机）
    for (const h of ((hosts?.data || []) as { id: string; name: string }[])) {
      if (h.name === FALLBACK_NAME) {
        await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
      }
    }
    const create = await fetch(`${API_BASE}/api/remotehosts`, {
      method: 'POST', headers,
      body: JSON.stringify({
        name: FALLBACK_NAME, host: '127.0.0.1', port: FALLBACK_PORT,
        user: 'root', authType: 'pem', pemContent: pem,
      }),
    })
    expect(create.status, '兜底主机创建应成功').toBeLessThan(300)
    const created = (await create.json()) as { data?: { id?: string } }
    hostId = created.data?.id || ''
    hostName = FALLBACK_NAME
    tmpHostCreated = true
    wslUp = true
  }
  test.skip(!wslUp, 'WSL sshd 不可达（环境门控，远端侧是真实 SSH 往返）')

  // 本地仓库：两个提交（远端 clone 后本地再领先 1 个 → behind=remoteBehind 1）
  localDir = path.join(os.tmpdir(), 'sc-e2e-gitcmp')
  try { fs.rmSync(localDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(localDir, { recursive: true })
  execFileSync('git', ['init'], { cwd: localDir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: localDir })
  fs.writeFileSync(path.join(localDir, 'a.txt'), 'gitcmp v1\n')
  git(localDir, ['add', '.'])
  git(localDir, ['commit', '-m', 'base'])
  git(localDir, ['commit', '--allow-empty', '-m', 'second'])

  // WSL 仓库：以 root clone 本地仓库（root 与 sshd 登录用户一致），留一个未跟踪文件
  // ——逐运行中发行版各建一份（默认 distro ≠ sshd :23 持有者时服务端只读得到
  // 自己文件系统里那份，见 wslEach 注）
  wslEach(`rm -rf '${WSL_DIR}' && git clone '${winToWsl(localDir)}' '${WSL_DIR}' && echo hi > '${WSL_DIR}/${FILE}'`)
  git(localDir, ['commit', '--allow-empty', '-m', 'third'])
  localHead = git(localDir, ['rev-parse', 'HEAD'])
  // 远端 HEAD 期望值取服务端 exec 通道读数（与对照同一条 SSH 通路，权威）——
  // wsl.exe 侧读数在多发行版漂移时是另一个文件系统的仓库（历史红因）。
  // 服务端落点发行版 git 不可用 = 环境边界，按既有门控跳过
  remoteHead = await serverExec(`git -C '${WSL_DIR}' rev-parse HEAD`)
  test.skip(!remoteHead, 'WSL 服务端落点发行版 git 不可用（环境门控，远端侧是真实 SSH 往返）')

  const res = await fetch(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（跨拓扑 /mnt/c 同见）；测试侧 git/fs 断言用原形态
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(localDir) }),
  })
  expect([200, 201]).toContain(res.status)
  projectId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  // 兜底主机是 spec 私有：用完即删（金态 WSL 记录不动）
  if (tmpHostCreated && hostId) {
    await fetch(`${API_BASE}/api/remotehosts/${hostId}`, { method: 'DELETE', headers }).catch(() => null)
  }
  try { fs.rmSync(localDir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  if (wslUp) { wslEach(`rm -rf '${WSL_DIR}'`) }
})

test('API：两端 HEAD/分支/脏计数对照 + behind=远端落后 1', async () => {
  const { status, body } = await apiCompare(hostId, `projectId=${projectId}&remotePath=${encodeURIComponent(WSL_DIR)}`)
  expect(status).toBe(200)
  expect(body.error).toBeFalsy()
  // 本地侧：真实本地仓库 HEAD / 干净工作区
  expect(body.local.available).toBe(true)
  expect(body.local.head).toBe(localHead)
  expect(body.local.dirtyCount).toBe(0)
  // 远端侧：WSL 仓库 HEAD / clone 默认分支 / 1 个未跟踪文件
  expect(body.remote.available).toBe(true)
  expect(body.remote.head).toBe(remoteHead)
  expect(body.remote.branch).not.toBe('')
  expect(body.remote.dirtyCount).toBe(1)
  // behind：远端 HEAD 是本地 HEAD~1
  expect(body.behind.relation).toBe('remoteBehind')
  expect(body.behind.remoteBehindCount).toBe(1)
  // 显式路径不算记忆回填
  expect(body.remotePath).toBe(WSL_DIR)
  expect(body.pathRemembered).toBe(false)
})

test('API：路径记忆——PUT 后缺省远端路径回填，空 PUT 清除', async () => {
  const headers = await unlockHeaders()
  // 无记忆且缺省路径 → 400 稳定拒绝
  const noMem = await apiCompare(hostId, `projectId=${projectId}`)
  expect(noMem.status).toBe(400)

  // PUT 记忆
  const put = await fetch(`${API_BASE}/api/remotehosts/${hostId}/git-compare-path`, {
    method: 'PUT', headers, body: JSON.stringify({ projectId, remotePath: WSL_DIR }),
  })
  expect(put.status).toBe(200)

  // 缺省路径 → 记忆回填（pathRemembered=true）
  const mem = await apiCompare(hostId, `projectId=${projectId}`)
  expect(mem.status).toBe(200)
  expect(mem.body.remotePath).toBe(WSL_DIR)
  expect(mem.body.pathRemembered).toBe(true)
  expect(mem.body.remote.head).toBe(remoteHead)

  // 空 PUT = 清除 → 回到 400
  const clear = await fetch(`${API_BASE}/api/remotehosts/${hostId}/git-compare-path`, {
    method: 'PUT', headers, body: JSON.stringify({ projectId, remotePath: '' }),
  })
  expect(clear.status).toBe(200)
  const after = await apiCompare(hostId, `projectId=${projectId}`)
  expect(after.status).toBe(400)

  // 收尾：重新记忆（UI 用例要走记忆免填路径）
  await fetch(`${API_BASE}/api/remotehosts/${hostId}/git-compare-path`, {
    method: 'PUT', headers, body: JSON.stringify({ projectId, remotePath: WSL_DIR }),
  })
})

test('API：远端非 git 目录结构化降级（notGitRepo）', async () => {
  const dir = `/tmp/sc-gitcmp-nogit-${Date.now()}`
  wslEach(`mkdir -p '${dir}'`)
  try {
    const { status, body } = await apiCompare(hostId, `projectId=${projectId}&remotePath=${encodeURIComponent(dir)}`)
    expect(status).toBe(200)
    expect(body.remote.available).toBe(false)
    expect(body.remote.unavailableReason).toBe('notGitRepo')
    // 本地侧照常返回（降级只影响远端侧）
    expect(body.local.available).toBe(true)
    expect(body.behind).toBeFalsy()
  } finally {
    wslEach(`rm -rf '${dir}'`)
  }
})

test('UI：主机菜单「与本地对照」→ 三行对照 + 落后文案 + HEAD 高亮', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/project')
  // 进远程管理内嵌视图
  await page.locator('.rail-btn[title="远程管理"]').click()
  // 兜底模式下金态 WSL 卡与兜底卡并存：按实际使用的主机名定位（金态时同为 'WSL'）
  const card = page.locator('.host-card').filter({ hasText: hostName }).first()
  await expect(card).toBeVisible({ timeout: 10000 })

  // ⋯ 菜单 → 「与本地对照」
  await card.locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '与本地对照' }).first().click()
  const dialog = page.locator('.gitcmp-card')
  await expect(dialog).toBeVisible({ timeout: 10000 })

  // 打开即预选当前项目自动对照一次（无该项目的路径记忆 → 400 引导补填，属预期分支）
  await expect(dialog.locator('[data-testid="gitcmp-project"]')).toBeVisible()
  // 选目标项目（下拉清空上次结果），点「对照」走记忆路径
  await dialog.locator('[data-testid="gitcmp-project"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: PROJ }).first().click()
  await dialog.locator('[data-testid="gitcmp-run"]').click()

  // 三行对照：两端短 hash（不一致 → 高亮）、分支、脏计数
  const grid = dialog.locator('[data-testid="gitcmp-grid"]')
  await expect(grid).toBeVisible({ timeout: 20000 })
  await expect(dialog.locator('[data-testid="gitcmp-local-head"]')).toHaveText(localHead.slice(0, 7))
  await expect(dialog.locator('[data-testid="gitcmp-remote-head"]')).toHaveText(remoteHead.slice(0, 7))
  // HEAD 不一致 → 两端 head 值都带高亮类
  await expect(dialog.locator('[data-testid="gitcmp-local-head"].is-mismatch')).toBeVisible()
  await expect(dialog.locator('[data-testid="gitcmp-remote-head"].is-mismatch')).toBeVisible()
  // 落后文案 + 远端脏计数
  await expect(dialog.locator('[data-testid="gitcmp-behind"]')).toContainText('远端落后本地 1 个提交')
  await expect(dialog.locator('[data-testid="gitcmp-remote-dirty"]')).toHaveText('1')
  await expect(dialog.locator('[data-testid="gitcmp-local-dirty"]')).toHaveText('0')
})
