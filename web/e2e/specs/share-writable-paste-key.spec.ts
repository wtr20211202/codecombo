import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享页聚焦态 Ctrl/Cmd+V 放行（P-20261123-3）E2E——用户实测主诉「获得输入权、
 * 点击终端后 Ctrl+V 还是没反应」：根因不是权限/上传链，而是分享页从未调用
 * attachCustomKeyEventHandler。vendored xterm 的 _keyDown 仅当 custom handler
 * 返回 false 时提前放行，否则 Ctrl+V 经 evaluateKeyboardEvent 生成 \x16 触发
 * 数据事件并 cancel(e,true)（preventDefault+stopPropagation）——浏览器原生
 * paste 事件根本不派发，window 捕获相的粘贴链收不到事件。四条验收：
 *   1. open 可写页聚焦 .xterm-helper-textarea：真实 Control+V 的 keydown 能到达
 *      window **冒泡相**（修前 xterm 在 textarea 捕获相 stopPropagation，冒泡收
 *      不到）；同一 Ctrl+V 的合成事件 defaultPrevented=false；聚焦态合成文件
 *      paste 仍走上传链（上传 200 + 路径入 PTY）。
 *   2. 只读双关页（无 handler）负向对照：同一合成 keydown defaultPrevented=true。
 *      合成事件必须带 keyCode:86——evaluateKeyboardEvent 按 keyCode 分派，缺它
 *      不产生 \x16 也不 cancel，修前修后都 false（真空通过）。
 *   3. 惰性挂载（guestInput off→on）：handler 免刷新生效（页面不 reload）。
 *   4. hold 未持权：handler 已安装（readOnly helper textarea 在 Chromium 仍派发
 *      paste），P-20261123-1 的闸门提示照常兜底（互操作）。
 * 真实剪贴板原生粘贴是否派发依赖浏览器环境（P-20261122-18 用例保留环境 skip 兜底；
 * P-20261123-3 后本机 headless/headed Chromium 实测均通过——旧 skip 的直接成因正是
 * 聚焦键被 xterm 吞掉）。本 spec 只钉「键事件不再被 xterm 吞掉」这一确定性面，不把
 * 环境差异伪装成通过。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'wr-e2e-pass-1'

interface KeyBubble {
  key: string
  code: string
  keyCode: number
  mod: boolean
  prevented: boolean
}

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

async function createTerminalShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
): Promise<{ token: string; sessionId: string }> {
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-pk-${tag}-${Date.now()}`, kind: 'shell' },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const sessionId = ((await res.json()) as { data?: { id?: string } }).data?.id
  expect(sessionId).toBeTruthy()
  const share = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
  expect(share.ok(), await share.text()).toBeTruthy()
  const token = ((await share.json()) as { data?: { token: string } }).data?.token
  expect(token).toBeTruthy()
  return { token: token!, sessionId: sessionId! }
}

/** owner 开开放直入（三闸：confirm+口令） */
async function openWritable(request: APIRequestContext, headers: Record<string, string>, token: string) {
  const res = await request.post(`${BASE}/api/share/${token}/writable`, {
    headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
}

/** 轮询 owner 侧 scrollback 直至出现 marker（注入是异步流，不整页忙等） */
async function waitScrollback(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  marker: string,
  withinMs = 15_000,
): Promise<string> {
  const deadline = Date.now() + withinMs
  let text = ''
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok()) {
      text = await res.text()
      if (text.includes(marker)) return text
    }
    await new Promise(r => setTimeout(r, 300))
  }
  return text
}

/** window **冒泡相** keydown 监听（修前 xterm 在 textarea 捕获相 stopPropagation：
 *  聚焦终端的 Ctrl+V 到不了这里；修后 handler 返回 false，事件继续冒泡） */
async function installBubbleWatcher(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __scKeyBubble?: KeyBubble[] }
    w.__scKeyBubble = []
    window.addEventListener('keydown', (e) => {
      w.__scKeyBubble!.push({
        key: e.key, code: e.code, keyCode: e.keyCode,
        mod: e.ctrlKey || e.metaKey, prevented: e.defaultPrevented,
      })
    }, false) // 第三参 false/缺省 = 冒泡相（捕获相在修前也能收到，测不出问题）
  })
}

async function bubbleEvents(page: Page): Promise<KeyBubble[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __scKeyBubble?: KeyBubble[] }
    return w.__scKeyBubble || []
  })
}

/** 聚焦 helper textarea 并派发同形 Ctrl+V 合成 keydown，返回 defaultPrevented。
 *  keyCode:86 必带：evaluateKeyboardEvent 按 keyCode 分派，缺它不产生数据事件也
 *  不 cancel——修前修后都是 false，断言会真空通过（P-20261123-3 评审必改1）。 */
async function syntheticCtrlV(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const ta = document.querySelector('.xterm-helper-textarea') as HTMLElement | null
    if (!ta) throw new Error('xterm helper textarea missing')
    ta.focus()
    const ev = new KeyboardEvent('keydown', {
      key: 'v', code: 'KeyV', keyCode: 86, ctrlKey: true, bubbles: true, cancelable: true,
    })
    ta.dispatchEvent(ev)
    return ev.defaultPrevented
  })
}

/** 聚焦终端的合成文件 paste（P-20261122-18/23 既有形态） */
async function dispatchFilePaste(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new TextEncoder().encode('e2e-pkey-body')], 'e2e-pkey.txt', { type: 'text/plain' }))
    const ta = document.querySelector('.xterm-helper-textarea')
    if (!ta) throw new Error('xterm helper textarea missing')
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

async function focusTerminal(page: Page): Promise<void> {
  await page.locator('.xterm-screen').click()
  await expect.poll(async () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el && el.classList.contains('xterm-helper-textarea')
  }), { timeout: 5_000, message: 'terminal helper textarea must own focus' }).toBe(true)
}

test.describe('share-writable-paste-key', () => {
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

  test('open 可写页：聚焦后真实 Ctrl+V 冒泡到 window + 合成键不吞 + 聚焦态文件粘贴仍上传', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'open')
    createdSessions.push(sessionId)
    await openWritable(request, headers, token)

    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })
    await installBubbleWatcher(page)
    await focusTerminal(page)

    // 真实按键（Playwright 走 CDP 真键盘事件）：修前 xterm 在 textarea 捕获相
    // stopPropagation，冒泡相监听收不到该 keydown；修后 handler 放行即冒泡
    await page.keyboard.press('Control+V')
    await expect.poll(async () => (await bubbleEvents(page)).some(k => k.code === 'KeyV'), {
      timeout: 5_000, message: 'focused Ctrl+V keydown must reach the window bubble phase',
    }).toBe(true)
    const real = (await bubbleEvents(page)).find(k => k.code === 'KeyV')!
    expect(real.mod, 'Ctrl+V must carry ctrl/meta').toBe(true)
    expect(real.prevented, 'xterm must not preventDefault the passthrough Ctrl+V').toBe(false)

    // 合成同形 Ctrl+V（带 keyCode:86）：defaultPrevented=false 即 handler 放行
    expect(await syntheticCtrlV(page), 'custom key handler must let native paste through').toBe(false)

    // 聚焦态文件粘贴链路仍完好：上传落盘 + 路径经 WS 键入 PTY
    const uploads: string[] = []
    page.on('request', (r) => { if (r.url().includes('/paste-upload')) uploads.push(r.url()) })
    await focusTerminal(page)
    await dispatchFilePaste(page)
    const sb = await waitScrollback(request, headers, sessionId, 'sc-paste-')
    expect(sb, 'focused file paste must upload and type the saved path into the PTY').toContain('sc-paste-')
    expect(sb).toContain('.txt')
    expect(uploads.length, 'focused file paste must hit /paste-upload').toBeGreaterThanOrEqual(1)
  })

  test('只读双关页（无 handler）负向对照：同一 Ctrl+V 合成键 defaultPrevented=true 且真实键不冒泡', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'ro')
    createdSessions.push(sessionId)
    // 双关：开放直入缺省关 + 申请通道显式关
    const off = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: false } })
    expect(off.ok(), await off.text()).toBeTruthy()

    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toHaveCount(0)
    await expect(page.getByTestId('wr-actions')).toHaveCount(0)
    await installBubbleWatcher(page)
    await focusTerminal(page)

    // 同一合成事件（keyCode:86）：无 handler 时 xterm 产生 \x16 并 cancel——
    // 这是修前可写页的形态，证明上面的 false 断言不是真空通过
    expect(await syntheticCtrlV(page), 'xterm without a custom handler must preventDefault Ctrl+V').toBe(true)

    // 真实按键同形：修前形态下 keydown 在 textarea 捕获相被 stopPropagation
    await page.keyboard.press('Control+V')
    await page.waitForTimeout(300)
    expect((await bubbleEvents(page)).some(k => k.code === 'KeyV'),
      'readonly page (no handler) must keep swallowing Ctrl+V before the bubble phase').toBe(false)
  })

  test('惰性挂载（guestInput off→on）：handler 免刷新生效', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'lazy')
    createdSessions.push(sessionId)
    const off = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: false } })
    expect(off.ok(), await off.text()).toBeTruthy()

    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toHaveCount(0)
    // 挂载前无 handler（双关只读页形态）
    expect(await syntheticCtrlV(page), 'unmounted page must not install the handler').toBe(true)
    await page.evaluate(() => { (window as unknown as { __scAlive?: string }).__scAlive = 'yes' })

    const on = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: true } })
    expect(on.ok(), await on.text()).toBeTruthy()
    // 5s state 探测档 + 挂载：8s 吸收 CI 抖动（与 share-writable-lifecycle 同档）
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 8_000 })
    expect(await page.evaluate(() => (window as unknown as { __scAlive?: string }).__scAlive),
      'lazy mount must not reload the page (scrollback/selection preserved)').toBe('yes')

    // 免刷新生效：惰性挂载路径也走同一 mountWritable handler
    expect(await syntheticCtrlV(page), 'lazily mounted page must install the handler without reload').toBe(false)
  })

  test('hold 未持权：handler 已安装 + P-20261123-1 闸门提示兜底（只可见化不改流向）', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'hold')
    createdSessions.push(sessionId)
    const uploads: string[] = []
    page.on('request', (r) => { if (r.url().includes('/paste-upload')) uploads.push(r.url()) })

    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 10_000 })
    await focusTerminal(page)
    // 无键入资格 = xterm disableStdin（helper textarea readOnly），handler 仍在
    expect(await page.evaluate(() => (document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null)?.readOnly)).toBe(true)
    expect(await syntheticCtrlV(page), 'handler must be installed even before the visitor holds input').toBe(false)

    // 放行后原生 paste 可达 window 捕获相 → P-1 闸门提示按原因兜底（不发起上传）
    await dispatchFilePaste(page)
    await expect(page.getByTestId('pu-tip')).toContainText(/先申请输入权限|Request input access first/, { timeout: 5_000 })
    await page.waitForTimeout(500)
    expect(uploads, 'no permission must not trigger /paste-upload').toHaveLength(0)
  })
})
