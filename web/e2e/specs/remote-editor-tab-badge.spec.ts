import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 远程 tab 主机徽标与悬停路径 E2E（P-20261004-138）：本地/远程同名文件两个
 * tab 同名同类型色点，扫读分不清、保存改错目标即直达 SFTP 回写远端——
 *   1. 本地 tab：无徽标、aria-label = 文件名、title 维持现状（非预览位无 title）
 *   2. 远程 tab：名前主机徽标（别名首字符）、title =「别名:远端绝对路径」、
 *      aria-label 携别名
 * 环境门控（与 remote-editor-open.spec 同惯例）：需 WSL sshd 可达（播种记录
 * 端口 + SFTP 认证级探针），缺失降级 skip 不假红。本地夹具自备临时仓库，
 * afterAll 清理（含 uiState editor 命名空间防远程签残留干扰后续 spec）。
 */

const BASE = API_BASE
const WSL_HOST_NAME = 'WSL'
const DUAL_NAME = 'sc-e2e-badge-dual.conf'
const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-host-badge')
const PROJ = 'e2e-tab-host-badge'

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
let projectId = ''

async function authHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** 经上传端点播种远端同名文件（sshd MaxStartups 节流面：失败重试一次） */
async function seedRemoteFile(dir: string, name: string, content: string) {
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
  expect(res.ok(), `upload ${dir}/${name} failed: ${res.status()}`).toBeTruthy()
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext()
  // 本地夹具：临时仓 + 同名文件 + 项目注册（editor-tab-git-status.spec 同款）
  const headers = await authHeaders()
  const stale = await (await fetch(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, DUAL_NAME), 'local-badge-seed\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 主机徽标夹具'])
  const reg = await fetch(`${BASE}/api/projects`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(reg.status)
  projectId = ((await reg.json()) as { data?: { id?: string } }).data?.id || ''

  // 远程环境门控（remote-editor-open.spec 同惯例：记录端口 → TCP → SFTP 认证级探针）
  const wslHost = await fetchWslHost(BASE)
  hostId = wslHost?.id || ''
  wslPort = wslHost?.port || 23
  if (!hostId) return
  wslUp = await tcpReachable(wslPort)
  if (!wslUp) return
  const probe = await api.get(`${BASE}/api/remotehosts/${hostId}/files/list`, {
    headers, params: { path: '/tmp' }, failOnStatusCode: false, timeout: 20000,
  })
  if (!probe.ok()) {
    console.log(`WSL SFTP auth probe failed (${probe.status()}), skip WSL-gated tests`)
    wslUp = false
    return
  }
  await seedRemoteFile('/tmp', DUAL_NAME, 'remote-badge-seed\n')
})

test.afterAll(async () => {
  try {
    if (hostId) {
      const headers = await authHeaders()
      await api.post(`${BASE}/api/remotehosts/${hostId}/files/delete`, {
        headers, data: { paths: [`/tmp/${DUAL_NAME}`] }, timeout: 20000,
      })
    }
  } catch { /* 清理失败不影响断言 */ }
  if (projectId) {
    try {
      const headers = await authHeaders()
      await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
    } catch { /* 清理失败不影响断言 */ }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 清本项目 uiState editor 残留：本 spec 打开的远程伪路径签会持久进服务端
  // uiState，后续 spec 打开项目页时 boot 恢复会重挂远程签干扰既有选择器
  // （remote-editor-open.spec afterAll 同款纪律，按项目 id 定向清除）
  try {
    const headers = await authHeaders()
    const res = await (await api.get(BASE + '/api/ui-state', { headers })).json()
    const map = res?.data as Record<string, Record<string, unknown>> | undefined
    if (map && projectId && map[projectId]?.editor !== undefined) {
      delete map[projectId].editor
      await api.put(BASE + '/api/ui-state', { headers, data: map })
    }
  } catch { /* 实例不可达时跳过清理 */ }
  await api?.dispose()
})

/** 主区两个同名 tab 的定位：远程 = 含主机徽标的 tab；本地 = 同名但无徽标 */
function remoteTabLocator(page: Page): Locator {
  return page.locator('.editor-tab').filter({ has: page.locator('.tab-host-badge') }).first()
}
function localTabLocator(page: Page): Locator {
  return page.locator('.editor-tab', { hasText: DUAL_NAME })
    .filter({ hasNot: page.locator('.tab-host-badge') }).first()
}

test('本地/远程同名 tab：远程含主机徽标+悬停路径+aria 别名，本地维持现状', async ({ page }) => {
  test.skip(!wslUp || !hostId || !projectId, 'WSL sshd 不可达或夹具未就绪，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)

  // 打开项目 → 文件树点开本地同名文件
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: DUAL_NAME }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: DUAL_NAME }).first().click()
  const localTab = localTabLocator(page)
  await expect(localTab).toBeVisible()

  // 本地 tab 现状不变：无徽标、aria-label = 文件名、非预览位无 title
  await expect(localTab.locator('.tab-host-badge')).toHaveCount(0)
  await expect(localTab).toHaveAttribute('aria-label', DUAL_NAME)
  expect(await localTab.getAttribute('title')).toBeNull()

  // 远程管理 → 文件管理器 → /tmp 右键同名文件「在编辑器打开」（remote-editor-open 同入口）
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  const card = page.locator('.host-card').filter({ hasText: WSL_HOST_NAME }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await card.hover()
  await card.locator('.host-card-files').click()
  const modal = page.locator('.n-modal').filter({ hasText: '文件管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('button[title="编辑路径直达"]').click()
  await modal.locator('.rf-path-input input').fill('/tmp')
  await modal.locator('.rf-path-input input').press('Enter')
  await expect(modal.locator('tr').first()).toBeVisible({ timeout: 20000 })
  await modal.locator('.rf-filter input').fill(DUAL_NAME)
  const row = modal.locator('tr').filter({ hasText: DUAL_NAME }).first()
  await expect(row).toBeVisible({ timeout: 15000 })
  await row.locator('td').first().click({ button: 'right' })
  await page.locator('.rfc-item').filter({ hasText: '在编辑器打开' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })

  // 远程 tab：徽标挂出（首字符 = 主机别名首字母，大写观感）
  const remoteTab = remoteTabLocator(page)
  await expect(remoteTab).toBeVisible({ timeout: 15000 })
  const badge = remoteTab.locator('.tab-host-badge')
  await expect(badge).toHaveText(/^W$/)

  // title =「别名:远端绝对路径」；hostId→别名首渲染可能先回退裸 id、列表
  // 拉到后才换装别名——正则轮询等别名就位
  await expect(remoteTab).toHaveAttribute('title', new RegExp(`^${WSL_HOST_NAME}:/tmp/${DUAL_NAME}$`), { timeout: 15000 })
  // aria-label 携主机别名（读屏扫读可辨远程签）
  await expect(remoteTab).toHaveAttribute('aria-label', new RegExp(`${DUAL_NAME} \\(${WSL_HOST_NAME}\\)`), { timeout: 15000 })

  // 悬停路径照见远端身份后，保存动作的对象可辨：远程 tab 的类型色点仍在
  // （徽标与类型色点共存错位，不互替）
  await expect(remoteTab.locator('.tab-type-dot')).toHaveCount(1)
})
