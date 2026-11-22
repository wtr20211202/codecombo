import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 终端只读直播分享（P-20261003-306）E2E：
 *   1. 校验链路：未知会话 404 / 访客面无输入端点（POST → 405）/ 越权 token 404
 *   2. 全链路：创建终端 → 直播分享 → 访客页 xterm 渲染 + 「直播中」→ 终端打印
 *      令牌形态 → 访客侧只见 *** → 撤销 → 访客页「已结束」
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

/** 分享行投影（本 spec 只取 token/到期时点/遮蔽模式；无 expiresAt = 永久记录） */
interface ShareRow {
  token: string
  expiresAt?: string
  unfiltered?: boolean
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性；终端直播撤销同时断流） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
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

/** 开一个普通 shell 终端并回读会话 ID（直播源） */
async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<string> {
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name: 'e2e-live-src' } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

test.describe('share-terminal-live', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  // 撤销测试开的终端（native 会话存活不影响其他用例，但礼貌清场）
  let liveSessionId = ''
  test.afterEach(async ({ request }) => {
    if (liveSessionId) {
      const headers = await unlockHeaders(request)
      await request.delete(`${BASE}/api/terminals/${liveSessionId}`, { headers })
      liveSessionId = ''
    }
  })

  test('校验链路：未知会话 404 / 访客无输入端点 405 / 越权 token 404 / 错形态 400', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)

    // 未知会话 → 404（无可直播的源，不做空直播记录）
    const bad = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: 'no-such-session' } })
    expect(bad.status()).toBe(404)

    // 开会话建直播
    const projectId = await getProjectId(request, headers)
    const sessionId = await createTerminal(request, headers, projectId)
    liveSessionId = sessionId
    const created = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(created.ok()).toBeTruthy()
    const share = ((await created.json()) as { data?: { token: string; kind: string; terminalId: string; expiresAt: string } }).data
    expect(share?.token).toBeTruthy()
    expect(share?.kind).toBe('terminal')
    expect(share?.terminalId).toBe(sessionId)
    expect(share?.expiresAt).toBeTruthy() // 默认 30 分钟 TTL

    // 幂等：同会话重建恒同链
    const again = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(((await again.json()) as { data?: { token: string } }).data?.token).toBe(share!.token)

    // 访客页可开且是终端直播页（非文件分享页）
    const page = await request.get(`${shareBase}/s/${share!.token}`)
    expect(page.status()).toBe(200)
    const html = await page.text()
    expect(html).toContain('/assets/xterm.js')
    expect(html).toContain('/stream')

    // 严格只读：访客面无输入端点——POST/PUT 到直播口 → 405 + Allow: GET
    for (const method of ['post', 'put'] as const) {
      const res = await request[method](`${shareBase}/s/${share!.token}/stream`, { data: 'x' })
      expect(res.status()).toBe(405)
      expect((res.headers()['allow'] || '').toLowerCase()).toBe('get')
    }

    // 越权/乱敲 token → 404（存在性信号无从探测的形态门禁同样适用）
    expect((await request.get(`${shareBase}/s/zzzzzzzzzzzzzzzz`)).status()).toBe(404)
    expect((await request.get(`${shareBase}/s/zzzzzzzzzzzzzzzz/stream`)).status()).toBe(404)

    // 文件分享没有流语义 → 400
    const fs = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: 'docs' } })
    expect(fs.ok()).toBeTruthy()
    const fsToken = ((await fs.json()) as { data?: { token: string } }).data!.token!
    expect((await request.get(`${shareBase}/s/${fsToken}/stream`)).status()).toBe(400)
  })

  test('全链路：创建 → 访客页看到输出 → 终端打印令牌形态 → 访客侧只见 *** → 撤销 → 已结束', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    await fixedLocale(page)

    const sessionId = await createTerminal(request, headers, projectId)
    liveSessionId = sessionId
    const created = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(created.ok()).toBeTruthy()
    const token = ((await created.json()) as { data?: { token: string } }).data!.token!

    // 访客打开直播页：xterm 屏渲染 + 「直播中」指示 + 遮蔽声明横幅
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#bannerText')).toContainText('遮蔽')
    // 只读态头部副标题（P-20261119-3 sub 三态 e2e 之「只读」）：非可写分享
    // ES hello 后 sub = 只读文案（与页面实际能力一致）
    await expect(page.locator('#sub')).toContainText(/只读直播|read-only/i)
    // 播种回看（创建前 shell 的 banner/提示符）已铺进访客屏
    await expect(page.locator('.xterm-rows')).toContainText(/\$|>|#/, { timeout: 20_000 })

    // 终端打印令牌形态值（sca_ 系整段遮蔽）：走管理面广播写入（带换行执行）
    const SECRET = 'sca_e2eLive0Secret1'
    const echoLine = `echo LIVE_${SECRET}_TAIL`
    const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `${echoLine}\r` },
    })
    expect(wr.ok()).toBeTruthy()

    // 访客侧：遮蔽形态可见（***），敏感值本体零残留
    await expect(page.locator('.xterm-rows')).toContainText('LIVE_***_TAIL', { timeout: 20_000 })
    const screenText = await page.locator('.xterm-rows').innerText()
    expect(screenText).not.toContain(SECRET)

    // 撤销 → SSE end 帧 → 访客页「已结束」
    const del = await request.delete(`${BASE}/api/share/${token}`, { headers })
    expect(del.ok()).toBeTruthy()
    await expect(page.locator('#badge[data-state="ended"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#stateBox')).toContainText('已结束')

    // 撤销后短链死亡：页面 404
    expect((await request.get(`${shareBase}/s/${token}`)).status()).toBe(404)
  })

  test('永久挡（P-20261119-5）：创建无到期时点 / 幂等保持 / 未过滤组合合法落库零值 / 改期钳 24h / 清回永久 / 撤销死亡', async ({ request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const sessionId = await createTerminal(request, headers, projectId)
    liveSessionId = sessionId

    // 未过滤 × 永久组合先行（【用户定向修订】2026-11-19：合法、不再 400 硬禁
    // ——组合先建才能落 fresh 记录；遮蔽模式创建时定死，后建的遮蔽档会幂等
    // 命中本记录）。落库零值断言：ExpiresAt 不被 store 静默钳回 24h
    const combo = await request.post(`${BASE}/api/share/terminal`, {
      headers, data: { sessionId, permanent: true, unfiltered: true },
    })
    expect(combo.ok()).toBeTruthy()
    const comboRow = ((await combo.json()) as { data?: ShareRow }).data!
    expect(comboRow.token).toBeTruthy()
    expect(comboRow.unfiltered).toBe(true)
    expect(comboRow.expiresAt).toBeUndefined()

    // 组合幂等重建：同链（未过滤直播 token 派生键带模式后缀）、仍无到期时点
    const comboAgain = await request.post(`${BASE}/api/share/terminal`, {
      headers, data: { sessionId, permanent: true, unfiltered: true },
    })
    expect(comboAgain.ok()).toBeTruthy()
    const comboAgainRow = ((await comboAgain.json()) as { data?: ShareRow }).data!
    expect(comboAgainRow.token).toBe(comboRow.token)
    expect(comboAgainRow.expiresAt).toBeUndefined()

    // 撤销组合记录（一个会话同一时刻至多一条直播——遮蔽档须先腾位）
    expect((await request.delete(`${BASE}/api/share/${comboRow.token}`, { headers })).ok()).toBeTruthy()

    // 显式永久（遮蔽档）：记录无到期时点 = 链接与 token 不过期（直播态本身仍随会话）
    const created = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId, permanent: true } })
    expect(created.ok()).toBeTruthy()
    const share = ((await created.json()) as { data?: ShareRow }).data!
    expect(share.token).toBeTruthy()
    expect(share.unfiltered).toBeFalsy()
    expect(share.expiresAt).toBeUndefined()

    // 幂等重建（显式永久）：同链；记录本就无到期时点（不清窗也无窗可清）
    const again = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId, permanent: true } })
    expect(again.ok()).toBeTruthy()
    const againRow = ((await again.json()) as { data?: ShareRow }).data!
    expect(againRow.token).toBe(share.token)
    expect(againRow.expiresAt).toBeUndefined()

    // 改期：显式时点越 24h 被钳回上限（「非显式永久不越 24h」与创建面对称）
    const far = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString()
    const capped = await request.post(`${BASE}/api/share/${share.token}/expiry`, { headers, data: { expiresAt: far } })
    expect(capped.ok()).toBeTruthy()
    const cappedRow = ((await capped.json()) as { data?: ShareRow }).data!
    const remain = new Date(cappedRow.expiresAt!).getTime() - Date.now()
    expect(remain).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5 * 60_000)

    // 显式永久幂等命中倒计时记录：同链且旧窗被清（store 幂等保留旧值是安全
    // 边界，清窗由 handler 经 SetExpiry 落——P-20261119-5 幂等语义钉死面，
    // store 层对应断言在 share_terminal_ttl_test）
    const clearHit = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId, permanent: true } })
    expect(clearHit.ok()).toBeTruthy()
    const clearHitRow = ((await clearHit.json()) as { data?: ShareRow }).data!
    expect(clearHitRow.token).toBe(share.token)
    expect(clearHitRow.expiresAt).toBeUndefined()

    // 改回永久：null 清窗（同端点双向），列表投影同步不带 expiresAt
    const cleared = await request.post(`${BASE}/api/share/${share.token}/expiry`, { headers, data: { expiresAt: null } })
    expect(cleared.ok()).toBeTruthy()
    expect(((await cleared.json()) as { data?: ShareRow }).data!.expiresAt).toBeUndefined()
    const list = await request.get(`${BASE}/api/share`, { headers })
    const row = (((await list.json()) as { data?: ShareRow[] }).data || []).find(s => s.token === share.token)
    expect(row?.expiresAt).toBeUndefined()

    // 撤销：永久记录同样即时死亡（撤销链零特殊）
    expect((await request.delete(`${BASE}/api/share/${share.token}`, { headers })).ok()).toBeTruthy()
    expect((await request.get(`${BASE}/api/share/${share.token}`, { headers })).status()).toBe(404)
  })
})
