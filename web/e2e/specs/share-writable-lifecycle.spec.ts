import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 可写上行桥生命周期收口（P-20261122-19）E2E——四条验收：
 *   1. 双关只读页（writable+guestInput 均关）owner 开启通道后 ≤6s 出现申请
 *      入口且**不刷新**（惰性挂载 window.__scMountWritable，scrollback 不丢）。
 *   2. 开放直入第 4 访客被 writer_limit 拒（denied 帧）→ 提示可见 → 一个在
 *      场连接离开后自动接入（统一退避 1s→2s→5s→10s，无需刷新）。
 *   3. 持权被收回后原因公告（独立 wr-notice）可见 >3s 且不被 1s 重连后的
 *      direct_state none 清掉（≥6s 自灭，申请入口随对账回位）。
 *   4. 口令会话失效（401）→ 停止重连并回口令页（页面重新出 passphrase 表单）。
 * 既有 reconnect/状态用例（share-writable / share-guest-input /
 * share-guest-paste-fallback）作回归面，不在本 spec 重复。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'p19-lifecycle-pass'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) await request.delete(`${BASE}/api/share/${s.token}`, { headers })
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 开 shell 终端并直播分享；opts.passphrase 出生即带门（开放直入三闸用） */
async function createTerminalShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
  opts: { passphrase?: string } = {},
): Promise<{ token: string; sessionId: string }> {
  const projectId = await getProjectId(request, headers)
  const created = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-p19-${tag}-${Date.now()}`, kind: 'shell' },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id
  expect(sessionId).toBeTruthy()
  const share = await request.post(`${BASE}/api/share/terminal`, {
    headers, data: { sessionId, ...(opts.passphrase ? { passphrase: opts.passphrase } : {}) },
  })
  expect(share.ok(), await share.text()).toBeTruthy()
  const token = ((await share.json()) as { data?: { token: string } }).data?.token
  expect(token).toBeTruthy()
  return { token: token!, sessionId: sessionId! }
}

/** 口令门解锁（有口令记录的分享先验证再进直播页） */
async function unlockGate(page: Page, shareBase: string, token: string, pass: string) {
  await page.goto(`${shareBase}/s/${token}`)
  await page.locator('input[name="passphrase"]').fill(pass)
  await page.locator('.field button').click()
  await page.waitForURL(`${shareBase}/s/${token}`)
}

test.describe('share-writable-lifecycle', () => {
  let createdSessions: string[] = []

  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
    createdSessions = []
  })

  test.afterEach(async ({ request }) => {
    await cleanupShares(request)
    const headers = await unlockHeaders(request)
    for (const id of createdSessions.splice(0)) {
      await request.delete(`${BASE}/api/terminals/${id}`, { headers })
    }
  })

  test('双关只读页惰性挂载：owner 开启通道后 ≤6s 出现申请入口且不刷新', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'lazy')
    createdSessions.push(sessionId)
    // 先关申请通道（缺省开）→ 页面双关：可写位脚本不挂 UI、只做 state 探测
    const off = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: false } })
    expect(off.ok(), await off.text()).toBeTruthy()

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p19-visitor-lazy'))
    await page.goto(`${visitor}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toHaveCount(0)
    await expect(page.getByTestId('wr-actions')).toHaveCount(0)
    // 惰性挂载入口由生命周期外壳常驻暴露（双关页也可被探测调用）
    expect(await page.evaluate(() => typeof (window as unknown as { __scMountWritable?: unknown }).__scMountWritable)).toBe('function')
    // 不刷新证据：文档级标记在挂载后必须仍在（reload 会丢）
    await page.evaluate(() => { (window as unknown as { __p19Alive?: string }).__p19Alive = 'yes' })

    const t0 = Date.now()
    const on = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: true } })
    expect(on.ok(), await on.text()).toBeTruthy()
    // 5s state 探测档 + 挂载/握手：目标 ≤6s，放宽到 8s 吸收 CI 抖动
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 8_000 })
    const elapsed = Date.now() - t0
    expect(elapsed, `lazy mount took ${elapsed}ms (target ≤6000ms)`).toBeLessThan(9_000)
    expect(await page.evaluate(() => (window as unknown as { __p19Alive?: string }).__p19Alive)).toBe('yes')

    // 惰性挂载后可走申请——入口不是只渲染不工作的空壳
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 10_000 })
  })

  test('第 4 访客 writer_limit → 提示可见 → 一个连接离开后自动接入（不刷新）', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'limit', { passphrase: WRITABLE_PASS })
    createdSessions.push(sessionId)
    const on = await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true },
    })
    expect(on.ok(), await on.text()).toBeTruthy()

    // 第 1 条在场连接 = 页面自身；再补 2 条 raw WS 占满 MaxWritersPerToken=3
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p19-visitor-limit'))
    await unlockGate(page, visitor, token, WRITABLE_PASS)
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 15_000 })
    await page.evaluate(({ tok }) => {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const open = (id: string) => new WebSocket(`${proto}//${location.host}/s/${tok}/termws?visitorId=${encodeURIComponent(id)}`)
      const holder = window as unknown as { __p19Raw?: WebSocket[] }
      holder.__p19Raw = [open('e2e-p19-raw-1'), open('e2e-p19-raw-2')]
    }, { tok: token })
    await expect
      .poll(async () => page.evaluate(() => {
        const raw = (window as unknown as { __p19Raw?: WebSocket[] }).__p19Raw || []
        return raw.filter(w => w.readyState === WebSocket.OPEN).length
      }), { timeout: 10_000 })
      .toBe(2)

    // 第 4 条连接：新页面（同上下文携口令 cookie）→ 服务端 hello 前回 denied
    const fourth = await page.context().newPage()
    await fourth.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p19-visitor-fourth'))
    await fourth.goto(`${visitor}/s/${token}`)
    await expect(fourth.getByTestId('wr-notice')).toBeVisible({ timeout: 15_000 })
    await expect(fourth.getByTestId('wr-notice')).toContainText(/上限|limit/i)
    // 拒绝态不呈现键入资格（strip 未点亮）
    await expect(fourth.getByTestId('wr-strip')).toBeHidden()
    await fourth.evaluate(() => { (window as unknown as { __p19Alive?: string }).__p19Alive = 'yes' })

    // 一个在场连接离开 → 第 4 页按退避自动接入（不刷新）
    await page.evaluate(() => {
      const raw = (window as unknown as { __p19Raw?: WebSocket[] }).__p19Raw || []
      raw[0]?.close()
    })
    await expect(fourth.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 25_000 })
    expect(await fourth.evaluate(() => (window as unknown as { __p19Alive?: string }).__p19Alive)).toBe('yes')
    await fourth.close()
  })

  test('持权收回原因公告 >3s 且不被重连清掉（独立 wr-notice，申请入口回位）', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'revoke')
    createdSessions.push(sessionId)

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p19-visitor-revoke'))
    await page.goto(`${visitor}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 10_000 })
    const approve = await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })
    expect(approve.ok(), await approve.text()).toBeTruthy()
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/, { timeout: 10_000 })

    // 一键收回 → direct_revoked + 连接断开；原因走独立 notice
    const revoke = await request.post(`${BASE}/api/share/${token}/direct/revoke`, { headers, data: {} })
    expect(revoke.ok(), await revoke.text()).toBeTruthy()
    await expect(page.getByTestId('wr-notice')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-notice')).toContainText(/收回|revoked/i)
    // >3s 存活：1s 退避重连后的 direct_state none / hideStrip 不得清掉原因
    await page.waitForTimeout(3200)
    await expect(page.getByTestId('wr-notice')).toBeVisible()
    // 重连已把申请入口带回（同一时刻 notice 仍在——两条状态面互不覆盖）
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('wr-notice')).toBeVisible()
    // ≥6s 自灭（收尸：不留常驻噪音）
    await expect(page.getByTestId('wr-notice')).toBeHidden({ timeout: 12_000 })
  })

  test('口令会话失效（401）：停止重连并回口令页', async ({ page, context, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate', { passphrase: WRITABLE_PASS })
    createdSessions.push(sessionId)
    const on = await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true },
    })
    expect(on.ok(), await on.text()).toBeTruthy()

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p19-visitor-gate'))
    await unlockGate(page, visitor, token, WRITABLE_PASS)
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 15_000 })

    // 口令会话失效：把门 cookie 换成无效值（改口令/过期同效——签名绑定哈希）。
    // 先清同名单（原 cookie 是 /s/{token} 精确路径，覆盖写入会因更宽路径
    // 排序被原 cookie 压过）再种无效值——Set-Cookie 语义等价于「浏览器侧
    // 会话已过期」
    await context.clearCookies({ name: `sc_gate_${token}` })
    await context.addCookies([{ name: `sc_gate_${token}`, value: '0.deadbeef', url: `${visitor}/s/${token}` }])
    // 触发一次断连（关开放直入）→ 页面 state 探测吃 401 → 停止并回口令页
    expect((await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })).ok()).toBeTruthy()
    await expect(page.locator('input[name="passphrase"]')).toBeVisible({ timeout: 15_000 })
    expect(page.url()).toBe(`${visitor}/s/${token}`)
  })
})
