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
})
