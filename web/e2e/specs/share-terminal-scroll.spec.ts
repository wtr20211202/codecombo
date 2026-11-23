import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享终端滚动单面化 + follow（P-20261123-2）E2E：
 * 用户实测主诉「还是会有闪烁……终端会话管理里的终端滚动时不闪烁，分享要闪烁」——
 * 产品内终端只有一个滚动面（FitAddon 把栅格 fit 到 pane，滚动唯一面是 xterm 内部
 * SmoothScrollableElement），分享页 overset 态却有第二面：主机栅格高于访客终端区时
 * `.term-box{overflow:auto}` 形成外层超集面，加上 P-20261119-2 的每写钉底/光标重锚，
 * 滚轮与输出互相竞争把视口拽来拽去。P-9/19-2 的放行式路由是假放行（实测：wheel 后
 * outer scrollTop 恒不变）——事件仍被内层光滑滚动件消费。收口后契约：
 *   1. overset 态：捕获相 scWheelCapture 接管滚轮驱动外层唯一面（defaultPrevented=
 *      true、inner ydisp 不动、800ms 无 >2px 回拽）；上滚后新输出不拽回；滚回底
 *      follow 恢复且新输出保持 maxTop；首载停在光标行（不是格底）并保持稳定
 *   2. 合成 deltaMode（line×字高 / page×视口高）归一、纯 deltaX 与 shift+wheel 忽略
 *      （无横向面）、ctrl+wheel 只拦内层不 preventDefault（浏览器缩放照常）
 *   3. fits 态（栅格==视口）：外层 scrollTop 恒 0，滚轮落到 xterm 内部面（diag 读
 *      inner ydisp 变化）——两态各只有一个活滚动面，正是「与产品内终端一致」的判据
 * `?term=diag` 暴露 window.__scTermDiag（≤50 条环形，无终端内容），e2e 用它读 inner
 * ydisp 证明单面；overset 判据依赖 header/banner 高度，一律按 data-overset 属性推进
 * （120×60@1280×720 实测稳定 overset），不硬钉几何。子服务端口经 /api/share/status
 * 动态获取（默认主端口+2）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

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
  hasSb: boolean
}

interface DiagSnapshot {
  top: number
  sh: number
  ch: number
  follow: boolean
  overset: boolean
  ydisp: number
  hasSb: boolean
  cols: number
  rows: number
  fs: number
}

interface DiagEntry extends DiagSnapshot {
  t: number
  kind: string
  dy?: number
  norm?: number
  mode?: number
  handled?: boolean
  own?: boolean
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
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

/** 建终端并预 resize 钉住主机栅格（hello 帧携 cols/rows → 访客页走 scFitGrid 栅格路径） */
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
  const rz = await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
    headers, data: { cols, rows },
  })
  expect(rz.ok()).toBeTruthy()
  return sessionId
}

/** 向终端敲命令（\r 结尾 = 回车；echo 在两平台 shell 同义，勿写平台专属循环） */
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

async function openShareTerminal(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
}

/** #termBox 几何/标记 + diag 即时快照（inner ydisp 是否被消费的唯一观测面） */
async function readTermBox(page: Page): Promise<TermBoxState> {
  return page.evaluate(() => {
    const b = document.getElementById('termBox') as HTMLElement
    const diag = (window as unknown as {
      __scTermDiag?: { snapshot: () => DiagSnapshot }
    }).__scTermDiag
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
      hasSb: snap ? snap.hasSb : false,
    } as TermBoxState
  })
}

async function readDiagEntries(page: Page): Promise<DiagEntry[]> {
  return page.evaluate(() => {
    const d = (window as unknown as { __scTermDiag?: { entries: DiagEntry[] } }).__scTermDiag
    return d ? d.entries : []
  })
}

/** 真实滚轮：指针挪到终端区中心再滚（overset 态下该轮次应被捕获相接到） */
async function wheelOverTerm(page: Page, deltaY: number): Promise<void> {
  const bb = await page.locator('#termBox').boundingBox()
  if (!bb) throw new Error('#termBox has no bounding box')
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.wheel(0, deltaY)
}

/** 合成 wheel（派发到 .xterm-screen：先经 termBox 捕获相，再冒泡到内层滚动件） */
async function synthWheel(
  page: Page,
  opts: { dy?: number; dx?: number; mode?: number; shift?: boolean; ctrl?: boolean },
): Promise<{ prevented: boolean; top: number }> {
  return page.evaluate(async (o) => {
    const box = document.getElementById('termBox') as HTMLElement
    const target = (box.querySelector('.xterm-screen') as HTMLElement | null) || box
    const ev = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: o.dy || 0,
      deltaX: o.dx || 0,
      deltaMode: o.mode || 0,
      shiftKey: !!o.shift,
      ctrlKey: !!o.ctrl,
    })
    target.dispatchEvent(ev)
    // rAF 合并的 scrollTop 写入要两帧后才落地
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    return { prevented: ev.defaultPrevented, top: Math.round(box.scrollTop) }
  }, opts)
}

/** 程序置位滚动位（合成 deltaMode 用例的起点），等两帧让 scroll 事件落定 */
async function setScrollTop(page: Page, ratio: number): Promise<number> {
  return page.evaluate(async (r) => {
    const b = document.getElementById('termBox') as HTMLElement
    b.scrollTop = Math.round((b.scrollHeight - b.clientHeight) * r)
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res(null))))
    return Math.round(b.scrollTop)
  }, ratio)
}

test.describe('share-terminal-scroll', () => {
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

  test('overset 态：捕获相滚轮驱动外层唯一面，follow 上滚不拽回/滚回底跟住新输出', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-scroll-overset', 120, 60)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    // 120×60 × 1280×720 实测必 overset（主机栅格 ~1336px 高于终端区 ~464px）
    await page.setViewportSize({ width: 1280, height: 720 })
    await openShareTerminal(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', '120', { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', '60')
    await expect(box).toHaveAttribute('data-overset', '1', { timeout: 20_000 })
    // ?term=diag 诊断面在场（无终端内容，仅几何/inner 位置）
    await expect.poll(async () => page.evaluate(() => !!window.hasOwnProperty('__scTermDiag')), { timeout: 10_000 }).toBe(true)

    // ── 首载定位：停在光标行（新鲜提示符在格顶附近），不再钉格底 934→88 跳位 ──
    await page.waitForTimeout(900)
    const s0 = await readTermBox(page)
    expect(s0.overset).toBe(true)
    expect(s0.top).toBeLessThan(s0.max / 2)
    await page.waitForTimeout(800)
    const s1 = await readTermBox(page)
    expect(Math.abs(s1.top - s0.top)).toBeLessThanOrEqual(2)
    expect(s1.follow).toBe('1')

    // ── 输出铺满：follow 态跟到最新输出（停在「光标行刚可见」——格底留白使
    // 静止位比 maxTop 高约一个内边距，不是硬贴 scrollHeight 底） ──
    await writeLines(request, headers, sessionId, Array.from({ length: 80 }, (_, i) => `echo scroll-fill-${i}`))
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.max > 0 && s.top >= s.max - 40 && s.follow === '1' ? 'followed' : `top=${s.top} max=${s.max} follow=${s.follow}`
    }, { timeout: 25_000, intervals: [200] }).toBe('followed')
    // 等最后一条命令的提示符落定（避免滚轮窗口内再有输出推动 inner 缓冲）
    await page.waitForTimeout(700)
    const before = await readTermBox(page)

    // 同节点后注册的捕获相探针：证明本节点已 preventDefault（旧放行式路由为 false）
    await page.evaluate(() => {
      const b = document.getElementById('termBox') as HTMLElement
      const seen: { dp: boolean; dy: number }[] = []
      ;(window as unknown as { __wheelProbe: typeof seen }).__wheelProbe = seen
      b.addEventListener('wheel', (e) => { seen.push({ dp: e.defaultPrevented, dy: e.deltaY }) }, { capture: true })
    })

    // ── 滚轮上滚：外层单调下降、inner ydisp 不动、follow 清 0 ──
    let prev = before.top
    for (let i = 0; i < 2; i++) {
      await wheelOverTerm(page, -600)
      await expect.poll(async () => (await readTermBox(page)).top, { timeout: 10_000 }).toBeLessThanOrEqual(prev)
      prev = (await readTermBox(page)).top
    }
    const up = await readTermBox(page)
    expect(up.top).toBeLessThan(before.top)
    expect(up.follow).toBe('0')
    // 单面实证：内层 xterm 位置未被消费（旧实现 wheel 被 SmoothScrollableElement 吃掉
    // → ydisp 后退）；新输出只会让 ydisp 前进，故用「不后退」判据
    expect(up.ydisp).toBeGreaterThanOrEqual(before.ydisp)
    const probe = await page.evaluate(() => (window as unknown as { __wheelProbe: { dp: boolean; dy: number }[] }).__wheelProbe)
    expect(probe.length).toBeGreaterThan(0)
    expect(probe.every(p => p.dp)).toBe(true)
    expect(probe.every(p => p.dy < 0)).toBe(true)

    // ── 800ms 无回拽（每写钉底/ResizeObserver 空转不再动滚动位） ──
    await page.waitForTimeout(800)
    const calm = await readTermBox(page)
    expect(Math.abs(calm.top - up.top)).toBeLessThanOrEqual(2)

    // ── 上滚后新输出：scrollTop 不跟随（用户阅读位置优先） ──
    await writeLines(request, headers, sessionId, ['echo scroll-after-upscroll'])
    await expect(page.locator('.xterm-rows')).toContainText('scroll-after-upscroll', { timeout: 20_000 })
    await page.waitForTimeout(500)
    const unpinned = await readTermBox(page)
    expect(Math.abs(unpinned.top - calm.top)).toBeLessThanOrEqual(2)
    expect(unpinned.follow).toBe('0')

    // ── 滚回底：follow 恢复 + 新输出保持 maxTop（不跳光标锚） ──
    for (let i = 0; i < 3; i++) {
      await wheelOverTerm(page, 600)
      await page.waitForTimeout(120)
    }
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.follow === '1' && s.top >= s.max - 2 ? 'bottom' : `top=${s.top} max=${s.max} follow=${s.follow}`
    }, { timeout: 10_000, intervals: [200] }).toBe('bottom')
    await writeLines(request, headers, sessionId, ['echo scroll-at-bottom'])
    await expect(page.locator('.xterm-rows')).toContainText('scroll-at-bottom', { timeout: 20_000 })
    await page.waitForTimeout(500)
    const followed = await readTermBox(page)
    expect(followed.follow).toBe('1')
    expect(followed.top).toBeGreaterThanOrEqual(followed.max - 2)

    // ── 合成 deltaMode 归一 / 修饰键语义（无横向面） ──
    const mid = await setScrollTop(page, 0.5)
    expect(mid).toBeGreaterThan(0)
    const line = await synthWheel(page, { dy: -3, mode: 1 })
    expect(line.prevented).toBe(true)
    expect(line.top).toBeLessThan(mid)
    const afterLine = await readDiagEntries(page)
    const lineEntry = [...afterLine].reverse().find(e => e.kind === 'wheel' && e.mode === 1)
    expect(lineEntry).toBeTruthy()
    // line 归一 = 3×字高（原始值仅 3px，归一后数十像素量级）
    expect(Math.abs(lineEntry!.norm || 0)).toBeGreaterThan(20)

    const mid2 = await setScrollTop(page, 0.5)
    const pageWheel = await synthWheel(page, { dy: -1, mode: 2 })
    expect(pageWheel.prevented).toBe(true)
    expect(pageWheel.top).toBeLessThan(mid2)
    const pageEntries = await readDiagEntries(page)
    const pageEntry = [...pageEntries].reverse().find(e => e.kind === 'wheel' && e.mode === 2)
    expect(pageEntry).toBeTruthy()
    // page 归一 = 1×视口高（clientHeight 量级）
    expect(Math.abs(Math.abs(pageEntry!.norm || 0) - pageEntry!.ch)).toBeLessThanOrEqual(4)

    const horizontal = await synthWheel(page, { dx: -120 })
    expect(horizontal.prevented).toBe(false)
    expect(horizontal.top).toBe(pageWheel.top)

    const shifted = await synthWheel(page, { dy: -240, shift: true })
    expect(shifted.prevented).toBe(false)
    expect(shifted.top).toBe(pageWheel.top)

    const ctrl = await synthWheel(page, { dy: -240, ctrl: true })
    expect(ctrl.prevented).toBe(false) // 浏览器缩放照常（只拦内层）
    expect(ctrl.top).toBe(pageWheel.top)

    // ── 诊断环形：滚动一次后条目含 overset/follow/ydisp 字段 ──
    const entries = await readDiagEntries(page)
    expect(entries.length).toBeGreaterThan(0)
    const lastWheel = [...entries].reverse().find(e => e.kind === 'wheel')
    expect(lastWheel).toBeTruthy()
    expect(lastWheel!.overset).toBe(true)
    expect(typeof lastWheel!.follow).toBe('boolean')
    expect(typeof lastWheel!.ydisp).toBe('number')
    expect(lastWheel!.cols).toBe(120)
    expect(lastWheel!.rows).toBe(60)
    expect(lastWheel!.fs).toBeGreaterThan(0)
  })

  test('fits 态：外层 scrollTop 恒 0，滚轮只落到 xterm 内部面（diag ydisp 变化）', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    // 200×24 @1920×1080：宽够、矮 —— 整格装得进容器，外层无超集面
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-scroll-fits', 200, 24)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 1920, height: 1080 })
    await openShareTerminal(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', '200', { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', '24')

    // 造 scrollback（60 行 → 24 行屏仍留 36 行历史，够滚且回放快）
    await writeLines(request, headers, sessionId, Array.from({ length: 60 }, (_, i) => `echo fit-line-${i}`))
    // 等输出落定再量基线：主机侧 shell 逐条执行命令是毫秒~百毫秒级，滚轮若在输出
    // 中途发出，inner ydisp 会被「继续输出 → 贴底」推着走（实测 <1s 内 49→177→220），
    // 与 before 比大小必假红——两读相等才算稳定
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

    // 滚轮上滚：外层纹丝不动，内层 ydisp 后退（xterm 内部面是唯一活面）
    await wheelOverTerm(page, -400)
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.ydisp < before.ydisp ? 'inner-scrolled' : `ydisp=${s.ydisp} outer=${s.top} base=${before.ydisp}`
    }, { timeout: 10_000, intervals: [150] }).toBe('inner-scrolled')
    const after = await readTermBox(page)
    expect(after.top).toBe(0)
    expect(after.max).toBe(0)

    // 诊断面记录 fits 态 wheel 落到内部面（wheel-inner）
    const entries = await readDiagEntries(page)
    expect(entries.some(e => e.kind === 'wheel-inner')).toBe(true)
  })
})
