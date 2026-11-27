import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享终端历史可达（P-20261124-3 S2）E2E：
 * 用户 2026-11-24 复报「分享的终端可以查看的历史非常少」——P-20261123-2 的单面化
 * 取舍把 overset 态滚动面收敛到外层 `.term-box`（只滚主机当前整格超集），xterm 自身
 * scrollback 在该态不可达。S2 两层修复在本 spec 的覆盖：
 *   1. 缺省 auto fit（S2 ①）：装不下整格且 fit 字号 ≥SC_TERM_FIT_MIN=12 时自动完整
 *      显示、overset 消失，xterm scrollback 天然可达——由 share-terminal-fit 首例覆盖。
 *   2. 历史模式兜底（S2 ②，本 spec 主例）：宽矮视口（2000×560 + 主机 120×60）fit
 *      不可行（60 行 × 12px 格高 ≈900px > 终端区），overset 外层滚到顶后继续上滚 →
 *      滚动面临时交还 xterm scrollback（term.scrollLines，inner viewportY 后退），
 *      页内「回到实时」浮层出现；滚回 inner 底 / 点按钮均退出并恢复 follow。
 *   3. 负向对照：fits 态（200×15 @2000×560，无 overset）滚轮只走 xterm 内部面，
 *      历史浮层永不出现、外层 scrollTop 恒 0（fits 态零变化）。
 * 说明：alt-screen 是 alternate buffer，xterm 不保留 scrollback（baseY 恒 0），
 * 所以「上翻旧内容」只对 normal buffer 有意义；alt-screen 的宽矮场景由 fit 回退 +
 * 底部锚覆盖（share-terminal-fit）。产品内终端不引用本套件（分享页是服务端单文件
 * 页，web/src 无共享代码），回归面为 terminal-* 既有 spec。
 * `?term=diag` 暴露 window.__scTermDiag（historyMode/ydisp/baseY/writes，无终端内容）。
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const HOST_COLS = 120
const HOST_ROWS = 60
const HIST_MARK = 'hist-000'

interface TermBoxState {
  top: number
  max: number
  sh: number
  ch: number
  overset: boolean
  follow: string
  cols: string
  rows: string
  fs: string
  ydisp: number
  baseY: number
  hasSb: boolean
  historyMode: boolean
  fitMode: string
  fsFit: number
  fsWidth: number
}

interface DiagWrite {
  t: number
  frame: number
  flush: number
  from: number
  to: number
  prog: boolean
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
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

async function createTerminal(
  request: APIRequestContext,
  headers: Record<string, string>,
  projectId: string,
  name: string,
  cols: number,
  rows: number,
): Promise<string> {
  const created = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(created.ok()).toBeTruthy()
  const sessionId = ((await created.json()) as { data?: { id?: string } }).data!.id!
  const rz = await request.put(`${BASE}/api/terminals/${sessionId}/resize`, { headers, data: { cols, rows } })
  expect(rz.ok()).toBeTruthy()
  return sessionId
}

async function writeLines(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  lines: string[],
): Promise<void> {
  const res = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data: lines.map(l => `${l}\r`).join('') },
  })
  expect(res.ok()).toBeTruthy()
}

async function openShare(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
}

/** #termBox 几何/标记 + diag 快照（历史模式唯一观测面：historyMode/ydisp/baseY） */
async function readTermBox(page: Page): Promise<TermBoxState> {
  return page.evaluate(() => {
    const b = document.getElementById('termBox') as HTMLElement
    const diag = (window as unknown as { __scTermDiag?: { snapshot: () => TermBoxState } }).__scTermDiag
    const snap = diag ? diag.snapshot() : null
    return {
      top: Math.round(b.scrollTop),
      max: Math.round(b.scrollHeight - b.clientHeight),
      sh: b.scrollHeight,
      ch: b.clientHeight,
      overset: b.dataset.overset === '1',
      follow: b.dataset.follow || '',
      cols: b.dataset.cols || '',
      rows: b.dataset.rows || '',
      fs: b.dataset.fontSize || '',
      ydisp: snap ? snap.ydisp : -1,
      baseY: snap ? snap.baseY : 0,
      hasSb: snap ? snap.hasSb : false,
      historyMode: snap ? snap.historyMode : false,
      fitMode: snap ? snap.fitMode : '',
      fsFit: snap ? snap.fsFit : 0,
      fsWidth: snap ? snap.fsWidth : 0,
    } as TermBoxState
  })
}

async function readWrites(page: Page): Promise<DiagWrite[]> {
  return page.evaluate(() => {
    const d = (window as unknown as { __scTermDiag?: { writes: DiagWrite[] } }).__scTermDiag
    return d ? d.writes : []
  })
}

async function wheelOverTerm(page: Page, deltaY: number): Promise<void> {
  const bb = await page.locator('#termBox').boundingBox()
  if (!bb) throw new Error('#termBox has no bounding box')
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.wheel(0, deltaY)
}

/** 指定文本所在 xterm 行是否与 #termBox 可视窗相交（历史模式「看得到」的唯一真判据） */
async function rowTextVisible(page: Page, needle: string): Promise<boolean> {
  return page.evaluate((txt) => {
    const box = document.getElementById('termBox')
    if (!box) return false
    const br = box.getBoundingClientRect()
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      if ((row.textContent || '').includes(txt)) {
        const rr = row.getBoundingClientRect()
        return rr.bottom > br.top + 1 && rr.top < br.bottom - 1
      }
    }
    return false
  }, needle)
}

const HIST_BACK = '[data-testid="term-hist-back"]'

test.describe('share-terminal-history', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  let liveSessionId = ''
  test.afterEach(async ({ request }) => {
    if (liveSessionId) {
      const headers = await unlockHeaders(request)
      await request.delete(`${BASE}/api/terminals/${liveSessionId}`, { headers })
      liveSessionId = ''
    }
  })

  test('2000×560 + 120×60 normal：overset 到顶继续上滚交还 xterm scrollback，按钮/回底退出恢复 follow', async ({ page, request }) => {
    test.setTimeout(240_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-hist-src', HOST_COLS, HOST_ROWS)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 560 })
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', String(HOST_COLS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS))

    // auto fit 不可行（60 行 × 12px 格高 ≈900px 远高于 ~370px 终端区）→ 宽度优先
    // + overset（历史模式兜底的前提；负向对照由下一条 fits 用例覆盖）
    await expect(box).toHaveAttribute('data-overset', '1', { timeout: 25_000 })
    await expect.poll(async () => (await readTermBox(page)).fsFit, { timeout: 20_000, intervals: [250] }).toBe(0)
    const boot = await readTermBox(page)
    expect(boot.fitMode).toBe('auto')
    expect(boot.historyMode).toBe(false)
    expect(await page.locator(HIST_BACK).isHidden()).toBe(true)

    // 播种 scrollback：150 行（host 60 行屏 → ~90 行历史），末行作为输出落定锚
    const lines = Array.from({ length: 150 }, (_, i) => `echo hist-${String(i).padStart(3, '0')}`)
    await writeLines(request, headers, sessionId, lines)
    await expect(page.locator('.xterm-rows')).toContainText('hist-149', { timeout: 45_000 })
    // inner 稳定（两读 ydisp 相同且已回到 baseY）再量基线——输出中途的 ydisp 会被
    // 「贴底」推着走，与基线比大小必假红（share-terminal-scroll 同款先例）
    await expect.poll(async () => {
      const a = await readTermBox(page)
      await page.waitForTimeout(500)
      const b = await readTermBox(page)
      return a.hasSb && a.baseY > 20 && a.ydisp === b.ydisp && a.ydisp === a.baseY ? 'settled'
        : `a=${a.ydisp}/${a.baseY} b=${b.ydisp}`
    }, { timeout: 45_000, intervals: [200] }).toBe('settled')
    const seeded = await readTermBox(page)
    expect(seeded.historyMode).toBe(false)
    expect(seeded.ydisp).toBe(seeded.baseY)

    // ── 外层上滚到顶（follow 清 0，历史模式未进） ──
    // 到 top=0 即停：再多滚一轮会在 wheel 事件里满足「到顶继续上滚」而进入历史模式
    for (let i = 0; i < 14; i++) {
      await wheelOverTerm(page, -500)
      await page.waitForTimeout(80)
      if ((await readTermBox(page)).top === 0) break
    }
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.top === 0 && s.follow === '0' ? 'top' : `top=${s.top} follow=${s.follow}`
    }, { timeout: 15_000, intervals: [150] }).toBe('top')
    const atTop = await readTermBox(page)
    expect(atTop.historyMode).toBe(false) // 到顶但未继续上滚：仍是外层单面

    // ── 继续上滚 → 进入历史模式：外层不动、inner ydisp 后退、浮层出现 ──
    await wheelOverTerm(page, -500)
    await expect.poll(async () => (await readTermBox(page)).historyMode, { timeout: 10_000, intervals: [120] }).toBe(true)
    await expect(page.locator(HIST_BACK)).toBeVisible()
    const h0 = await readTermBox(page)
    expect(h0.top).toBe(0)
    expect(h0.follow).toBe('0')
    expect(h0.ydisp).toBeLessThan(seeded.baseY)

    // 继续上滚到 scrollback 顶（viewportY→0），早期历史行进入可视窗
    for (let i = 0; i < 40; i++) {
      const s = await readTermBox(page)
      if (s.ydisp <= 2) break
      await wheelOverTerm(page, -500)
      await page.waitForTimeout(50)
    }
    const deep = await readTermBox(page)
    expect(deep.historyMode).toBe(true)
    expect(deep.ydisp).toBeLessThanOrEqual(2)
    expect(deep.top).toBe(0) // 历史模式外层不参与滚动（单面交还）
    // 历史标记串在可视窗内命中（旧内容真的看得到，非真空断言）
    await expect.poll(async () => (await rowTextVisible(page, HIST_MARK)) ? 'visible' : 'waiting',
      { timeout: 10_000, intervals: [200] }).toBe('visible')
    // 写口审计里无 outer 回拽：历史模式期间 outer scrollTop 恒 0 由上方断言覆盖
    const writes = await readWrites(page)
    expect(writes.length).toBeGreaterThan(0)

    // ── 按钮退出：「回到实时」= inner 回底 + follow 恢复 + 浮层收起 ──
    await page.locator(HIST_BACK).click()
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return !s.historyMode && s.follow === '1' ? 'live' : `hist=${s.historyMode} follow=${s.follow}`
    }, { timeout: 15_000, intervals: [150] }).toBe('live')
    await expect(page.locator(HIST_BACK)).toBeHidden()
    await page.waitForTimeout(400)
    const backLive = await readTermBox(page)
    expect(backLive.ydisp).toBeGreaterThanOrEqual(backLive.baseY - 1) // inner 已回底
    expect(backLive.top).toBeGreaterThan(0) // force 定位（normal 光标行锚，非 0）
    expect(await rowTextVisible(page, 'hist-149')).toBe(true)

    // ── 再进一次：滚回 inner 底即退出（不点按钮） ──
    for (let i = 0; i < 14; i++) { await wheelOverTerm(page, -500); await page.waitForTimeout(60) }
    await expect.poll(async () => (await readTermBox(page)).historyMode, { timeout: 15_000, intervals: [150] }).toBe(true)
    for (let i = 0; i < 40; i++) {
      const s = await readTermBox(page)
      if (!s.historyMode) break
      await wheelOverTerm(page, 500)
      await page.waitForTimeout(50)
    }
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return !s.historyMode && s.follow === '1' ? 'live' : `hist=${s.historyMode} follow=${s.follow}`
    }, { timeout: 15_000, intervals: [150] }).toBe('live')
    await expect(page.locator(HIST_BACK)).toBeHidden()
  })

  test('60 次 wheel 往返：outer scrollTop 采样无反向跳变 >1px（每帧单写口）', async ({ page, request }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-hist-jitter', HOST_COLS, HOST_ROWS)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 560 })
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-overset', '1', { timeout: 25_000 })
    // 播种少量输出让 follow 有推动面（尾部与 follow 写入面都活）
    await writeLines(request, headers, sessionId, ['echo jitter-0', 'echo jitter-1'])
    await expect(page.locator('.xterm-rows')).toContainText('jitter-1', { timeout: 20_000 })
    await page.waitForTimeout(600)

    let prev = (await readTermBox(page)).top
    let moved = 0
    for (let i = 0; i < 60; i++) {
      const up = i % 2 === 0
      await wheelOverTerm(page, up ? -320 : 320)
      await page.waitForTimeout(60) // rAF 写口 + scroll 事件落定
      const s = await readTermBox(page)
      if (up) expect(s.top, `up #${i}: ${prev} -> ${s.top}`).toBeLessThanOrEqual(prev + 1)
      else expect(s.top, `down #${i}: ${prev} -> ${s.top}`).toBeGreaterThanOrEqual(prev - 1)
      if (s.top !== prev) moved++
      prev = s.top
    }
    expect(moved).toBeGreaterThan(4) // 非真空：确实发生过滚动

    // 写口审计：不存在同帧二次写（flush 与 rAF frame 一一对应）
    const writes = await readWrites(page)
    expect(writes.length).toBeGreaterThan(0)
    const frames = writes.map(w => w.frame).filter(f => f > 0)
    const dup = frames.filter((f, i) => i > 0 && f === frames[i - 1])
    expect(dup, `same-frame writes: ${JSON.stringify(writes)}`).toHaveLength(0)
  })

  test('负向对照：fits 态滚轮只走 xterm 内部面，历史浮层不出现、外层 scrollTop 恒 0', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    // 200×15 @2000×560：整格装得进终端区（无 overset），fits 态零变化
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-hist-fits', 200, 15)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 560 })
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', '200', { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', '15')
    await expect(box).not.toHaveAttribute('data-overset', '1')

    // 造 scrollback（50 行 → 15 行屏留 35+ 行历史）后等 inner 稳定
    await writeLines(request, headers, sessionId, Array.from({ length: 50 }, (_, i) => `echo fits-${i}`))
    await expect.poll(async () => {
      const a = await readTermBox(page)
      await page.waitForTimeout(500)
      const b = await readTermBox(page)
      return a.hasSb && a.ydisp > 0 && a.ydisp === b.ydisp ? 'settled' : `a=${a.ydisp}/${a.hasSb} b=${b.ydisp}`
    }, { timeout: 45_000, intervals: [200] }).toBe('settled')
    const before = await readTermBox(page)
    expect(before.overset).toBe(false)
    expect(before.top).toBe(0)
    expect(before.max).toBe(0)

    // 滚轮上滚：外层纹丝不动、inner ydisp 后退（xterm 内部面是唯一活面）
    await wheelOverTerm(page, -400)
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.ydisp < before.ydisp ? 'inner' : `ydisp=${s.ydisp} base=${before.ydisp}`
    }, { timeout: 10_000, intervals: [150] }).toBe('inner')
    const after = await readTermBox(page)
    expect(after.top).toBe(0)
    expect(after.max).toBe(0)
    expect(after.historyMode).toBe(false)
    // 浮层元素在直播页恒在场（hidden 显式收起）；fits 态永不出现（零变化）
    await expect(page.locator(HIST_BACK)).toBeHidden()
  })
})
