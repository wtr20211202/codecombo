import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * Quick Open 远程文件层 E2E（P-20261004-137）：
 *   1. 首页（无当前项目）Ctrl+P 出「远程文件」分组——host 别名徽标 + 远端绝对
 *      路径次行（此前首页 Quick Open 是空面板）
 *   2. 远程文件关闭后 Ctrl+P 搜文件名 → 远程分组命中 → 回车经 openFile 既有
 *      远程分支重开，内容即现（最近远程环形清单的抗关签能力）
 *   3. 离线主机条目 → 打开 → 离线只读横幅降级（既有 remoteOffline 链继承）
 *
 * 远程主机经 API 直建（IPv4 回环假端口，内容端点由 page.route 桩接）：本 spec
 * 验证的是「入口可达性 + 打开链复用」，不依赖 WSL sshd；真实 SSH 全链由
 * remote-editor-open.spec 门控覆盖。localStorage 种子经 addInitScript 在页面
 * 脚本前写入（remote-recent-files 是 P-137 的本地可重建 UI 缓存键）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const HOST_NAME = 'e2e-quick-open-remote'
const OFFLINE_HOST_NAME = 'e2e-quick-open-remote-offline'
const RPATH = '/tmp/sc-e2e-quickopen-remote.txt'
const OFFLINE_RPATH = '/tmp/sc-e2e-quickopen-offline.txt'
const FILE_NAME = 'sc-e2e-quickopen-remote.txt'
const OFFLINE_FILE_NAME = 'sc-e2e-quickopen-offline.txt'
const CONTENT_MARKER = 'sc-quickopen-remote-marker'
const RECENT_KEY = 'remote-recent-files'

let api: APIRequestContext
let hostId = ''
let offlineHostId = ''

async function authHeaders(): Promise<Record<string, string>> {
  const res = await api.post(BASE + '/api/lock/unlock', { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'X-Lock-Token': token }
}

async function deleteHostsByName(headers: Record<string, string>) {
  const body = await (await api.get(BASE + '/api/remotehosts', { headers })).json() as {
    data?: { id: string; name: string }[]
  }
  for (const h of body.data || []) {
    if (h.name === HOST_NAME || h.name === OFFLINE_HOST_NAME) {
      await api.delete(`${BASE}/api/remotehosts/${h.id}`, { headers })
    }
  }
}

async function createHost(headers: Record<string, string>, name: string): Promise<string> {
  const res = await api.post(BASE + '/api/remotehosts', {
    headers,
    data: {
      name,
      host: '127.0.0.1',
      // 不可达端口：本 spec 的 content 端点全部由 page.route 桩接，永不真拨
      port: 1,
      user: 'root',
      authType: 'password',
      password: 'e2e-not-used',
    },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data?: { id?: string } }).data?.id || ''
}

/** 页面脚本前播种最近远程（localStorage 是 Playwright context 级，每用例全新） */
async function seedRecent(
  page: Parameters<typeof gotoAndUnlock>[0],
  entry: { hostId: string; rpath: string; name: string },
) {
  await page.addInitScript(({ key, item }) => {
    localStorage.setItem(key, JSON.stringify([{ ...item, ts: Date.now() }]))
  }, { key: RECENT_KEY, item: entry })
}

/** 内容端点桩：在线主机的读返回固定正文；离线主机返回 502（loadRemoteInto 的
 *  离线降级分支）。其余请求放行（host 列表等真实走服务端） */
async function mockRemoteContent(page: Parameters<typeof gotoAndUnlock>[0], onlineId: string, offlineId: string) {
  await page.route('**/api/remotehosts/*/files/content*', (route) => {
    const url = route.request().url()
    if (onlineId && url.includes(`/remotehosts/${onlineId}/`)) {
      return route.fulfill({ json: { data: `${CONTENT_MARKER}\n`, path: RPATH, hash: 'e2e-hash' } })
    }
    if (offlineId && url.includes(`/remotehosts/${offlineId}/`)) {
      return route.fulfill({ status: 502, json: { error: 'remote host unreachable (e2e stub)' } })
    }
    return route.continue()
  })
}

/** 首页无项目形态（P-20261004-137 验收面）：项目列表桩空，currentProjectId 保持空——
 *  /project 的 Layout 挂欢迎页，Quick Open 文件模式此前是空面板。不桩时 fetchProjects
 *  的「无选中则自动选第一个」会把金态项目选上，测不到目标形态 */
async function mockNoProjects(page: Parameters<typeof gotoAndUnlock>[0]) {
  await page.route(url => url.pathname === '/api/projects', route => route.fulfill({ json: { data: [] } }))
}

async function openQuickOpen(page: Parameters<typeof gotoAndUnlock>[0]) {
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test.beforeAll(async ({ playwright }) => {
  api = await playwright.request.newContext()
  const headers = await authHeaders()
  await deleteHostsByName(headers)
  hostId = await createHost(headers, HOST_NAME)
  offlineHostId = await createHost(headers, OFFLINE_HOST_NAME)
})

test.afterAll(async () => {
  if (!api) return
  const headers = await authHeaders().catch(() => ({} as Record<string, string>))
  if (hostId) await api.delete(`${BASE}/api/remotehosts/${hostId}`, { headers }).catch(() => {})
  if (offlineHostId) await api.delete(`${BASE}/api/remotehosts/${offlineHostId}`, { headers }).catch(() => {})
  // 远程签会随编辑器 uiState 持久（远程签跨项目保留）：清 editor 键，防本 spec
  // 打开过的远程签在后续 spec 的 boot 恢复里重挂干扰既有选择器
  // （remote-editor-open.spec afterAll 同款纪律）
  try {
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
  await api.dispose()
})

test('首页 Quick Open 显示远程文件分组：host 徽标 + 远端绝对路径次行', async ({ page }) => {
  expect(hostId, '远程主机创建失败').toBeTruthy()
  await seedRecent(page, { hostId, rpath: RPATH, name: FILE_NAME })
  await mockNoProjects(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)
  await openQuickOpen(page)

  await expect(page.locator('.palette-group-label', { hasText: '远程文件' })).toBeVisible()
  const item = page.locator('.palette-item-remote', { hasText: FILE_NAME })
  await expect(item).toBeVisible()
  await expect(item.locator('.palette-item-remote-badge')).toHaveText(HOST_NAME)
  await expect(item.locator('.palette-item-path-text')).toHaveText(RPATH)
  // 项目清单为空（首页无项目）时远程层仍出——空面板不再
  await expect(page.locator('.palette-empty')).toHaveCount(0)
})

test('远程文件关闭后 Ctrl+P 搜名 → 远程分组命中 → 回车重开内容即现', async ({ page }) => {
  expect(hostId, '远程主机创建失败').toBeTruthy()
  await seedRecent(page, { hostId, rpath: RPATH, name: FILE_NAME })
  await mockRemoteContent(page, hostId, offlineHostId)
  await mockNoProjects(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)

  // 首次打开：远程分组 → 回车 → 既有 openFile 远程分支装载
  const input = await openQuickOpen(page)
  await input.fill('sc-e2e-quickopen')
  await expect(page.locator('.palette-item-remote', { hasText: FILE_NAME })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  const tab = page.locator('.pane-primary .editor-tab', { hasText: FILE_NAME })
  await expect(tab).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.view-lines').first()).toContainText(CONTENT_MARKER, { timeout: 15000 })

  // 关闭（未编辑无确认）→ 候选不依赖已开签：最近远程仍在
  await tab.locator('.tab-close').click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_NAME })).toHaveCount(0)

  const input2 = await openQuickOpen(page)
  await input2.fill('sc-e2e-quickopen')
  await expect(page.locator('.palette-item-remote', { hasText: FILE_NAME })).toBeVisible()
  await page.keyboard.press('Enter')
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_NAME })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.view-lines').first()).toContainText(CONTENT_MARKER, { timeout: 15000 })
})

test('离线主机条目打开 → 离线只读横幅降级不崩', async ({ page }) => {
  expect(offlineHostId, '离线远程主机创建失败').toBeTruthy()
  await seedRecent(page, { hostId: offlineHostId, rpath: OFFLINE_RPATH, name: OFFLINE_FILE_NAME })
  await mockRemoteContent(page, hostId, offlineHostId)
  await mockNoProjects(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/project`)

  const input = await openQuickOpen(page)
  await input.fill('sc-e2e-quickopen-offline')
  const item = page.locator('.palette-item-remote', { hasText: OFFLINE_FILE_NAME })
  await expect(item).toBeVisible()
  await expect(item.locator('.palette-item-remote-badge')).toHaveText(OFFLINE_HOST_NAME)
  await page.keyboard.press('Enter')

  // 离线降级：tab 保留 + 顶横幅可重试（P-15 既有链路），编辑器壳不白屏
  await expect(page.locator('[data-testid="remote-offline-bar"]')).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="remote-offline-retry"]')).toBeVisible()
  await expect(page.locator('.editor-tabs')).toBeVisible()
})
