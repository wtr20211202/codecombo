import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, gotoAndUnlock } from '../../tests/helpers'

/**
 * 可写视口反喂 resize 状态机治理（P-20261122-16，用户实测立案）E2E：
 * 覆盖提案验收段全部断言——持权后 25s 采样 data-cols 变化 ≤1 且终值≈视口目标 /
 * 审计 share.writableResize 计数 ≤2 / 主机 PTY 尺寸与客页终值一致 / 主人 PUT 后
 * >10s 客页不抢回 / owner 先附着再让访客持权时客页不反喂且 owner PTY 不被改 /
 * owner_active 拒绝后画布回主机栅格 / 390 视口目标 <80 不反喂 / 服务端 guest
 * 路径对 <80 请求钳到 80（owner PUT 的 20 下限不受影响）。
 *
 * 主机尺寸的观测面 = `GET /s/{token}/stream` 的 hello 帧：服务端实时读
 * `terminal.Session.Size()`（lastCols/lastRows，与 PUT resize 同一事实源），
 * 是访客侧可拿到的「主机会话 PTY 现在多大」的权威读数。
 *
 * 独立文件（不并入 share-writable.spec.ts）：后者已 700+ 行，本组用例含 25s
 * 采样与多视口多上下文，语义是「反喂状态机」而非「开关/粘贴链」。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'wr-e2e-pass-1'

interface AuditEvent {
  action: string
  detail?: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态；撤销同时级联清可写上行与持权） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 开 shell 终端并直播分享（可写档主形态），钉主机栅格 80×24 */
async function createWritableShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
): Promise<{ token: string; sessionId: string }> {
  const projects = ((await (await request.get(`${BASE}/api/projects`, { headers })).json()) as {
    data?: { id: string; name: string }[]
  }).data || []
  const projectId = projects.find(p => p.name === PROJECT_NAME)?.id
  if (!projectId) throw new Error(`project ${PROJECT_NAME} not found`)
  const created = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-vpr-${tag}`, kind: 'shell' },
  })
  expect(created.ok(), await created.text()).toBeTruthy()
  const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id
  if (!sessionId) throw new Error('session id missing')
  const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
  expect(share.ok(), await share.text()).toBeTruthy()
  const token = ((await share.json()) as { data?: { token: string } }).data?.token
  if (!token) throw new Error('share token missing')
  // 钉主机栅格：访客驱动的改格效果可与主机值对照
  expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
    headers, data: { rows: 24, cols: 80 },
  })).ok()).toBeTruthy()
  expect((await request.post(`${BASE}/api/share/${token}/writable`, {
    headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
  })).ok()).toBeTruthy()
  return { token, sessionId }
}

/** 访客页（独立浏览器上下文）：过口令门 → 等终端渲染 */
async function openGuestPage(
  browser: import('@playwright/test').Browser,
  shareBase: string,
  token: string,
  viewport: { width: number; height: number },
): Promise<{ ctx: import('@playwright/test').BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport, locale: 'zh-CN' })
  const page = await ctx.newPage()
  await page.goto(`${shareBase}/s/${token}`)
  const gate = page.locator('input[name="passphrase"]')
  if (await gate.count()) {
    await gate.fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
  }
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
  return { ctx, page }
}

/** 客页当前渲染栅格列数（scFitGrid 写 termBox.dataset.cols） */
async function colsOf(page: Page): Promise<string> {
  return page.evaluate(() => document.getElementById('termBox')?.dataset.cols || '')
}

/** 客页按自身视口算出的反喂目标列数（与页面 vpTarget 同式：视口宽 − .wrap 内边距
 *  − 固定 chrome 36，除 14px 格宽；不读 termBox——那是 +2 列回读环的根因） */
async function targetColsOf(page: Page): Promise<number> {
  return page.evaluate(() => {
    const box = document.getElementById('termBox') as HTMLElement | null
    const wrap = box?.closest('.wrap') as HTMLElement | null
    if (!box || !wrap) return -1
    const cs = getComputedStyle(wrap)
    const padX = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0)
    const cell = (window as unknown as { scCellAt: (fs: number) => { w: number } }).scCellAt(14)
    return Math.floor((document.documentElement.clientWidth - padX - 36) / cell.w)
  })
}

/** 读直播流 hello 帧（服务端实时读会话 PTY 尺寸 = 主机栅格权威读数） */
async function readHello(page: Page, streamURL: string): Promise<{ cols?: number; rows?: number }> {
  return page.evaluate(async (u) => {
    return await new Promise<{ cols?: number; rows?: number }>((resolve, reject) => {
      const es = new EventSource(u)
      const timer = setTimeout(() => { es.close(); reject(new Error('hello timeout')) }, 8000)
      es.addEventListener('hello', (ev) => {
        clearTimeout(timer)
        es.close()
        resolve(JSON.parse((ev as MessageEvent).data))
      })
      es.onerror = () => { /* keepalive/重连噪声：只等 hello */ }
    })
  }, streamURL)
}

/** 轮询审计台账取该 token 的指定动作（3s 定时批量入账）：先等 settleMs 让批次
 *  落账，再等到至少一条（最多再等 10s） */
async function auditsFor(
  request: APIRequestContext,
  headers: Record<string, string>,
  action: string,
  token: string,
  settleMs: number,
): Promise<AuditEvent[]> {
  const start = Date.now()
  const settleUntil = start + settleMs
  const deadline = start + settleMs + 10_000
  let hits: AuditEvent[] = []
  for (;;) {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    hits = events.filter(e => e.action === action && (e.detail || '').includes(token))
    const now = Date.now()
    if (now >= settleUntil && hits.length > 0) break
    if (now > deadline) break
    await new Promise(r => setTimeout(r, 400))
  }
  return hits
}

/** 在访客页内开一条 termws 并发送 Text 控制帧（原生 WebSocket：同源 Origin +
 *  口令 cookie 全真），收满 want 帧返回 */
async function sendControlFrames(
  page: Page,
  token: string,
  sends: string[],
  want: number,
): Promise<string[]> {
  return page.evaluate(async ({ tok, frames, count }) => {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    const ws = new WebSocket(`${proto}${location.host}/s/${tok}/termws?visitorId=${encodeURIComponent('v-e2e-vpr')}`)
    const got: string[] = []
    return await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close() } catch { /* already */ } reject(new Error(`ws timeout, frames=${got.join(' | ')}`)) }, 10_000)
      ws.onmessage = (ev) => {
        got.push(String(ev.data))
        if (got.length >= count) { clearTimeout(timer); resolve(got); try { ws.close() } catch { /* already */ } }
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`ws error, frames=${got.join(' | ')}`)) }
      ws.onopen = () => { for (const f of frames) ws.send(f) } // 字符串帧 = TextMessage 控制帧
    })
  }, { tok: token, frames: sends, count: want })
}

test.describe('share-writable-resize', () => {
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

  test('反喂稳定：25s 采样 data-cols 变化 ≤1 + 审计 ≤2 + 主人 PUT 后 >10s 不抢回', async ({ request, browser }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createWritableShare(request, headers, 'stable')
    createdSessions.push(sessionId)

    const guest = await openGuestPage(browser, shareBase, token, { width: 1920, height: 1080 })
    // 等首帧主机栅格落地（hello → setHost），再开始采样
    await expect.poll(() => colsOf(guest.page), { timeout: 15_000 }).not.toBe('')

    // 25s 采样（1s 粒度）：旧实现每轮 +2 列正反馈（基线实测同视口 5s 内
    // 198→214），修复后应只有「主机 80 → 视口目标」一次变化
    const samples: string[] = []
    for (let i = 0; i < 26; i++) {
      samples.push(await colsOf(guest.page))
      await guest.page.waitForTimeout(1000)
    }
    const distinct = Array.from(new Set(samples))
    expect(distinct.length - 1, `data-cols 采样序列: ${samples.join(',')}`).toBeLessThanOrEqual(1)
    const finalCols = parseInt(samples[samples.length - 1] || '0', 10)
    // 终值≈视口目标（视口稳定宽；1 列取整容差）
    const target = await targetColsOf(guest.page)
    expect(target).toBeGreaterThanOrEqual(150)
    expect(Math.abs(finalCols - target), `data-cols=${finalCols} target=${target}`).toBeLessThanOrEqual(1)
    // 主机 PTY 尺寸 = 客页终值（hello 实时读会话尺寸，与 PUT resize 同事实源）
    const hello = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(hello.cols).toBe(finalCols)

    // 审计计数 ≤2：一次到位只应留一条（首帧+后续微调最多两条）
    const audits = await auditsFor(request, headers, 'share.writableResize', token, 3000)
    expect(audits.length, `审计条目: ${JSON.stringify(audits)}`).toBeGreaterThanOrEqual(1)
    expect(audits.length).toBeLessThanOrEqual(2)

    // 主人 PUT resize 抢回 → 客页跟随；**>10s 后仍不抢回**（旧实现 10s 抑制窗
    // 到点即回踩，P-20261120-8 只测了 2s）
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 24, cols: 80 },
    })).ok()).toBeTruthy()
    await expect(guest.page.locator('#termBox')).toHaveAttribute('data-cols', '80', { timeout: 10_000 })
    await guest.page.waitForTimeout(12_000)
    expect(await colsOf(guest.page), '主人 PUT 后 12s 客页不得抢回').toBe('80')
    const helloAfter = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(helloAfter.cols).toBe(80)
    await guest.ctx.close()
  })

  test('owner 附着门：主人在系统内开着会话时客页不反喂、owner PTY 不被改；主人离开后恢复', async ({ request, browser, page }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createWritableShare(request, headers, 'owner')

    // 主人侧：打开工作台页面源并挂一条系统内终端 WS（= 主人在系统里看着这个会话）
    await page.goto(`${BASE}/`)
    await page.waitForTimeout(1200)
    await page.evaluate((sid) => new Promise<void>((resolve, reject) => {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
      const ws = new WebSocket(`${proto}${location.host}/ws/terminal/${sid}`)
      ;(window as unknown as { __e2eOwnerWs?: WebSocket }).__e2eOwnerWs = ws
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('owner terminal ws handshake failed'))
    }), sessionId)
    await page.waitForTimeout(400)

    const guest = await openGuestPage(browser, shareBase, token, { width: 1920, height: 1080 })
    // 客页反喂请求被 owner_active 拒绝 → 画布维持主机栅格 80，状态条给出可见原因
    await expect(guest.page.locator('#termBox')).toHaveAttribute('data-cols', '80', { timeout: 15_000 })
    await expect(guest.page.getByTestId('wr-text')).toContainText(/主人|owner/i, { timeout: 15_000 })
    await guest.page.waitForTimeout(2500)
    expect(await colsOf(guest.page)).toBe('80')
    // owner 的 PTY 未被改（24 行 80 列原样）
    const hello = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(hello.cols).toBe(80)
    expect(hello.rows).toBe(24)

    // 主人在本机改格（PUT）→ 客页跟随主人栅格；随后客页自己改视口再试反喂
    // （ownerHold 被几何变更解除）→ 仍被拒，画布回主机值 100
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 30, cols: 100 },
    })).ok()).toBeTruthy()
    await expect(guest.page.locator('#termBox')).toHaveAttribute('data-cols', '100', { timeout: 10_000 })
    await guest.page.setViewportSize({ width: 1280, height: 900 })
    await guest.page.waitForTimeout(3000)
    expect(await colsOf(guest.page), 'owner 在场时客页必须停主机栅格').toBe('100')

    // 主人关闭终端（WS 断开）→ 客页改视口（显式重新让渡）→ 反喂恢复
    await page.evaluate(() => {
      (window as unknown as { __e2eOwnerWs?: WebSocket }).__e2eOwnerWs?.close()
    })
    await guest.page.waitForTimeout(600)
    await guest.page.setViewportSize({ width: 1600, height: 1000 })
    await expect.poll(() => colsOf(guest.page).then(v => parseInt(v || '0', 10)), {
      timeout: 15_000, intervals: [500],
    }).toBeGreaterThanOrEqual(150)
    const hello2 = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(hello2.cols).toBe(parseInt(await colsOf(guest.page), 10))
    await guest.ctx.close()
  })

  test('窄屏不反喂 + guest 路径 <80 钳到 80 + owner PUT 20 不受影响', async ({ request, browser }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createWritableShare(request, headers, 'narrow')

    // 390 视口：目标 <80 列 → 不反喂（直接渲染主机栅格），主机 PTY 原样 80×24
    const guest = await openGuestPage(browser, shareBase, token, { width: 390, height: 844 })
    await expect.poll(() => colsOf(guest.page), { timeout: 15_000 }).not.toBe('')
    expect(await targetColsOf(guest.page)).toBeLessThan(80)
    await guest.page.waitForTimeout(4000)
    expect(await colsOf(guest.page), '窄屏必须保持主机栅格').toBe('80')
    const hello = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(hello.cols).toBe(80)
    expect(hello.rows).toBe(24)

    // 服务端 guest 路径钳制：直连 WS 报 40 列 → 应用值 80（主人的 20 下限不动）
    const frames = await sendControlFrames(guest.page, token, [JSON.stringify({ type: 'resize', cols: 40, rows: 10 })], 2)
    const applied = frames.map(f => { try { return JSON.parse(f) as { type?: string; cols?: number; rows?: number } } catch { return {} } })
      .find(f => f.type === 'resize_applied')
    expect(applied, `frames: ${frames.join(' | ')}`).toBeTruthy()
    expect(applied?.cols).toBe(80)
    expect(applied?.rows).toBe(10)

    // 主人侧 PUT 20 列照旧生效（Session.Resize 全局下限未被 guest 钳制波及）
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 24, cols: 20 },
    })).ok()).toBeTruthy()
    const helloOwner = await readHello(guest.page, `${shareBase}/s/${token}/stream`)
    expect(helloOwner.cols).toBe(20)
    expect(helloOwner.rows).toBe(24)
    await guest.ctx.close()
  })
})
