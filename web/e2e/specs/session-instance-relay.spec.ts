import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import http from 'http'
import type { AddressInfo } from 'net'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 跨实例会话接力 E2E（P-20261003-218）：会话中心工具条「从实例接力」→ 选来源
 * 实例 + 会话（跨实例只读拉 timeline 摘要）→ 本实例新会话 launchArgs 携摘要。
 *
 * 远端夹具 = 测试进程内起的最小 fake 实例服务器（node:http）：
 *   - GET /api/settings            → online 判活特征（version 字段）
 *   - GET /api/claude/sessions     → 会话列表夹具（有结论/无结论/进行中三行）
 *   - GET /api/claude/sessions/:id/timeline → 两跳尾窗（limit=1 探 total）
 * 真实第二实例可达性随环境漂移（fleet-notify 同款处境），fake 服务器让夹具
 * 确定性；且**写回断言落在边界上**——fake 记录收到的每个请求，接力全流程
 * 结束后断言「到过远端的请求全是 GET」（比页面侧拦截更硬：代理出去什么就是
 * 什么）。实例注册用 127.0.0.1 随机高位端口（自引用拦截只拒同端口，可注册）。
 *
 * 断言核心（创建请求拦截 POST /api/terminals，不依赖 claude 运行时真实在场——
 * 已装则真实起会话、未装则预检拒绝/降级，请求体不变，session-relay 同款口径）：
 *   1. 有结论会话 → launchArgs 精确 =「此前会话结论：<结论>，请继续」（前言
 *      模板复用 P-114，字节 ≤500）；dir 不携带（远端 cwd 是远端机器的路径）
 *   2. 无结论会话 → 如实提示放弃，不发创建请求（不注空前言）
 *   3. 不可达实例 → 降级提示，切回健康实例列表恢复（失败可恢复）
 *   4. 只读边界：fake 收到的请求全为 GET，且 timeline 确实打到了远端
 */

const MARK = 'IR夹具'
const CONCLUSION = '实例接力结论：登录页重构完成，暗色主题适配的遗留项已登记跟踪'
const SESSION_OK = 'e2e-irl-a1b2c3d4-0001'
const SESSION_NOASST = 'e2e-irl-a1b2c3d4-0002'
const SESSION_ACTIVE = 'e2e-irl-a1b2c3d4-0003'
const INST_NAME = `e2e-inst-relay-${Math.random().toString(36).slice(2, 6)}`
// 确定不可达：随机高位端口，无服务监听即连接拒绝（fleet-notify 离线锚点同款）
const OFFLINE_NAME = `e2e-inst-relay-off-${Math.random().toString(36).slice(2, 6)}`
const OFFLINE_URL = `http://127.0.0.1:4${Math.floor(1000 + Math.random() * 9000)}`

/** fake 远端实例收到的请求（只读边界断言的证据面） */
const received: Array<{ method: string; path: string }> = []

const SESSIONS = [
  {
    id: SESSION_OK, title: `${MARK}-有结论`, cwd: '/home/fleet-a/web', messageCount: 12,
    firstAt: '2026-10-06T01:00:00Z', lastAt: '2026-10-06T09:00:00Z', sizeBytes: 2048, active: false,
  },
  {
    id: SESSION_NOASST, title: `${MARK}-无结论`, cwd: '/home/fleet-a/api', messageCount: 2,
    firstAt: '2026-10-06T02:00:00Z', lastAt: '2026-10-06T08:00:00Z', sizeBytes: 512, active: false,
  },
  {
    id: SESSION_ACTIVE, title: `${MARK}-进行中`, cwd: '/home/fleet-a/web', messageCount: 40,
    firstAt: '2026-10-06T03:00:00Z', lastAt: '2026-10-06T10:00:00Z', sizeBytes: 8192, active: true,
  },
]

const TIMELINES: Record<string, Array<{ kind: string; at: string; text: string }>> = {
  // 有结论：末尾 assistant 文本是接力源（中间 tool/user 被结论优先弃过程排除）
  [SESSION_OK]: [
    { kind: 'user', at: '2026-10-06T01:00:00Z', text: '重构登录页' },
    { kind: 'tool', at: '2026-10-06T01:05:00Z', text: 'Edit src/Login.vue' },
    { kind: 'assistant', at: '2026-10-06T09:00:00Z', text: CONCLUSION },
  ],
  // 无结论：纯 user/tool 会话（接力如实放弃）
  [SESSION_NOASST]: [
    { kind: 'user', at: '2026-10-06T02:00:00Z', text: '看看 CI 为什么红' },
    { kind: 'tool', at: '2026-10-06T02:01:00Z', text: 'Bash npm test' },
  ],
  // 进行中：有结论但活跃（行内不显接力角标，点击被守卫拦下——结论未定型）
  [SESSION_ACTIVE]: [
    { kind: 'user', at: '2026-10-06T03:00:00Z', text: '继续做暗色主题' },
    { kind: 'assistant', at: '2026-10-06T10:00:00Z', text: '进行中的中间结论，还没定型' },
  ],
}

let fake: http.Server | null = null
let fakePort = 0
let unlockToken = ''
let instanceId = ''
let offlineInstanceId = ''

function startFakeServer(): Promise<number> {
  return new Promise((resolve) => {
    fake = http.createServer((req, res) => {
      const u = req.url || ''
      received.push({ method: req.method || '', path: u })
      res.setHeader('Content-Type', 'application/json')
      // 实例判活探测（checkInstanceURL 打 /api/settings，data.version 判 online）
      if (u.startsWith('/api/settings')) {
        res.end(JSON.stringify({ data: { version: '9.9.9-e2e' } }))
        return
      }
      // timeline 两跳：limit=1 只探 total（useInstanceRelay.fetchTailTotal 契约）
      const tl = u.match(/^\/api\/claude\/sessions\/([^/]+)\/timeline/)
      if (tl) {
        const id = decodeURIComponent(tl[1]!)
        const entries = TIMELINES[id] || []
        if (u.includes('limit=1')) {
          res.end(JSON.stringify({ data: { total: entries.length, truncated: false } }))
        } else {
          res.end(JSON.stringify({ data: { entries, total: entries.length, truncated: false } }))
        }
        return
      }
      if (u.startsWith('/api/claude/sessions')) {
        res.end(JSON.stringify({ data: { sessions: SESSIONS, total: SESSIONS.length } }))
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    fake.listen(0, '127.0.0.1', () => resolve((fake!.address() as AddressInfo).port))
  })
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return res
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  fakePort = await startFakeServer()
  const create = await api('POST', '/api/instances', { name: INST_NAME, url: `http://127.0.0.1:${fakePort}` })
  expect(create.ok).toBeTruthy()
  instanceId = ((await create.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()

  // 离线实例（不可达降级态的确定性锚点），测试后清理
  const off = await api('POST', '/api/instances', { name: OFFLINE_NAME, url: OFFLINE_URL })
  expect(off.ok).toBeTruthy()
  offlineInstanceId = ((await off.json()) as { data?: { id?: string } }).data?.id || ''
})

test.afterAll(async () => {
  if (instanceId) await api('DELETE', `/api/instances/${instanceId}`).catch(() => {})
  if (offlineInstanceId) await api('DELETE', `/api/instances/${offlineInstanceId}`).catch(() => {})
  if (fake) await new Promise<void>(resolve => fake!.close(() => resolve()))
})

/** 清理全部终端会话：接力会创建真实本机会话，残留会污染后续用例会话表 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = await request.get(`${API_BASE}/api/terminals`, { headers })
  for (const s of ((await list.json()) as { data?: { id: string }[] }).data || []) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
  }
}

/** 打开会话中心（管理页 Claude 页签）与接力弹层 */
async function openRelayDialog(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.ats-tab', { hasText: 'Claude' }).click()
  const picker = view.locator('.csp-root')
  await expect(picker).toBeVisible({ timeout: 8000 })
  await picker.locator('[data-test="instance-relay-open"]').click()
  const modal = page.locator('.n-modal').filter({ hasText: '从实例接力' }).first()
  await expect(modal).toBeVisible({ timeout: 8000 })
  // 只读边界注记随弹层出现（跨实例零写回的界面承诺）
  await expect(modal.locator('[data-test="instance-relay-note"]')).toBeVisible()
  return modal
}

/** 在弹层里选择来源实例（n-select 选项按实例名定位）。选择后不等具体响应——
 *  弹层打开时可能已自动选中并装载过一次（重选同值 update:value 是否触发属
 *  naive-ui 内部语义），后续断言一律锚定行/降级态的可见性，两者都是装载完成
 *  的确定性产物 */
async function selectInstance(page: Page, modal: ReturnType<Page['locator']>, name: string) {
  await modal.locator('[data-test="instance-relay-instance"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

test.describe('跨实例会话接力（P-20261003-218）', () => {
  test.afterEach(async ({ request }) => {
    await cleanupTerminals(request)
  })

  test('接力行入口：launchArgs 精确携远端尾部结论（dir 不携带，≤500 字节）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openRelayDialog(page)
    await selectInstance(page, modal, INST_NAME)

    const row = modal.locator(`[data-test="instance-relay-row-${SESSION_OK}"]`)
    await expect(row).toBeVisible({ timeout: 10000 })
    await expect(row).toContainText(`${MARK}-有结论`)

    const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
    await row.click()
    const req = await createReq
    const body = req.postDataJSON() as { kind?: string; name?: string; runtime?: string; dir?: string; launchArgs?: string }

    expect(body.kind).toBe('agent')
    expect(body.runtime).toBe('claude')
    // 会话名 = 实例接力前缀 + 远端会话标题
    expect(body.name || '').toContain('实例接力 · ')
    expect(body.name || '').toContain(`${MARK}-有结论`)
    // 前言模板精确形态（与 P-114 同模板）：远端尾窗最后一条 assistant 结论原样直达
    const la = body.launchArgs || ''
    expect(la).toBe(`此前会话结论：${CONCLUSION}，请继续`)
    expect(Buffer.byteLength(la, 'utf8')).toBeLessThanOrEqual(500)
    // 跨实例与本机接力的关键差异：dir 不携带（远端 cwd 是远端机器的路径，
    // 本机不存在，携带必被 createAgent 的目录校验拒绝）
    expect(body.dir === undefined || body.dir === null || body.dir === '').toBe(true)

    // 只读边界（任务书②）：接力全流程打到远端的请求全为 GET，且 timeline 确实
    // 打到了远端（摘要来自远端而非本机）；无策展/终端写端点被触达
    expect(received.length).toBeGreaterThanOrEqual(3)
    expect(received.some(r => r.path.includes(`/claude/sessions/${SESSION_OK}/timeline`))).toBe(true)
    for (const r of received) {
      expect(r.method, `远端收到的必须是 GET，实际 ${r.method} ${r.path}`).toBe('GET')
      expect(r.path).not.toContain('curation')
    }
  })

  test('无结论会话：如实提示放弃，不发创建请求；进行中行无接力角标', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openRelayDialog(page)
    await selectInstance(page, modal, INST_NAME)

    // 进行中会话：结论未定型，行内不显接力角标（显「进行中」）
    const activeRow = modal.locator(`[data-test="instance-relay-row-${SESSION_ACTIVE}"]`)
    await expect(activeRow).toBeVisible({ timeout: 10000 })
    await expect(activeRow).not.toContainText('接力')
    await expect(activeRow).toContainText('进行中')

    const row = modal.locator(`[data-test="instance-relay-row-${SESSION_NOASST}"]`)
    await expect(row).toBeVisible({ timeout: 10000 })
    const posts: string[] = []
    page.on('request', r => {
      if (r.url().includes('/api/terminals') && r.method() === 'POST') posts.push(r.url())
    })
    await row.click()
    // 放弃提示（空前言不误导接力语义），且未创建会话
    await expect(page.locator('.n-message').filter({ hasText: '没有可接力的结论' })).toBeVisible({ timeout: 5000 })
    expect(posts).toHaveLength(0)
  })

  test('不可达实例：降级提示，切回健康实例列表恢复（失败可恢复）', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const modal = await openRelayDialog(page)
    await selectInstance(page, modal, OFFLINE_NAME)

    // 连接拒绝 → 不可达降级态（如实告知，可刷新重试）
    await expect(modal.locator('[data-test="instance-relay-unreachable"]')).toBeVisible({ timeout: 10000 })

    // 切回健康实例：列表恢复（降级不粘滞）
    await selectInstance(page, modal, INST_NAME)
    await expect(modal.locator(`[data-test="instance-relay-row-${SESSION_OK}"]`)).toBeVisible({ timeout: 10000 })
  })
})
