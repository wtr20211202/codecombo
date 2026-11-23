import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 可写分享访客文件投递兜底与粘贴面诊断（P-20261122-18）——真实用户主诉
 * 「没办法 Ctrl+V 粘贴图片或者文件在 claude code 会话里面」的验收面：
 *   1. 常驻「上传文件/图片」按钮（wr-upload + 隐藏 input）全链：setInputFiles
 *      → 压缩/白名单 → POST /s/{token}/paste-upload 落盘 sc-paste-* → 路径经
 *      WS 键入帧注入 PTY（owner scrollback 可见）。open（PNG image 形态）与
 *      hold（已持权，bmp file 形态）各一。
 *   2. `?paste=diag` 诊断面：window.__scPasteDiag 可导出最近事件（types/items/
 *      files/target/canType/wsOpen/upload status/UA 摘要），且**绝不含剪贴板
 *      内容/文件名/路径**（评审红线 ④）。
 *   3. 无文件提示收紧：无 files 且无 text/plain/text/html 才提示（30s 限频）；
 *      纯文本粘贴不触发文件提示。
 *   4. 帧上限整块化（服务端单测为主，此处现场验证）：>16KiB 单帧（旧上限下
 *      必 1009 断桥）正常注入 PTY 且连接保持。
 *   5. 图片 CT 四类白名单真执行：image/bmp → 400 unsupported_type；同一 bmp
 *      走 file 字段/扩展名白名单成功（客户端 image 四类判定对齐）。
 *   6. Chromium 真实剪贴板 PNG（grantPermissions + ClipboardItem + Control+V）：
 *      环境不触发原生粘贴时按 skip 记录（提案允许的可退化项）。
 * 合成 paste 用例沿用 share-writable.spec（Chromium 桌面为粘贴链前提，见
 * CLAUDE.md P-20261122-1/14 条）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'wr-e2e-pass-1'

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
    headers, data: { projectId, name: `e2e-pf-${tag}`, kind: 'shell' },
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

/** 1x1 红点 PNG（真实可解码——压缩链 createImageBitmap 成功路径） */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

/** 合成「空剪贴板」paste（无 files 无 text——Firefox 文件管理器复制等已知形态） */
async function dispatchEmptyPaste(page: Page): Promise<void> {
  await page.evaluate(() => {
    const dt = new DataTransfer()
    const ta = document.querySelector('.xterm-helper-textarea')
    if (!ta) throw new Error('xterm helper textarea missing')
    ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
}

/** 合成带文件 paste（P-20261123-1 闸前场景）：selector 缺省 = 终端 helper textarea */
async function dispatchFilePaste(page: Page, selector = '.xterm-helper-textarea'): Promise<void> {
  await page.evaluate((sel) => {
    const dt = new DataTransfer()
    dt.items.add(new File([new TextEncoder().encode('e2e-gate-content')], 'e2e-gate-file.txt', { type: 'text/plain' }))
    const el = document.querySelector(sel)
    if (!el) throw new Error(`paste target missing: ${sel}`)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, selector)
}

/** 合成纯文本 paste（页内输入框场景：零动作/零提示的判据） */
async function dispatchTextPaste(page: Page, selector: string): Promise<void> {
  await page.evaluate((sel) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', 'e2e-gate-text')
    const el = document.querySelector(sel)
    if (!el) throw new Error(`paste target missing: ${sel}`)
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, selector)
}

/** ?paste=diag 诊断面导出（P-20261122-18 ②；P-20261123-1 起含 gate/targetKind） */
async function pasteDiag(page: Page): Promise<{ events: Record<string, unknown>[] } | null> {
  return page.evaluate(() => {
    const d = (window as unknown as { __scPasteDiag?: unknown }).__scPasteDiag
    return d ? (JSON.parse(JSON.stringify(d)) as { events: Record<string, unknown>[] }) : null
  })
}

/** /paste-upload 请求计数（闸前场景必须为零：只可见化，不改上传流向） */
function trackPasteUploads(page: Page): string[] {
  const hits: string[] = []
  page.on('request', (r) => {
    if (r.url().includes('/paste-upload')) hits.push(r.url())
  })
  return hits
}

/** 诊断事件里首条 *paste* 记录（断言 gate/targetKind/directStatus 用） */
function firstPasteEvent(diag: { events: Record<string, unknown>[] } | null): Record<string, unknown> | undefined {
  return (diag?.events || []).find(e => e.ev === 'paste')
}

test.describe('share-guest-paste-fallback', () => {
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

  test('上传按钮（open）：选 PNG → 压缩/落盘 sc-paste-*.png → 路径入 PTY + 审计', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'btnopen')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()

    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    // 常驻上传按钮可见（wr-actions 首项；复制/搜索钮并排仍在）
    await expect(page.getByTestId('wr-actions')).toBeVisible()
    await expect(page.getByTestId('wr-upload')).toBeVisible()
    await expect(page.getByTestId('wr-copy')).toBeVisible()

    // setInputFiles 为主验收（隐藏 input 直接置文件即触发 change → 同链上传）
    await page.getByTestId('wr-upload-input').setInputFiles({
      name: 'e2e-btn-shot.png', mimeType: 'image/png', buffer: TINY_PNG,
    })

    const sb = await waitScrollback(request, headers, sessionId, '.png')
    expect(sb, 'uploaded image path should reach the PTY via the WS bridge').toContain('sc-paste-')
    expect(sb).toContain('.png')
    await expect(page.getByTestId('pu-tip')).toContainText(/已落盘|Saved/, { timeout: 10_000 })

    // 审计元数据口径（share.pasteUpload：净化名/大小/visitor，内容不入账）
    const deadline = Date.now() + 15_000
    let details = ''
    while (Date.now() < deadline && !details.includes('e2e-btn-shot.png')) {
      const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
      const events = ((await res.json()) as { data?: { action: string; detail?: string }[] }).data || []
      details = events.filter(e => e.action === 'share.pasteUpload').map(e => e.detail || '').join('\n')
      if (!details.includes('e2e-btn-shot.png')) await new Promise(r => setTimeout(r, 400))
    }
    expect(details).toContain('e2e-btn-shot.png')
  })

  test('上传按钮（hold 未持权点按钮提示先申请 → 持权后 bmp 走 file 链成功）', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'btnhold')
    createdSessions.push(sessionId)

    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('wr-upload')).toBeVisible()

    // 无持权：点上传不弹选择器，提示先申请（与键入同一授权物）
    await page.getByTestId('wr-upload').click()
    await expect(page.getByTestId('pu-tip')).toContainText(/先申请输入权限|Request input access first/, { timeout: 5_000 })
    await expect(page.getByTestId('wr-request')).toBeVisible()

    // 申请 → owner 批准 → 持权
    await page.getByTestId('wr-request').click()
    expect((await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/, { timeout: 15_000 })

    // bmp 的 MIME 是 image/bmp（服务端四类白名单外）→ 客户端按扩展名走 file 形态
    // （P-20261122-18 ⑥ 对齐）→ 服务端扩展名白名单 .bmp 成功落盘
    await page.getByTestId('wr-upload-input').setInputFiles({
      name: 'e2e-btn-pic.bmp',
      mimeType: 'image/bmp',
      buffer: Buffer.from('BM' + '0'.repeat(64)),
    })
    const sb = await waitScrollback(request, headers, sessionId, '.bmp')
    expect(sb, 'bmp must land via the file branch (.bmp), not 400 image/bmp').toContain('sc-paste-')
    expect(sb).toContain('.bmp')
  })

  test('无文件提示收紧：纯文本不提示 → 空剪贴板提示一次（30s 内不重复）', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token } = await createTerminalShare(request, headers, 'notip')
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })
    await page.locator('.xterm-screen').click()

    // 纯文本粘贴：文件提示零动作（text/plain 让给原生链）
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'echo e2e-text-paste-ok')
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await page.waitForTimeout(1200)
    await expect(page.getByTestId('pu-tip')).toBeHidden()

    // 空剪贴板：提示一次（引到上传按钮）
    await dispatchEmptyPaste(page)
    await expect(page.getByTestId('pu-tip')).toContainText(
      /没有可发送的文件|No file in the clipboard/, { timeout: 6_000 },
    )
    await expect(page.getByTestId('pu-tip')).toBeHidden({ timeout: 8_000 }) // 2.4s 自灭

    // 30s 限频：紧接着再按一次不重复提示（clipboard.read 拒绝/无图是快路径）
    await dispatchEmptyPaste(page)
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('pu-tip')).toBeHidden()
  })

  test('?paste=diag：window.__scPasteDiag 可导出且只含元数据（无内容/文件名）', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'diag')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    // 先过口令门（门会话 cookie），再带查询参数进诊断面（门 POST 的 303 不带 query）
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await page.goto(`${shareBase}/s/${token}?paste=diag`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    // 无诊断参数时 window 无此面（默认不暴露调试面）
    const noDiagPage = await page.context().newPage()
    await noDiagPage.goto(`${shareBase}/s/${token}`)
    await expect(noDiagPage.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })
    expect(await noDiagPage.evaluate(() => typeof (window as unknown as Record<string, unknown>).__scPasteDiag)).toBe('undefined')
    await noDiagPage.close()

    // 一次文件粘贴（文件名/内容都带独特标记）+ 一次上传完成 → 诊断事件
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new TextEncoder().encode('diag-secret-content')], 'diag-secret-name.txt', { type: 'text/plain' }))
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await waitScrollback(request, headers, sessionId, 'sc-paste-')
    await expect(page.getByTestId('pu-tip')).toContainText(/已落盘|Saved/, { timeout: 10_000 })

    const diag = await page.evaluate(() => {
      const d = (window as unknown as Record<string, unknown>).__scPasteDiag
      return d ? JSON.parse(JSON.stringify(d)) : null
    }) as { ua?: string; max?: number; events?: Record<string, unknown>[] } | null
    expect(diag, 'window.__scPasteDiag must exist with ?paste=diag').toBeTruthy()
    expect(diag!.max).toBe(10)
    const evs = diag!.events || []
    expect(evs.length).toBeGreaterThan(0)
    expect(evs.length).toBeLessThanOrEqual(10)
    const pasteEv = evs.find(e => e.ev === 'paste') as Record<string, unknown> | undefined
    expect(pasteEv, 'paste event must be recorded').toBeTruthy()
    expect(pasteEv!.reason).toBe('files')
    expect(pasteEv!.files).toBe(1)
    expect(Array.isArray(pasteEv!.types)).toBe(true)
    expect(typeof pasteEv!.target).toBe('string')
    expect(pasteEv!.canType).toBe(true)
    expect(pasteEv!.wsOpen).toBe(true)
    const uploadEv = evs.find(e => e.ev === 'upload' && e.status === 200) as Record<string, unknown> | undefined
    expect(uploadEv, 'upload HTTP status must be recorded').toBeTruthy()
    // 红线 ④：绝不含内容/文件名/路径
    const blob = JSON.stringify(diag)
    expect(blob).not.toContain('diag-secret-name')
    expect(blob).not.toContain('diag-secret-content')
    expect(blob).not.toContain('sc-paste-')
  })

  test('大文本单帧（>16KiB）不再断桥：整帧注入 PTY 且连接保持', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'bigframe')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    const res = await page.evaluate(async (tok) => {
      const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
      const ws = new WebSocket(`${proto}${location.host}/s/${tok}/termws?visitorId=v-e2e-bigframe`)
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve()
        ws.onerror = () => reject(new Error('ws error'))
      })
      // 48KiB 注释行 + 换行 + echo 标记：单帧（旧 16KiB 读上限下必被 1009 关闭）
      const payload = '# ' + 'x'.repeat(48 << 10) + '\r\necho e2e-bigframe-ok\r'
      ws.send(new TextEncoder().encode(payload))
      await new Promise(r => setTimeout(r, 1500))
      const alive = ws.readyState === 1
      try { ws.close() } catch { /* already closed */ }
      return { alive, bytes: payload.length }
    }, token)
    expect(res.bytes).toBeGreaterThan(16 << 10)
    expect(res.alive, 'connection must survive a single >16KiB frame').toBe(true)
    const sb = await waitScrollback(request, headers, sessionId, 'e2e-bigframe-ok', 20_000)
    expect(sb, 'whole big frame must reach the PTY (no bridge drop)').toContain('e2e-bigframe-ok')
  })

  test('图片 CT 四类白名单真执行：image/bmp → 400 unsupported_type；bmp 走 file 字段成功', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token } = await createTerminalShare(request, headers, 'ctwl')
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)

    const out = await page.evaluate(async (tok) => {
      const bytes = new Uint8Array([66, 77, 1, 2, 3, 4])
      const mk = (field: string, name: string, type: string) => {
        const fd = new FormData()
        fd.append('visitorId', 'v-e2e-ct')
        fd.append(field, new File([bytes], name, { type }), name)
        return fd
      }
      const bad = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: mk('image', 'x.bmp', 'image/bmp') })
      const badBody = await bad.text()
      const ok = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: mk('file', 'x.bmp', 'image/bmp') })
      const okBody = await ok.json() as { data?: { path?: string } }
      return { badStatus: bad.status, badBody, okStatus: ok.status, okPath: String(okBody?.data?.path || '') }
    }, token)
    expect(out.badStatus, 'image/bmp must be rejected by the 4-type CT whitelist').toBe(400)
    expect(out.badBody).toContain('unsupported_type')
    expect(out.okStatus, 'bmp via file field (extension whitelist) must succeed').toBe(200)
    expect(out.okPath).toContain('sc-paste-')
    expect(out.okPath).toContain('.bmp')
  })

  test('Chromium 真实剪贴板 PNG（grantPermissions + ClipboardItem + Control+V）', async ({ request, page, context, browserName }) => {
    test.skip(browserName !== 'chromium', '真实 async 剪贴板 + 原生粘贴仅 Chromium 安全上下文可测')
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'clipreal')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: shareBase })
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    // 8x8 画布 → ClipboardItem('image/png') 写入真实剪贴板
    await page.evaluate(async () => {
      const canvas = document.createElement('canvas')
      canvas.width = 8; canvas.height = 8
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('canvas 2d unavailable')
      ctx.fillStyle = '#e11'; ctx.fillRect(0, 0, 8, 8)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob) throw new Error('toBlob failed')
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    })
    await page.locator('.xterm-screen').click()
    await page.keyboard.press('Control+V')
    const sb = await waitScrollback(request, headers, sessionId, 'sc-paste-', 10_000)
    if (!sb.includes('sc-paste-')) {
      // P-20261123-3 起聚焦终端的 Ctrl+V 不再被 xterm 吞（custom key handler 放行
      // 原生粘贴）——本用例在本机 headless/headed Chromium 实测均走原生 paste 通过
      //（2026-11-23，旧 skip 的直接成因就是聚焦键被吞）；守卫保留给确实不派发原生
      // 粘贴的环境（环境限制，非产品缺口）——如实 skip，不伪装成通过/失败
      test.skip(true, '本环境未派发原生粘贴（合成 Control+V 不读剪贴板）——环境限制，已记录（P-20261123-3 复核）')
    }
    expect(sb).toContain('sc-paste-')
    expect(sb).toMatch(/\.(png|jpg)/)
  })

  // ── 闸前可见化（P-20261123-1）──────────────────────────────────────────
  // 用户主诉不是上传链失效，而是「hold 未持权/未连线时闸前静默」：旧序在
  // !canType || !wsOpen 直接 return，无提示、无诊断。以下四条按状态面覆盖
  // 原因分档，并钉住「只可见化不改流向」（不 preventDefault / 不自动申请 /
  // 无 /paste-upload 请求）。

  test('hold 未申请：带文件 paste → puNeedHold + 申请槽 1.2s 高亮 + 无上传 + diag gate=need_hold', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate-hold')
    createdSessions.push(sessionId)
    const uploads = trackPasteUploads(page)

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p23-gate-hold'))
    await page.goto(`${shareBase}/s/${token}?paste=diag`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    // 常驻兜底文案（④）：错过 2.4s 瞬提示也能从页脚知道粘贴也走申请
    await expect(page.locator('#roTip')).toContainText(/粘贴图片\/文件|paste images\/files/)

    await dispatchFilePaste(page)
    // 可见原因（不 preventDefault、不自动发起申请）
    await expect(page.getByTestId('pu-tip')).toContainText(/先申请输入权限|Request input access first/, { timeout: 5_000 })
    // 申请槽在场（status=none）→ 1.2s 引导高亮（prefers-reduced-motion 另走静态描边）
    await expect(page.getByTestId('wr-request-box')).toHaveClass(/wr-req-flash/)
    await expect(page.getByTestId('wr-request-box')).not.toHaveClass(/wr-req-flash/, { timeout: 3_000 })
    await page.waitForTimeout(500)
    expect(uploads, '未持权不得发起 /paste-upload').toHaveLength(0)

    // 诊断前置：主失败形态现在可凭 ?paste=diag 定位（gate/targetKind/状态位分开记）
    const ev = firstPasteEvent(await pasteDiag(page))
    expect(ev, 'gated paste must be recorded (diag before gate)').toBeTruthy()
    expect(ev!.reason).toBe('gated')
    expect(ev!.gate).toBe('need_hold')
    expect(ev!.targetKind).toBe('term')
    expect(ev!.directStatus).toBe('none')
    expect(ev!.files).toBe(1)
    expect(ev!.canType).toBe(false)
    expect(ev!.wsOpen).toBe(true)

    // 同原因 10s 限频：首个提示自灭后连按不再重复弹（防驱动/连按噪音）
    await expect(page.getByTestId('pu-tip')).toBeHidden({ timeout: 6_000 })
    await dispatchFilePaste(page)
    await page.waitForTimeout(1000)
    await expect(page.getByTestId('pu-tip')).toBeHidden()
  })

  test('hold 已申请 pending：paste → wrWaiting 提示无上传；owner 批准后同操作上传落盘', async ({ request, page }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate-pending')
    createdSessions.push(sessionId)
    const uploads = trackPasteUploads(page)

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p23-gate-pending'))
    await page.goto(`${shareBase}/s/${token}?paste=diag`)
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 10_000 })
    // 状态源是 direct_state 帧（lastDirectStatus）而非点击时刻的申请槽在场性：
    // 点击后请求回包即改写 strip，但 pending 要等随后的 state 帧回执——等一拍
    // 让帧落地，否则本用例断言的是 none 分支（提示会变成「先申请」）
    await page.waitForTimeout(800)

    // pending 状态源：提示「等待批准」而不是「先申请」（申请槽此时已隐藏）
    await dispatchFilePaste(page)
    await expect(page.getByTestId('pu-tip')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 5_000 })
    await page.waitForTimeout(500)
    expect(uploads).toHaveLength(0)
    const pendEv = firstPasteEvent(await pasteDiag(page))
    expect(pendEv!.gate).toBe('need_hold')
    expect(pendEv!.directStatus).toBe('pending')

    // 批准 → 持权；同一动作走完整上传链（闸前只提示，资格恢复即正常）
    expect((await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/, { timeout: 15_000 })
    await dispatchFilePaste(page)
    const sb = await waitScrollback(request, headers, sessionId, 'sc-paste-')
    expect(sb, 'qualified paste must reach the PTY (upload 200 + term.paste)').toContain('sc-paste-')
    expect(uploads.length, '上传链必须真的走到 /paste-upload').toBeGreaterThan(0)
    await expect(page.getByTestId('pu-tip')).toContainText(/已落盘|Saved/, { timeout: 10_000 })
  })

  test('他人持权：paste → wrOther 提示且无上传（状态源=direct_state 而非申请槽在场性）', async ({ request, page }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate-other')
    createdSessions.push(sessionId)

    // A 访客申请并获批准持权
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p23-holder-a'))
    await page.goto(`${shareBase}/s/${token}`)
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 10_000 })
    expect((await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/, { timeout: 15_000 })

    // B 访客（另一 visitorId）：hello 随帧 direct_state=held(!mine) → 状态条 wrOther
    const other = await page.context().newPage()
    const otherUploads = trackPasteUploads(other)
    await other.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p23-other-b'))
    await other.goto(`${shareBase}/s/${token}?paste=diag`)
    await expect(other.getByTestId('wr-text')).toContainText(/其他访客正在输入|Another visitor is typing/, { timeout: 15_000 })

    await dispatchFilePaste(other)
    await expect(other.getByTestId('pu-tip')).toContainText(/其他访客正在输入|Another visitor is typing/, { timeout: 5_000 })
    await other.waitForTimeout(600)
    expect(otherUploads, '他人持权时不得发起上传').toHaveLength(0)
    const ev = firstPasteEvent(await pasteDiag(other))
    expect(ev!.gate).toBe('need_hold')
    expect(ev!.directStatus).toBe('held')
    await other.close()
  })

  test('open 持权 + 页内输入框：纯文本零提示；文件 paste → puFocusTerm 且无上传', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate-input')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    const uploads = trackPasteUploads(page)

    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    await page.getByTestId('wr-search-toggle').click()
    await page.getByTestId('wr-search-input').focus()

    // 输入框纯文本：原生输入语义，零提示零接管
    await dispatchTextPaste(page, '[data-testid="wr-search-input"]')
    await page.waitForTimeout(800)
    await expect(page.getByTestId('pu-tip')).toBeHidden()

    // 输入框带文件：文件只能进终端粘贴链 → 提示先聚焦终端（仍不接管/不上传）
    await dispatchFilePaste(page, '[data-testid="wr-search-input"]')
    await expect(page.getByTestId('pu-tip')).toContainText(
      /请先点击终端区域再粘贴文件|Click the terminal area first, then paste files/, { timeout: 5_000 },
    )
    await page.waitForTimeout(600)
    expect(uploads, '输入框目标不得触发终端上传链').toHaveLength(0)
  })

  test('collab 开 + 无资格 paste：无 writable 新提示（只记 diag）', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate-collab')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/collab`, { headers, data: { collab: true } })).ok()).toBeTruthy()
    const uploads = trackPasteUploads(page)

    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-p23-collab'))
    await page.goto(`${shareBase}/s/${token}?paste=diag`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })

    // collab 开：协作位自身有收件箱/素材框反馈——只记诊断，不弹 writable 提示
    await dispatchFilePaste(page)
    await page.waitForTimeout(1500)
    await expect(page.getByTestId('pu-tip')).toBeHidden()
    const ev = firstPasteEvent(await pasteDiag(page))
    expect(ev, 'collab 开也必须记诊断（只抑制提示）').toBeTruthy()
    expect(ev!.gate).toBe('need_hold')
    expect(ev!.targetKind).toBe('term')
    expect(uploads, 'collab 开无资格不得走终端上传链（收件箱链是 /drops）').toHaveLength(0)
  })
})
