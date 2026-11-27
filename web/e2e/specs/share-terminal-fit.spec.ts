import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享终端宽矮视口完整适配 + alt-screen 锚定（P-20261123-4）E2E：
 * 用户实测主诉「beta.10 分享终端没法看、内容显示不全」（UU 远程常见宽而矮视口）。
 * 两个机制面：
 *   1. follow 首载误清回归（①）：scFitGrid 首载多次收敛字号（22.5→22.75→26.25）
 *      触发的浏览器原生 scroll 曾被判成用户滚动 → follow=false → 首屏永停中间、
 *      底部截断。修复=几何抑制窗（geomTs 400ms）+ 非 own scroll 双向 truth table。
 *   2. 宽矮视口完整适配（②④）：宽度优先放大在 120×40 主机上把字号放到 ~26px，
 *      1000 高只露 ~20 行、500 高只露 ~6 行；alt-screen（全屏 TUI）默认底部锚让
 *      状态/输入行可见，?fit=window / 页头「完整显示」按钮可选缩小字号看全 40 行。
 *      P-20261124-3 起缺省档为 auto：装不下整格且 fit 字号 ≥12 时自动完整显示
 *      （overset 消失、xterm scrollback 天然可达），不可行时回退宽度优先；本 spec
 *      首例先断 auto 缺省，再以 ?fit=width 显式覆盖原 overset/alt-screen 面。
 *   3. alt-screen 时机（③）：进入/退出 alternate buffer 不自动重排——onBufferChange
 *      重排 + force 重新锚定；tail 128KB 截头使访客 buffer 停在 normal 时由
 *      fit=window 强制底部锚（不单押 altScreen 探测）。
 * 真实 alt-screen fixture：Windows PowerShell `[char]27 + [Console]::Out.Write`，
 * Linux bash `printf '\033[?1049h...'`（不 skip）；120×40 栅格与提案现场探针同形。
 * `?term=diag` 暴露 window.__scTermDiag（altScreen/fsWidth/fsFit/fitMode/geomTs/
 * userGesture/visibleRows + 既有滚动字段，无终端内容）。
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const HOST_COLS = 120
const HOST_ROWS = 40
const IS_WIN = process.platform === 'win32'

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
  altScreen: boolean
  fsWidth: number
  fsFit: number
  fitMode: string
  geomTs: number
  userGesture: number
  visibleRows: number
}

interface DiagEntry extends TermBoxState {
  t: number
  kind: string
  dy?: number
  norm?: number
  mode?: number
  handled?: boolean
  own?: boolean
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

/** 建终端 + 预 resize 钉住主机栅格（hello 帧携 cols/rows → 访客走 scFitGrid 栅格路径） */
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

/** 原样写字节到 PTY（alt-screen fixture 的 ESC 序列不能走 echo 行；\r 收尾执行） */
async function writeRaw(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  data: string,
): Promise<void> {
  const res = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data },
  })
  expect(res.ok()).toBeTruthy()
}

/** 真实 alt-screen 进入脚本（PowerShell / bash 两形态；写满 39 行 + 第 40 行状态行） */
function enterAltScript(): string {
  if (IS_WIN) {
    // [char]27 组串避免反引号转义；Flush 保证 ConPTY 及时出帧
    return "$e=[char]27; [Console]::Out.Write($e+'[?1049h'+$e+'[2J'); " +
      '1..39 | ForEach-Object { [Console]::Out.Write("alt-row-$_" + [char]13 + [char]10) }; ' +
      "[Console]::Out.Write('STATUS-LINE-42'); [Console]::Out.Flush()\r"
  }
  return "printf '\\033[?1049h\\033[2J'; i=1; while [ $i -le 39 ]; do printf 'alt-row-%s\\r\\n' \"$i\"; i=$((i+1)); done; " +
    "printf 'STATUS-LINE-42'\r"
}

function exitAltScript(): string {
  if (IS_WIN) {
    return "$e=[char]27; [Console]::Out.Write($e+'[?1049l'); [Console]::Out.Flush()\r"
  }
  return "printf '\\033[?1049l'\r"
}

async function openShare(page: Page, url: string): Promise<void> {
  await page.goto(url)
  await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
}

/** #termBox 几何/标记 + diag 即时快照（altScreen/fs 等新字段的唯一观测面） */
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
      hasSb: snap ? snap.hasSb : false,
      altScreen: snap ? snap.altScreen : false,
      fsWidth: snap ? snap.fsWidth : 0,
      fsFit: snap ? snap.fsFit : 0,
      fitMode: snap ? snap.fitMode : '',
      geomTs: snap ? snap.geomTs : 0,
      userGesture: snap ? snap.userGesture : 0,
      visibleRows: snap ? snap.visibleRows : 0,
    } as TermBoxState
  })
}

async function readDiagEntries(page: Page): Promise<DiagEntry[]> {
  return page.evaluate(() => {
    const d = (window as unknown as { __scTermDiag?: { entries: DiagEntry[] } }).__scTermDiag
    return d ? d.entries : []
  })
}

/** 等字号稳定（两读相同）——首载多轮收敛在修复后应一次到位，这里仍给观测链时间 */
async function waitFontStable(page: Page): Promise<void> {
  const box = page.locator('#termBox')
  await expect.poll(async () => {
    const a = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
    await page.waitForTimeout(400)
    const b = await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '')
    return a !== '' && a === b ? 'stable' : 'moving'
  }, { timeout: 25_000, intervals: [400] }).toBe('stable')
}

async function wheelOverTerm(page: Page, deltaY: number): Promise<void> {
  const bb = await page.locator('#termBox').boundingBox()
  if (!bb) throw new Error('#termBox has no bounding box')
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2)
  await page.mouse.wheel(0, deltaY)
}

/** 指定文本所在 xterm 行是否与终端可视窗相交（底部状态行可见性的唯一真判据） */
async function rowTextVisible(page: Page, needle: string): Promise<boolean | null> {
  return page.evaluate((txt) => {
    const box = document.getElementById('termBox')
    if (!box) return null
    const br = box.getBoundingClientRect()
    for (const row of document.querySelectorAll('.xterm-rows > div')) {
      if ((row.textContent || '').includes(txt)) {
        const rr = row.getBoundingClientRect()
        return rr.bottom > br.top + 1 && rr.top < br.bottom - 1
      }
    }
    return null
  }, needle)
}

test.describe('share-terminal-fit', () => {
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

  test('2000×1000 + 120×40：缺省 auto 自动完整适配（P-20261124-3）；?fit=width 回宽度优先后 alt-screen 底部锚/上滚跟手/回底恢复', async ({ page, request }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-fit-alt', HOST_COLS, HOST_ROWS)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 1000 })
    // ①缺省（无 ?fit）＝auto 档（P-20261124-3 S2 ①）：整格装不下且 fit 字号
    // 可达 12px → 自动缩字号完整显示，overset 消失、xterm scrollback 天然可达
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', String(HOST_COLS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS))
    await waitFontStable(page)
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return !s.overset && s.sh <= s.ch + 1 ? 'fits' : `overset=${s.overset} sh=${s.sh} ch=${s.ch} fs=${s.fs}`
    }, { timeout: 25_000, intervals: [300] }).toBe('fits')
    const auto = await readTermBox(page)
    expect(auto.fitMode).toBe('auto')
    expect(auto.fsFit).toBeGreaterThan(0)  // auto 实际缩了字号（非真空）
    expect(auto.fsWidth).toBeGreaterThan(auto.fsFit)
    expect(auto.follow).toBe('1')
    expect(auto.top).toBe(0)
    expect(parseFloat(auto.fs)).toBeGreaterThanOrEqual(12)
    expect(auto.visibleRows).toBeGreaterThanOrEqual(HOST_ROWS)

    // ②显式宽度优先（?fit=width）：保留原 overset/alt-screen 锚定覆盖面——
    // follow 首载不被字号收敛的几何 scroll 误清（beta.10 回归）；normal buffer
    // 锚光标行（不是格底）——底部锚只属于 alt-screen/fit
    await openShare(page, `${shareBase}/s/${token}?fit=width&term=diag`)
    await expect(box).toHaveAttribute('data-cols', String(HOST_COLS), { timeout: 20_000 })
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS))
    await waitFontStable(page)
    const stable = await readTermBox(page)
    expect(stable.fitMode).toBe('width')
    expect(stable.follow).toBe('1')
    expect(stable.overset).toBe(true)
    expect(stable.top).toBeLessThanOrEqual(stable.max)
    // 非真空三证（旧实现无这些字段/条目，负向对照实跑红）：①geomTs 已有几何事件
    // ②首载零用户手势（follow=1 只能来自未被误判）③几何触发的原生 scroll 被
    // 抑制窗接住（scroll-geomts），且没有任何 own=false 的 scroll 清过 follow
    expect(stable.geomTs).toBeGreaterThan(0)
    expect(stable.userGesture).toBe(0)
    expect(stable.visibleRows).toBeGreaterThan(0)
    await expect.poll(async () => {
      const es = await readDiagEntries(page)
      return es.some(e => e.kind === 'scroll-geomts') ? 'suppressed' : 'waiting'
    }, { timeout: 5_000, intervals: [200] }).toBe('suppressed')
    const entries0 = await readDiagEntries(page)
    expect(entries0.every(e => !(e.kind === 'scroll' && e.own === false))).toBe(true)

    // 进入 alt-screen：onBufferChange 重排 + 底部锚（状态/输入行在第 40 行）
    await writeRaw(request, headers, sessionId, enterAltScript())
    await expect.poll(async () => (await readTermBox(page)).altScreen, { timeout: 20_000, intervals: [200] }).toBe(true)
    await page.waitForTimeout(400)
    const alt = await readTermBox(page)
    expect(alt.overset).toBe(true)
    expect(alt.follow).toBe('1')
    expect(alt.top).toBeGreaterThanOrEqual(alt.max - 2) // 底部锚 maxTop
    expect(alt.visibleRows).toBeGreaterThan(5)
    expect(alt.visibleRows).toBeLessThan(HOST_ROWS)
    expect(await rowTextVisible(page, 'STATUS-LINE-42')).toBe(true)

    // 进入事件有 onBufferChange 记录（altScreen 翻转）
    const entriesIn = await readDiagEntries(page)
    expect(entriesIn.some(e => e.kind === 'buffer' && e.altScreen === true)).toBe(true)

    // 上滚：follow 清 0（用户手势），新输出不拽回
    const beforeUp = await readTermBox(page)
    await wheelOverTerm(page, -600)
    await expect.poll(async () => (await readTermBox(page)).follow, { timeout: 10_000, intervals: [150] }).toBe('0')
    const up = await readTermBox(page)
    expect(up.top).toBeLessThan(beforeUp.top)
    expect(up.userGesture).toBeGreaterThan(0)
    await writeRaw(request, headers, sessionId, 'echo alt-after-up\r')
    await expect(page.locator('.xterm-rows')).toContainText('alt-after-up', { timeout: 20_000 })
    await page.waitForTimeout(500)
    const unpinned = await readTermBox(page)
    expect(Math.abs(unpinned.top - up.top)).toBeLessThanOrEqual(2)
    expect(unpinned.follow).toBe('0')

    // 滚回底：follow 恢复 + 贴 maxTop
    for (let i = 0; i < 3; i++) { await wheelOverTerm(page, 600); await page.waitForTimeout(120) }
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.follow === '1' && s.top >= s.max - 2 ? 'bottom' : `top=${s.top} max=${s.max} follow=${s.follow}`
    }, { timeout: 10_000, intervals: [200] }).toBe('bottom')

    // 退出 alt-screen：再重排一次 + 锚定基准切回 normal（光标行锚）
    await writeRaw(request, headers, sessionId, exitAltScript())
    await expect.poll(async () => (await readTermBox(page)).altScreen, { timeout: 20_000, intervals: [200] }).toBe(false)
    const entriesOut = await readDiagEntries(page)
    expect(entriesOut.some(e => e.kind === 'buffer' && e.altScreen === false)).toBe(true)
  })

  test('2000×1000 + alt-screen + ?fit=window：全 40 行可见无 overset；页头开关切回放大并记忆', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-fit-window', HOST_COLS, HOST_ROWS)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 1000 })
    const url = `${shareBase}/s/${token}?fit=window&term=diag`
    await openShare(page, url)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS), { timeout: 20_000 })
    await writeRaw(request, headers, sessionId, enterAltScript())
    await expect.poll(async () => (await readTermBox(page)).altScreen, { timeout: 20_000, intervals: [200] }).toBe(true)
    await waitFontStable(page)

    // fit=window：字号下调到全 40 行可见（!overset、sh≈ch），且不低于可读下限 12
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return !s.overset && s.sh <= s.ch + 1 ? 'fits' : `overset=${s.overset} sh=${s.sh} ch=${s.ch} fs=${s.fs}`
    }, { timeout: 25_000, intervals: [300] }).toBe('fits')
    const fit = await readTermBox(page)
    expect(fit.fitMode).toBe('window')
    expect(fit.rows).toBe(String(HOST_ROWS))
    expect(fit.visibleRows).toBeGreaterThanOrEqual(HOST_ROWS)
    expect(fit.top).toBe(0)
    expect(parseFloat(fit.fs)).toBeGreaterThanOrEqual(12)
    expect(fit.fsFit).toBeGreaterThan(0)          // fit 实际生效过（非真空）
    expect(fit.fsWidth).toBeGreaterThan(fit.fsFit) // 宽度基线字号更大（缩小才装下）
    expect(await rowTextVisible(page, 'STATUS-LINE-42')).toBe(true)

    // 页头开关：切回宽度优先放大 → overset 回归、字号回到宽度基线
    const toggle = page.locator('[data-testid="term-fit-toggle"]')
    await expect(toggle).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-pressed', 'true')
    await toggle.click()
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return s.overset && s.fitMode === 'width' ? 'width' : `overset=${s.overset} mode=${s.fitMode} fs=${s.fs}`
    }, { timeout: 20_000, intervals: [300] }).toBe('width')
    const zoom = await readTermBox(page)
    expect(parseFloat(zoom.fs)).toBeGreaterThanOrEqual(zoom.fsWidth - 0.25)
    expect(await page.evaluate(() => localStorage.getItem('sc.term.fit'))).toBe('width')

    // 再点回完整显示：localStorage 记住 window，reload（无 ?fit=）仍生效
    await toggle.click()
    await expect.poll(async () => (await readTermBox(page)).fitMode, { timeout: 20_000, intervals: [300] }).toBe('window')
    expect(await page.evaluate(() => localStorage.getItem('sc.term.fit'))).toBe('window')
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    await expect.poll(async () => (await readTermBox(page)).fitMode, { timeout: 25_000, intervals: [300] }).toBe('window')
    await page.evaluate(() => localStorage.removeItem('sc.term.fit'))
  })

  test('2000×500 宽矮视口：默认底部锚；fit=window 回退不降可读下限；矮视口 chrome 压缩且安全警示完整', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-fit-short', HOST_COLS, HOST_ROWS)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 500 })
    await openShare(page, `${shareBase}/s/${token}?term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS), { timeout: 20_000 })
    await writeRaw(request, headers, sessionId, enterAltScript())
    await expect.poll(async () => (await readTermBox(page)).altScreen, { timeout: 20_000, intervals: [200] }).toBe(true)
    await waitFontStable(page)
    await page.waitForTimeout(400)

    // 默认：40 行在 ~370px 终端区装不下 → overset + 底部锚（状态行可见）
    const def = await readTermBox(page)
    expect(def.overset).toBe(true)
    expect(def.follow).toBe('1')
    expect(def.top).toBeGreaterThanOrEqual(def.max - 2)
    expect(def.visibleRows).toBeLessThan(15)
    expect(await rowTextVisible(page, 'STATUS-LINE-42')).toBe(true)

    // 矮视口 chrome 压缩：header padding 收到 5px（1000 高是 9px），banner 只收边距不截断
    const chrome = await page.evaluate(() => {
      const h = getComputedStyle(document.querySelector('.header') as Element)
      const b = document.querySelector('#maskBanner') as HTMLElement
      const bs = getComputedStyle(b)
      return {
        headerPadTop: h.paddingTop,
        bannerPadTop: bs.paddingTop,
        bannerFont: bs.fontSize,
        bannerClipped: b.scrollHeight > b.clientHeight + 1,
        bannerText: (b.textContent || '').trim().length,
      }
    })
    expect(chrome.headerPadTop).toBe('5px')
    expect(chrome.bannerPadTop).toBe('4px')
    expect(chrome.bannerFont).toBe('12px')
    expect(chrome.bannerClipped).toBe(false)
    expect(chrome.bannerText).toBeGreaterThan(10)

    // fit=window：40 行在 500 高装不下（需 <12px）→ 回退宽度字号 + 底部锚，不降到 9px
    await openShare(page, `${shareBase}/s/${token}?fit=window&term=diag`)
    await expect(box).toHaveAttribute('data-rows', String(HOST_ROWS), { timeout: 20_000 })
    await expect.poll(async () => (await readTermBox(page)).altScreen, { timeout: 20_000, intervals: [200] }).toBe(true)
    await waitFontStable(page)
    const fit = await readTermBox(page)
    expect(fit.fitMode).toBe('window')
    expect(parseFloat(fit.fs)).toBeGreaterThanOrEqual(12)
    expect(fit.fsFit).toBe(0) // 未生效（回退），不是缩到 9px
    if (fit.overset) {
      expect(fit.top).toBeGreaterThanOrEqual(fit.max - 2)
      expect(await rowTextVisible(page, 'STATUS-LINE-42')).toBe(true)
    } else {
      expect(fit.sh).toBeLessThanOrEqual(fit.ch + 1)
    }
  })

  test('normal buffer + ?fit=width 保持宽度放大；?fit=window 强制完整适配（tail 截头兜底路径）', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-fit-normal', 80, 24)
    liveSessionId = sessionId
    const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(share.ok()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data!.token!

    await page.setViewportSize({ width: 2000, height: 1000 })
    await openShare(page, `${shareBase}/s/${token}?fit=width&term=diag`)
    const box = page.locator('#termBox')
    await expect(box).toHaveAttribute('data-cols', '80', { timeout: 20_000 })
    await waitFontStable(page)
    const normal = await readTermBox(page)
    expect(normal.altScreen).toBe(false)
    expect(normal.fitMode).toBe('width')
    expect(parseFloat(normal.fs)).toBeGreaterThan(14) // 宽度优先放大保持

    // fit=window：normal buffer 也强制完整适配（若 tail 截头使 altScreen 探测不到，
    // 用户/开关仍能拿到全行可见）——24 行在 1000 高可装下
    await openShare(page, `${shareBase}/s/${token}?fit=window&term=diag`)
    await expect(box).toHaveAttribute('data-cols', '80', { timeout: 20_000 })
    await expect.poll(async () => {
      const s = await readTermBox(page)
      return !s.overset && s.sh <= s.ch + 1 ? 'fits' : `overset=${s.overset} sh=${s.sh} ch=${s.ch} fs=${s.fs}`
    }, { timeout: 25_000, intervals: [300] }).toBe('fits')
    const fit = await readTermBox(page)
    expect(fit.altScreen).toBe(false)
    expect(fit.fitMode).toBe('window')
    expect(fit.visibleRows).toBeGreaterThanOrEqual(24)
    expect(parseFloat(fit.fs)).toBeGreaterThanOrEqual(12)
  })
})
