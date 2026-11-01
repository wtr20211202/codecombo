import { test, expect, type APIRequestContext, type Locator } from '@playwright/test'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'

/**
 * 远程文件在编辑器打开与回写 E2E（P-20261003-15，VS Code Remote 式）：
 *   1. 全链：文件管理器右键「在编辑器打开」→ 改 → Ctrl+S 回写远端 → 刷新重拉
 *   2. 二进制探测 415 → 元信息卡（正文不进编辑器）
 *   3. 保存冲突 409 → 三选对话框（覆盖保存 / 加载远端版本）
 *   4. 敏感路径（/etc）写入警示确认（取消不落盘）
 *   5. 离线边界：主机被删后 tab 重挂 → 顶横幅只读降级不崩
 *
 * 环境门控（与 remote-files.spec 的 wslUp 同惯例）：用例 1~4 需 WSL sshd 可达
 * （端口以播种的主机记录为准——legacy 共享 sshd :23 / 槽位专用实例为派生端口，
 * P-20261004-115；数据面已预置同名 WSL 主机，pem 认证；缺失时先跑
 * scripts/e2e-seed-wsl.sh）。用例 5 经「复制主机」造副本开签后删副本触发
 * （主机不可达时文件管理器列不出文件，右键入口天然不可达——boot 恢复重挂
 * 已开签是唯一真实的「先开后失联」形态）。
 * HTTP 走 Playwright request 上下文（与页面解耦，作用域自动回收）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const WSL_HOST_NAME = 'WSL'
const EDIT_FILE = '/tmp/sc-e2e-remote-edit.txt'
const BIN_FILE = '/tmp/sc-e2e-remote-edit.bin'
const CONFLICT_FILE = '/tmp/sc-e2e-remote-conflict.txt'

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let api: APIRequestContext
let wslUp = false
let wslPort = 23
let hostId = ''
let dupHostId = ''

async function authHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

/** 经上传端点播种远端文件（sshd 对高频新建连接仍有 MaxStartups 节流面——
 *  槽位专用实例已放宽到 30，共享 :23 依旧紧；失败重试一次兜底两者） */
async function seedRemoteFile(path: string, dir: string, name: string, content: string) {
  const headers = await authHeaders()
  const doUpload = () => api.post(`${BASE}/api/remotehosts/${hostId}/files/upload`, {
    headers,
    multipart: {
      path: dir,
      files: { name, mimeType: 'application/octet-stream', buffer: Buffer.from(content, 'utf-8') },
    },
    failOnStatusCode: false,
    timeout: 20000,
  })
  let res = await doUpload()
  if (!res.ok()) {
    await new Promise(r => setTimeout(r, 2000))
    res = await doUpload()
  }
  expect(res.ok(), `upload ${path} failed: ${res.status()} ${await res.text()}`).toBeTruthy()
}

/** 读远端文件当前内容（e2e 断言远端真值用） */
async function readRemote(path: string): Promise<string> {
  const headers = await authHeaders()
  const res = await api.get(`${BASE}/api/remotehosts/${hostId}/files/content`, {
    headers, params: { path }, failOnStatusCode: false, timeout: 20000,
  })
  if (!res.ok()) return `<read-failed ${res.status()}>`
  const body = (await res.json()) as { data?: string }
  return body.data ?? ''
}

async function removeRemote(paths: string[], targetHostId = hostId) {
  try {
    const headers = await authHeaders()
    await api.post(`${BASE}/api/remotehosts/${targetHostId}/files/delete`, {
      headers, data: { paths }, timeout: 20000,
    })
  } catch { /* 清理失败不影响断言 */ }
}

/**
 * 自愈：把本仓 e2e 公钥装入「运行中发行版」的认证目标授权键文件（幂等，与
 * scripts/e2e-seed-wsl.sh 同语义）：legacy 共享 sshd（记录端口 23）写共享
 * /root/.ssh/authorized_keys；槽位专用实例（P-20261004-115）写按端口独立的
 * authorized_keys-e2e-<port>（与播种器同公式），互不见他槽钥匙。
 *
 * 为什么 spec 里做这件事：机器上多 git 仓/多 worktree 槽位共用 WSL，运行前
 * 刚播种的授权键可能在用例窗口内被动过（发行版唤醒/共享文件被写）。探测
 * 失败时先重装再复测，把「环境被他人改动」从假红降级为自愈。公钥逐字追加
 * + grep -qF 全串比对幂等（播种器与自愈同源，重复装机收敛为 kept），不动
 * 用户已有授权键。公钥经 base64 传参绕开引号转义，execFile 直传参数不经
 * shell。仅 WSL 门控内可达此路径，失败交给复测判定。
 */
async function installPubkey() {
  const pubPath = path.resolve(process.cwd(), '..', '.e2e-data', 'keys', 'wsl-e2e.pub')
  if (!fs.existsSync(pubPath)) return
  const execFileP = promisify(exec)
  // 只对「已在运行」的发行版装机：wsl.exe -d 会冷启动发行版，而新起的共享
  // sshd 绑定 :23 会抢走 Windows localhost 转发（实测抢走后 auth rejected 502——
  // 醒来的发行版未必有本槽公钥），反而把可用环境打坏
  let stdout = ''
  try {
    // wsl.exe -l 输出 UTF-16LE：Node 侧剥 \0
    const r = await execFileP('wsl.exe', ['-l', '-q', '--running'], { timeout: 30000, windowsHide: true })
    stdout = r.stdout
  } catch { return }
  const distros = stdout.split('\n').map(s => s.replace(/\0|\r/g, '').trim()).filter(Boolean)
  const pubB64 = fs.readFileSync(pubPath).toString('base64')
  const keyFile = wslPort === 23
    ? '/root/.ssh/authorized_keys'
    : `/root/.ssh/authorized_keys-e2e-${wslPort}`
  const script = 'p=$(printf %s ' + pubB64 + ' | base64 -d); ' +
    'f=' + keyFile + '; mkdir -p /root/.ssh; touch "$f"; chmod 600 "$f"; ' +
    'grep -qF "$p" "$f" || printf "%s\\n" "$p" >> "$f"'
  for (const distro of distros) {
    try {
      await execFileP('wsl.exe', ['-d', distro, '-e', 'sh', '-c', script], { timeout: 60000, windowsHide: true })
    } catch { /* 单发行版装机失败：交给复测判定 */ }
  }
}

/** 打开远程管理视图 + WSL 主机的文件管理器（remote-files.spec 同款入口） */
async function openFileManager(page: Parameters<typeof gotoAndUnlock>[0], hostName = WSL_HOST_NAME): Promise<Locator> {
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const card = page.locator('.host-card').filter({ hasText: hostName }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.hover()
  await card.locator('.host-card-files').click()
  const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 20000 })
  return modal
}

/** 文件管理器内直达目录 + 右键「在编辑器打开」→ 等编辑器 tab 挂出。
 *  expectEditor=false：二进制/超大文件元信息卡替代编辑器（Monaco 不挂载） */
async function openInEditor(
  page: Parameters<typeof gotoAndUnlock>[0],
  modal: Locator,
  dir: string,
  fileName: string,
  expectEditor = true,
) {
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill(dir)
  await modal.locator('.rf-path-input input').press('Enter')
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 15000 })
  // 大目录（/etc 数百条）虚拟滚动只渲染可视区行：先经面板过滤输入收窄到目标行
  await modal.locator('.rf-filter input').fill(fileName)
  const row = modal.locator('tr').filter({ hasText: fileName }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '在编辑器打开' }).click()
  // 主区切回编辑器：管理弹窗随动作自动收起（teleport 到 body 不随 remote 视图隐藏），
  // 伪路径 tab 挂出且 Monaco 内容就绪
  await expect(modal).toBeHidden({ timeout: 10000 })
  const tab = page.locator('.editor-tab').filter({ hasText: fileName }).first()
  await expect(tab).toBeVisible({ timeout: 15000 })
  if (expectEditor) {
    await expect(page.locator('.monaco-container').first()).toBeVisible({ timeout: 15000 })
  }
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext()
  // 先取播种记录再探针：端口以记录为准（槽位专用实例非 23，P-20261004-115），
  // 记录缺失时探不到正确实例，直接走 skip
  const wslHost = await fetchWslHost(BASE)
  hostId = wslHost?.id || ''
  wslPort = wslHost?.port || 23
  if (!hostId) return
  wslUp = await tcpReachable(wslPort)
  if (!wslUp) return
  const headers = await authHeaders()
  // 认证级门控（强于 TCP 可达）：Windows→WSL 的端口转发随发行版空闲回收在
  // 双发行版间漂移，落点发行版可能未装 e2e 公钥（实测 auth rejected 502）——
  // 先做一次真实 SFTP 往返；不通则自愈（向运行中发行版重装本仓公钥，
  // installPubkey）后复测，仍不通才 skip（环境缺失降级 skip 不假红）
  const probeOnce = () => api.get(`${BASE}/api/remotehosts/${hostId}/files/list`, {
    headers, params: { path: '/tmp' }, failOnStatusCode: false, timeout: 20000,
  })
  let probe = await probeOnce()
  if (!probe.ok()) {
    await installPubkey()
    for (let i = 0; i < 3 && !probe.ok(); i++) {
      await new Promise(r => setTimeout(r, 1500))
      probe = await probeOnce()
    }
  }
  if (!probe.ok()) {
    console.log(`WSL SFTP auth probe failed (${probe.status()}), skip WSL-gated tests`)
    wslUp = false
    return
  }
  // 预清理历史残留（前序运行中断时文件会留存，残留会让「上传新文件」退化为
  // 「命中旧行」——remote-files 互传用例同款纪律）
  await removeRemote([EDIT_FILE, BIN_FILE, CONFLICT_FILE])
  await seedRemoteFile(EDIT_FILE, '/tmp', 'sc-e2e-remote-edit.txt', 'sc-e2e-edit-seed\n')
})

test.afterAll(async () => {
  if (hostId) await removeRemote([EDIT_FILE, BIN_FILE, CONFLICT_FILE])
  if (dupHostId) {
    try {
      const headers = await authHeaders()
      await api.delete(`${BASE}/api/remotehosts/${dupHostId}`, { headers })
    } catch { /* 清理失败不影响断言 */ }
  }
  // 清编辑器 uiState 残留：本 spec 打开的远程伪路径签会持久进服务端
  // uiState（项目维度），后续 spec 打开 /project 时 boot 恢复会重挂远程签
  // 干扰既有选择器——对齐 remote-files.spec 的 afterAll 清理纪律
  try {
    const headers = await authHeaders()
    const res = await (await api.get(BASE + '/api/ui-state', { headers })).json()
    const map = res?.data as Record<string, Record<string, unknown>> | undefined
    if (map) {
      let changed = false
      for (const k of Object.keys(map)) {
        if (map[k]?.editor !== undefined) {
          delete map[k].editor
          changed = true
        }
      }
      if (changed) await api.put(BASE + '/api/ui-state', { headers, data: map })
    }
  } catch { /* 实例不可达时跳过清理 */ }
  await api?.dispose()
})

test('远程文件编辑全链：右键打开 → 改 → Ctrl+S 回写 → 刷新重拉', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-edit.txt')
  await expect(page.locator('.view-lines').first()).toContainText('sc-e2e-edit-seed', { timeout: 15000 })

  // 全选改写（确定性内容）→ Ctrl+S 回写远端
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('E2E-REWRITE-v2')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 15000 })

  // 远端真值 = 编辑器内容（PUT 回写生效）
  await expect.poll(() => readRemote(EDIT_FILE), { timeout: 20000 })
    .toBe('E2E-REWRITE-v2')

  // 刷新重拉：uiState 恢复远程伪路径签 → boot 重新从远端装载
  await gotoAndUnlock(page, BASE + '/project')
  const tab = page.locator('.editor-tab').filter({ hasText: 'sc-e2e-remote-edit.txt' }).first()
  await expect(tab).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.view-lines').first()).toContainText('E2E-REWRITE-v2', { timeout: 15000 })
})

test('二进制探测 415：二进制文件打开 → 元信息卡', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(90000)
  await fixedLocale(page)
  await seedRemoteFile(BIN_FILE, '/tmp', 'sc-e2e-remote-edit.bin', 'text-head\0\0\0binary-tail')
  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-edit.bin', false)
  // 元信息卡替代编辑器：正文不外发
  await expect(page.locator('.file-meta-card')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.file-meta-card')).toContainText('二进制文件')
})

test('保存冲突 409 三选：覆盖保存直写 / 加载远端版本', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  await seedRemoteFile(CONFLICT_FILE, '/tmp', 'sc-e2e-remote-conflict.txt', 'conflict-base\n')
  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-conflict.txt')
  await expect(page.locator('.view-lines').first()).toContainText('conflict-base', { timeout: 15000 })

  // 编辑期间远端被外部改写（agent/其他会话语义）
  await seedRemoteFile(CONFLICT_FILE, '/tmp', 'sc-e2e-remote-conflict.txt', 'remote-changed-1\n')

  // 本地编辑 + 保存 → 409 → 三选对话框
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('E2E-LOCAL-OVERWRITE')
  await page.keyboard.press('ControlOrMeta+s')
  const conflictDialog = page.locator('.n-modal').filter({ hasText: '文件已被外部修改' })
  await expect(conflictDialog).toBeVisible({ timeout: 15000 })
  await expect(conflictDialog.locator('button').filter({ hasText: '覆盖保存' })).toBeVisible()
  await expect(conflictDialog.locator('button').filter({ hasText: '加载远端版本' })).toBeVisible()
  await expect(conflictDialog.locator('button').filter({ hasText: '与远端版本对比' })).toBeVisible()

  // 覆盖保存：陈旧基线 force 直写
  await conflictDialog.locator('button').filter({ hasText: '覆盖保存' }).click()
  await expect(conflictDialog).toBeHidden({ timeout: 10000 })
  await expect.poll(() => readRemote(CONFLICT_FILE), { timeout: 20000 })
    .toBe('E2E-LOCAL-OVERWRITE')

  // 第二轮：加载远端版本（放弃本地、读入远端当前内容回净态）
  await seedRemoteFile(CONFLICT_FILE, '/tmp', 'sc-e2e-remote-conflict.txt', 'remote-changed-2\n')
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('E2E-LOCAL-DISCARD')
  await page.keyboard.press('ControlOrMeta+s')
  await expect(conflictDialog).toBeVisible({ timeout: 15000 })
  await conflictDialog.locator('button').filter({ hasText: '加载远端版本' }).click()
  await expect(conflictDialog).toBeHidden({ timeout: 10000 })
  // 编辑器内容换成远端当前内容且回净态（不再有保存动作）
  await expect(page.locator('.view-lines').first()).toContainText('remote-changed-2', { timeout: 15000 })
  await expect(page.locator('.view-lines').first()).not.toContainText('E2E-LOCAL-DISCARD')
  await expect.poll(() => readRemote(CONFLICT_FILE), { timeout: 20000 })
    .toBe('remote-changed-2\n')
})

test('敏感路径（/etc）写入警示确认：取消不落盘', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  const before = await readRemote('/etc/hostname')
  test.skip(before.startsWith('<read-failed'), '/etc/hostname 不可读，跳过')

  const modal = await openFileManager(page)
  await openInEditor(page, modal, '/etc', 'hostname')
  const firstLine = before.trim().split('\n')[0] || ''
  await expect(page.locator('.view-lines').first()).toContainText(firstLine, { timeout: 15000 })

  // 编辑 + 保存 → 敏感路径警示确认 → 取消 → 远端不变
  await page.locator('.monaco-container .view-lines').first().click()
  await page.keyboard.press('ControlOrMeta+a')
  await page.keyboard.type('e2e-should-not-land')
  await page.keyboard.press('ControlOrMeta+s')
  const sensitiveDialog = page.locator('.n-modal').filter({ hasText: '写入敏感系统路径' })
  await expect(sensitiveDialog).toBeVisible({ timeout: 15000 })
  await sensitiveDialog.locator('button').filter({ hasText: '取消' }).click()
  await expect(sensitiveDialog).toBeHidden({ timeout: 10000 })
  await page.waitForTimeout(1500)
  expect(await readRemote('/etc/hostname')).toBe(before)
})

test('离线边界：主机失联后重挂 → 顶横幅只读降级不崩', async ({ page }) => {
  test.skip(!wslUp || !hostId, 'WSL sshd 不可达或 WSL 主机未预置，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)

  // 复制 WSL 主机得副本（凭据服务端复制），经副本开签——删副本不影响 WSL 本尊
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  await expect(wslCard).toBeVisible({ timeout: 10000 })
  await wslCard.hover()
  await wslCard.locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '复制主机' }).first().click()
  await page.locator('.sidebar-actions button').filter({ hasText: '粘贴主机副本' }).click()
  const dupCard = page.locator('.host-card').filter({ hasText: '副本' }).first()
  await expect(dupCard).toBeVisible({ timeout: 10000 })
  const headers = await authHeaders()
  const hosts = (await (await api.get(BASE + '/api/remotehosts', { headers })).json())?.data as { id: string; name: string }[] | undefined
  dupHostId = hosts?.find(h => String(h.name).includes('副本'))?.id || ''
  test.skip(!dupHostId, '副本主机未拿到 ID，跳过')

  // 经副本打开 /tmp 编辑文件（副本凭据同 WSL，文件同一直达面）。
  // 内容自播种：beforeAll 在 retry 换 worker 时会重跑并回播 seed，依赖前序
  // 用例的改写结果会在重试序列下漂移（实测踩坑）
  await seedRemoteFile(EDIT_FILE, '/tmp', 'sc-e2e-remote-edit.txt', 'offline-e2e-marker\n')
  const modal = await openFileManager(page, '副本')
  await openInEditor(page, modal, '/tmp', 'sc-e2e-remote-edit.txt')
  await expect(page.locator('.view-lines').first()).toContainText('offline-e2e-marker', { timeout: 15000 })

  // 删副本主机 → 刷新：boot 恢复重挂远程签 → content 404 → 离线横幅只读降级
  await api.delete(`${BASE}/api/remotehosts/${dupHostId}`, { headers })
  const deletedId = dupHostId
  dupHostId = ''
  await gotoAndUnlock(page, BASE + '/project')
  await expect(page.locator('[data-testid="remote-offline-bar"]')).toBeVisible({ timeout: 20000 })
  await expect(page.locator('[data-testid="remote-offline-retry"]')).toBeVisible()
  // 应用不崩：编辑器壳仍在（只读降级非白屏）
  await expect(page.locator('.editor-tabs')).toBeVisible()
  void deletedId
})
