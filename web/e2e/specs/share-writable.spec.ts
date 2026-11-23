import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 可写分享（P-20261106-8「对方可直接输入」模式）E2E——访客 WS 上行桥全链：
 *   1. 开关三闸：缺 confirm 400 / 无口令缺 passphrase 400（stable 文案是前端
 *      「先设口令」弹层的契约）/ 带确认+口令开启成功（记录 writable=true +
 *      hasPassphrase=true）；关闭零摩擦回收
 *   2. WS 上行链（访客页内原生 WebSocket，同源 Origin+口令 cookie 全真）：
 *      gate 页解锁 → hello → 按键帧注入 PTY（owner 侧 scrollback 可见）→
 *      危险粘贴挂待批（paste_review，未批不注入）→ owner 批准注入
 *      （paste_approved + scrollback 出现）→ 拒绝丢弃（paste_denied）→
 *      可写关闭下行（writable_off + wtyping 投影清零）
 *   3. wtyping 投影：WS 在场 GET /api/share 行带 wtyping.visitors>=1，
 *      断开/关闭后消失（「访客输入中」徽标的数据面）
 *   4. 批量端点：confirm 硬闸 400 / 无口令条目 passphrase_required 跳过
 *      （批量不摊薄口令补偿）/ off 方向全量回收
 *   5. 审计：开关与注入批次入账（share.writable / share.writable.input，
 *      元数据口径——批次 Detail 不含注入文本本体）
 * 60s 审批时效/帧率触限的守恒不在 e2e 时间预算内（单测
 * TestWritablePasteDenyAndTTL / TestTokenBucketRate 已覆盖）。
 * 共享实例全局分享列表（workers=1 串行），beforeEach/afterEach 清空。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'wr-e2e-pass-1'

// 访客页主脚本顶层 `const term` 是全局词法绑定而非 window 属性（globalThis.term
// 恒 undefined）；page.evaluate 的函数在页内全局作用域编译，直接引用该标识符
// 即取到真实终端实例。declare 仅服务 TS 类型面（e2e 不进 vue-tsc/eslint 扫描）
declare const term: { options?: { theme?: { cursor?: string } } }

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

/** 清空全部分享（服务端全局状态；撤销同时级联清可写上行与直通持权） */
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

/** 开 shell 终端并直播分享，返回 {token, sessionId}（可写档主形态=普通终端） */
async function createTerminalShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
): Promise<{ token: string; sessionId: string }> {
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-wr-${tag}`, kind: 'shell' },
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

/** 轮询审计台账直至出现该 token 的指定动作事件（3s 定时批量入账，不整页忙等） */
async function waitAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  action: string,
  token: string,
): Promise<AuditEvent[]> {
  const deadline = Date.now() + 15_000
  while (Date.now().valueOf() < deadline) {
    const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
    const events = ((await res.json()) as { data?: AuditEvent[] }).data || []
    const hits = events.filter(e => e.action === action && (e.detail || '').includes(token))
    if (hits.length > 0) return hits
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`audit ${action} for ${token} never appeared within 15s`)
}

/** 轮询 owner 侧终端 scrollback 直至出现标记文本（注入是异步流，不整页忙等） */
async function waitScrollback(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now().valueOf() < deadline) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok()) {
      const body = await res.text()
      if (body.includes(marker)) return
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`scrollback marker ${marker} never appeared within 10s`)
}

/** 在访客页内跑一段 WS 协议脚本（原生 WebSocket：同源 Origin + 口令 cookie
 *  全真——page 已过 gate），返回收集到的控制帧序列 */
async function runWsScript(
  page: Page,
  token: string,
  script: { sends: string[]; wantFrames: number; visitorId?: string },
): Promise<string[]> {
  return page.evaluate(async ({ tok, sends, want, vid }) => {
    const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
    const ws = new WebSocket(`${proto}${location.host}/s/${tok}/termws?visitorId=${encodeURIComponent(vid || 'v-e2e-wr')}`)
    const frames: string[] = []
    return await new Promise<string[]>((resolve, reject) => {
      const timer = setTimeout(() => { try { ws.close() } catch { /* already */ } reject(new Error(`ws timeout, frames=${frames.join(' | ')}`)) }, 8000)
      ws.onmessage = (ev) => {
        frames.push(String(ev.data))
        if (frames.length >= want) {
          clearTimeout(timer)
          resolve(frames)
          ws.close()
        }
      }
      ws.onerror = () => { clearTimeout(timer); reject(new Error(`ws error, frames=${frames.join(' | ')}`)) }
      ws.onopen = () => {
        // 二进制帧逐条发送（hello 先到——服务端控制帧先于注入回执，这里按
        // wantFrames 收满即算；发送在 onopen 后即刻进行，时序由服务端保证）
        for (const s of sends) ws.send(new TextEncoder().encode(s))
      }
    })
  }, { tok: token, sends: script.sends, want: script.wantFrames, vid: script.visitorId })
}

test.describe('share-writable', () => {
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

  test('开关三闸：缺 confirm 400 → 无口令缺 passphrase 400 → 带 confirm+口令开启 → 关闭回收', async ({ request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const { token, sessionId } = await createTerminalShare(request, headers, 'gate')
    createdSessions.push(sessionId)

    // 缺 confirm：400（agent/脚本不可静默开启——管理面摩擦硬闸）
    const noConfirm = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: true } })
    expect(noConfirm.status()).toBe(400)
    expect(await noConfirm.text()).toContain('explicit confirmation')

    // 缺口令：400 stable 文案（记录未设口令，开启必须随请求补设）
    const noPass = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: true, confirm: true } })
    expect(noPass.status()).toBe(400)
    expect(await noPass.text()).toContain('writable requires a passphrase')

    // 带 confirm + passphrase：开启成功，口令门同步落库
    const ok = await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })
    expect(ok.ok(), await ok.text()).toBeTruthy()
    const okBody = (await ok.json()) as { data?: { writable?: boolean; hasPassphrase?: boolean }; ttlHint?: boolean }
    expect(okBody.data?.writable).toBe(true)
    expect(okBody.data?.hasPassphrase).toBe(true)
    expect(okBody.ttlHint).toBe(true)

    // 关闭零摩擦：不需要 confirm
    const off = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })
    expect(off.ok(), await off.text()).toBeTruthy()
    const offBody = (await off.json()) as { data?: { writable?: boolean } }
    expect(offBody.data?.writable).toBe(false)

    // 重开：记录已有口令，confirm 即可（口令门就位）
    const reopen = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: true, confirm: true } })
    expect(reopen.ok(), await reopen.text()).toBeTruthy()

    // 开关入审计（share.writable 动作，3s 攒批）
    const audits = await waitAudit(request, headers, 'share.writable', token)
    expect(audits.length).toBeGreaterThanOrEqual(3)
  })

  test('访客 WS 上行链：hello → 注入 → 危险粘贴审批（批准注入/拒绝丢弃）→ 关闭下行', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'flow')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()

    // 访客浏览器：gate 页解锁 → 终端直播访客页（writable 位在场）
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    // 页面自身可写位接通（writablepage 挂载 + WS hello；文案双语容错——
    // e2e 运行环境的浏览器语言不定）。状态条为合并横幅右段（P-20261119-3：
    // #maskBanner 内胶囊，wr-strip/wr-text testid 保持）
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/)
    // sub 三态之「可写」（P-20261119-3 所有权二分）：WS hello 后头部副标题
    // 翻可写文案——不再与下方可写横幅同屏矛盾（原缺陷=ES hello 无条件写
    // 只读文案钉住头部）
    await expect(page.locator('#sub')).toContainText(/可写直播|Writable live/)
    // 合并形态：状态条确在横幅内（旧独立卡顶条 DOM 退役）
    const stripInBanner = await page.locator('#maskBanner [data-testid="wr-strip"]').count()
    expect(stripInBanner).toBe(1)

    // WS 在场：owner 侧列表行 wtyping 投影（「访客输入中」徽标数据面）
    let wtypingSeen = false
    const deadline = Date.now() + 10_000
    while (Date.now().valueOf() < deadline && !wtypingSeen) {
      const res = await request.get(`${BASE}/api/share`, { headers })
      const rows = ((await res.json()) as { data?: Array<{ token: string; wtyping?: { visitors?: number } }> }).data || []
      wtypingSeen = (rows.find(r => r.token === token)?.wtyping?.visitors ?? 0) >= 1
      if (!wtypingSeen) await new Promise(r => setTimeout(r, 400))
    }
    expect(wtypingSeen, 'wtyping projection must appear while WS open').toBeTruthy()

    // wait 态（P-20261119-3 新增断言面）：页面自身连接的危险粘贴——paste_review
    // 单播发往发送连接（writable.go writeControl），只有页面 UI 粘贴才能观测到
    // 横幅右段的 wait 形态（脚本第二连接的粘贴对页面不可见）。xterm 的 paste
    // 处理器在 .xterm-helper-textarea 上收 paste 事件（vendored build 实勘在
    // 场）——合成 ClipboardEvent 直达该监听（无头环境确定形态，免剪贴板权限）。
    // 块判定走 ≥64B 档（WritablePasteReviewBytes）：xterm 粘贴把 \n 归一成 \r
    // （实勘：含 \n 的短块经 UI 粘贴后帧内无 \n=按键路径直接注入），长危险块
    // 是 UI 路径唯一可靠的待批形态
    const PAGE_PASTE = 'rm -rf /tmp/e2e-wr-page-x' + 'x'.repeat(64)
    await page.locator('.xterm-screen').click()
    await page.evaluate((block) => {
      const dt = new DataTransfer()
      dt.setData('text/plain', block)
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PAGE_PASTE)
    await expect(page.getByTestId('wr-strip')).toHaveClass(/wait/, { timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/审批|approval/i)
    // 待批块未批不注入：scrollback 不出现页面粘贴目标
    const pagePasteMid = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    expect(await pagePasteMid.text()).not.toContain('/tmp/e2e-wr-page-x')

    // 协议面（页内原生 WS 第二条连接）：hello → 按键注入 → 危险粘贴待批
    const frames = await runWsScript(page, token, {
      sends: ['echo e2e-wr-ok\r', 'rm -rf /tmp/e2e-wr-x\n'],
      wantFrames: 2, // hello + paste_review（直接注入无回执帧）
    })
    expect(frames[0]).toContain('"hello"')
    const review = frames.find(f => f.includes('"paste_review"'))
    expect(review, 'danger paste must hold for review').toBeTruthy()
    const pasteId = (JSON.parse(review!) as { id?: string }).id
    expect(pasteId).toBeTruthy()

    // 注入落地（owner 侧 scrollback 可见——「访客输入中」的裁决依据）
    await waitScrollback(request, headers, sessionId, 'e2e-wr-ok')
    // 危险块未批不注入：scrollback 不出现目标（marker 带 /tmp/e2e-wr-x 尾）
    const mid = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    expect(await mid.text()).not.toContain('/tmp/e2e-wr-x')

    // owner 批准 → paste_approved + 注入落地
    const approve = await request.post(`${BASE}/api/share/${token}/paste/${pasteId}/decision`, {
      headers, data: { approve: true },
    })
    expect(approve.ok(), await approve.text()).toBeTruthy()
    await waitScrollback(request, headers, sessionId, '/tmp/e2e-wr-x')

    // 拒绝路径：新危险粘贴 → decision approve:false → 后续不见注入（帧面在
    // 拒绝分支已验，这里只验端点幂等：同 id 二次决策 404）
    const frames2 = await runWsScript(page, token, {
      sends: ['git reset --hard\n'],
      wantFrames: 2,
    })
    const review2 = frames2.find(f => f.includes('"paste_review"'))
    expect(review2).toBeTruthy()
    const pasteId2 = (JSON.parse(review2!) as { id?: string }).id
    const deny = await request.post(`${BASE}/api/share/${token}/paste/${pasteId2}/decision`, {
      headers, data: { approve: false },
    })
    expect(deny.ok(), await deny.text()).toBeTruthy()
    const again = await request.post(`${BASE}/api/share/${token}/paste/${pasteId2}/decision`, {
      headers, data: { approve: false },
    })
    expect(again.status()).toBe(404, 'paste decision must be single-shot')
    // err 态（P-20261119-3 新增断言面）：paste_denied 全体广播——页面自身
    // 连接收到后横幅右段翻 err + 拒绝文案（wrDenied 双语容错）
    await expect(page.getByTestId('wr-strip')).toHaveClass(/err/, { timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/未批准|did not approve/i)

    // 关闭可写：访客页回落只读（页面自身连接收 writable_off 后隐藏状态条 +
    // 轮询状态端点回落 false）+ wtyping 投影清零；sub 同步恢复只读文案
    //（P-20261119-3 teardown 面——「收回恢复」态，与横幅右段一并归位）
    expect((await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-strip')).toBeHidden({ timeout: 10_000 })
    await expect(page.locator('#sub')).toContainText(/只读直播|read-only/i)
    const stateAfter = await page.evaluate(async (tok) => {
      const res = await fetch(`/s/${tok}/writable/state`)
      return (await res.json()) as { writable?: boolean }
    }, token)
    expect(stateAfter.writable).toBe(false)

    // 审计：注入批次入账（元数据口径），Detail 不含注入文本本体
    const inputAudits = await waitAudit(request, headers, 'share.writableInput', token)
    expect(inputAudits.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(inputAudits)).not.toContain('e2e-wr-ok')
    expect(JSON.stringify(inputAudits)).not.toContain('rm -rf')
  })

  test('批量端点：confirm 硬闸 → 无口令条目跳过 → off 全量回收', async ({ request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const withPass = await createTerminalShare(request, headers, 'b1')
    const withoutPass = await createTerminalShare(request, headers, 'b2')
    createdSessions.push(withPass.sessionId, withoutPass.sessionId)
    // 先给 b1 设口令（创建面不带口令；passphrase 端点直接补）
    expect((await request.post(`${BASE}/api/share/${withPass.token}/passphrase`, {
      headers, data: { passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()

    // confirm 硬闸：整体 400
    const noConfirm = await request.post(`${BASE}/api/share/writable/batch`, {
      headers, data: { tokens: [withPass.token], on: true },
    })
    expect(noConfirm.status()).toBe(400)

    // 无口令条目跳过（批量不携带逐条口令——补偿强度不摊薄）
    const batchOn = await request.post(`${BASE}/api/share/writable/batch`, {
      headers, data: { tokens: [withPass.token, withoutPass.token], on: true, confirm: true },
    })
    expect(batchOn.ok(), await batchOn.text()).toBeTruthy()
    const rows = ((await batchOn.json()) as { data?: Array<{ token: string; ok: boolean; reason?: string }> }).data || []
    const r1 = rows.find(r => r.token === withPass.token)
    const r2 = rows.find(r => r.token === withoutPass.token)
    expect(r1?.ok).toBe(true)
    expect(r2?.ok).toBe(false)
    expect(r2?.reason).toBe('passphrase_required')
    // 逐条落库核对
    const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: Array<{ token: string; writable?: boolean }> }).data || []
    expect(list.find(s => s.token === withPass.token)?.writable).toBe(true)
    expect(list.find(s => s.token === withoutPass.token)?.writable).toBe(false)

    // off 方向全量回收（不需要 confirm——回收永远是安全方向）
    const batchOff = await request.post(`${BASE}/api/share/writable/batch`, {
      headers, data: { tokens: [withPass.token, withoutPass.token], on: false },
    })
    expect(batchOff.ok(), await batchOff.text()).toBeTruthy()
    const offRows = ((await batchOff.json()) as { data?: Array<{ token: string; ok: boolean }> }).data || []
    expect(offRows.every(r => r.ok)).toBe(true)

    // 未知 token 如实标注 not_found
    const mixed = await request.post(`${BASE}/api/share/writable/batch`, {
      headers, data: { tokens: ['nope0123456789abcd'], on: false },
    })
    expect(mixed.ok()).toBeTruthy()
    const mixedRows = ((await mixed.json()) as { data?: Array<{ token: string; ok: boolean; reason?: string }> }).data || []
    expect(mixedRows[0]?.reason).toBe('not_found')
  })

  test('视口反喂 resize 全链（P-20261120-8）：视口→PTY 改格 → 回声对账 → 主人抢回跟随 → 只读页跟随零上行', async ({ request, page }) => {
    // 评审必改7 断言面：①访客视口宽度反喂主机 PTY（hello 帧读到新 cols=全链
    // 证据）+ 本地栅格铺满零留白 + 诚实回执（wr-text 翻「视口同步」）；②主人
    // PUT 抢回后访客跟随主人栅格且抑制窗内不回踩（SSE resize 帧 ≤1s 对账）；
    // ③审计 share.writableResize 入账（元数据口径）；④关闭可写后重载为只读页
    // ——只读页无 resize 上行，但显示栅格跟随主机变化（必改2 定案语义）。
    // 须 fresh-build 实例（embed 模板随二进制分发，旧实例无本链路）。
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'vp')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    // 钉主机栅格 80×24：访客视口驱动的改格效果可与主机值对照
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 24, cols: 80 },
    })).ok()).toBeTruthy()

    // 访客浏览器 1920×1080：gate 解锁 → 访客页（可写位在场 + 视口驱动开通）
    await page.setViewportSize({ width: 1920, height: 1080 })
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })

    const box = page.locator('#termBox')
    // 视口驱动：栅格从主机 80 列翻到视口宽档（1920 视口 ≥150 列）——本地乐观
    // 先行 + 服务端合并窗应用
    await expect.poll(async () => {
      const raw = await box.evaluate((el) => (el as HTMLElement).dataset.cols || '0')
      return parseInt(raw, 10)
    }, { timeout: 20_000, intervals: [500] }).toBeGreaterThanOrEqual(150)
    const vpCols = parseInt(await box.evaluate((el) => (el as HTMLElement).dataset.cols || '0'), 10)

    // 诚实回执（必改6）：resize_applied 到达 = 服务端合并窗已应用（本断言同时
    // 是 hello 全链证据的前置——500ms 合并窗未到期时 PTY 尺寸还没变）
    await expect(page.getByTestId('wr-text')).toContainText(/视口同步|viewport/i, { timeout: 10_000 })

    // 全链证据：hello 帧的 cols = 视口值（服务端 PTY 尺寸真的变了——SSE 流
    // 的 hello 实时读会话尺寸，sub.Size 取 lastCols/lastRows）
    const hello = await page.evaluate(async (u) => {
      return await new Promise<{ cols?: number }>((resolve, reject) => {
        const es = new EventSource(u)
        const timer = setTimeout(() => { es.close(); reject(new Error('hello timeout')) }, 8000)
        es.addEventListener('hello', (ev) => {
          clearTimeout(timer)
          es.close()
          resolve(JSON.parse(ev.data))
        })
        es.onerror = () => {}
      })
    }, `${shareBase}/s/${token}/stream`)
    expect(hello.cols).toBe(vpCols)

    // 宽度填充：原生 14px 字号铺满容器（零结构性留白——本提案的核心断言）
    const fill = await box.evaluate((el) => {
      const b = el as HTMLElement
      const term = b.querySelector('.xterm') as HTMLElement | null
      if (!term) return 0
      const cs = getComputedStyle(b)
      const avail = b.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 14
      return term.getBoundingClientRect().width / avail
    })
    expect(fill).toBeGreaterThan(0.8)
    const fs = parseFloat(await box.evaluate((el) => (el as HTMLElement).dataset.fontSize || '0'))
    expect(fs).toBe(14)

    // 主人抢回（PUT resize）：SSE resize 帧到达 → 访客跟随主人栅格 80×24，
    // 且抑制窗内不回踩（等待 2s 后仍为主人值——10s 抑制窗外才重新反喂）
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 24, cols: 80 },
    })).ok()).toBeTruthy()
    await expect(box).toHaveAttribute('data-cols', '80', { timeout: 10_000 })
    await page.waitForTimeout(2000)
    expect(await box.evaluate((el) => (el as HTMLElement).dataset.cols)).toBe('80')

    // 审计入账（必改5，元数据口径）：访客视口驱动的改格批次在账（尺寸=视口值；
    // 主人 PUT 抢回走主人 API 不入本动作）
    const audits = await waitAudit(request, headers, 'share.writableResize', token)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(audits)).toContain(`${vpCols}x`)

    // 关闭可写 → 重载为只读页：wr-strip 隐藏（无开放直入键入）、申请入口
    // 在场（P-20261121-1 申请通道缺省开——只读页出「申请输入」入口，无
    // resize 上行：主人 API 改格后只读栅格仍跟随，必改2 定案——只读显示
    // 跟随主机，键入资格未授予前页面不驱动视口反喂）
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: false },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('wr-strip')).toBeHidden()
    // 申请批准入口默认在场（统一收编定案：无 owner 预开步骤）
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    await expect(page.locator('#sub')).toContainText(/只读|read-only/i)
    expect((await request.put(`${BASE}/api/terminals/${sessionId}/resize`, {
      headers, data: { rows: 30, cols: 100 },
    })).ok()).toBeTruthy()
    await expect(box).toHaveAttribute('data-cols', '100', { timeout: 10_000 })
    await expect(box).toHaveAttribute('data-rows', '30')
  })

  // 粘贴上传落盘链（P-20261122-1 必改2）：访客页 paste 事件接管（capture 抢先）
  // → 压缩/直传 → POST /s/{token}/paste-upload 落系统临时目录 sc-paste-* →
  // 路径经 term.paste（bracketed paste）→ onData → WS Binary 帧注入 PTY →
  // owner scrollback 可见。旁证四面：wr-actions 动作排（必改4 复制钮/必改6
  // 搜索开关）在场、持权态光标色（必改7 摘除后的回归断言——setStdin(on)
  // 点亮 '#3d7bfd'）、审计 share.pasteUpload 元数据口径、pu-tip 落盘回执
  test('访客粘贴上传落盘链：文件粘贴 → sc-paste-* 落盘 → 路径入 PTY → 审计 + 光标色回归', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'paste')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()

    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/)

    // 持权态光标色回归（必改7：能力已在库 b15ea9f6，本 spec 是唯一防线——
    // canType=true 时 setStdin 点亮 '#3d7bfd'，teardown 回 'transparent' 的
    // 语义由代码与单测对账，此处锚定可写态现值）
    const cursorColor = await page.evaluate(() => term.options?.theme?.cursor || '')
    expect(cursorColor).toBe('#3d7bfd')

    // 动作排在场（复制钮/搜索开关——必改4/6 访客页 UI 面）
    await expect(page.getByTestId('wr-actions')).toBeVisible()
    await expect(page.getByTestId('wr-copy')).toBeVisible()
    await expect(page.getByTestId('wr-search-toggle')).toBeVisible()

    // 文件粘贴（合成 ClipboardEvent 直达捕获相仲裁监听——文件载荷，非文本）
    await page.locator('.xterm-screen').click()
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new TextEncoder().encode('e2e paste upload body')], 'e2e-paste.txt', { type: 'text/plain' }))
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    // 路径入 PTY：owner scrollback 出现 sc-paste-*.txt（Windows 回告正斜杠路径）
    const sbDeadline = Date.now() + 15_000
    let sbText = ''
    while (Date.now().valueOf() < sbDeadline) {
      const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
      if (res.ok()) {
        sbText = await res.text()
        if (sbText.includes('sc-paste-') && sbText.includes('.txt')) break
      }
      await new Promise(r => setTimeout(r, 300))
    }
    expect(sbText, 'pasted path should reach the PTY via the WS bridge').toContain('sc-paste-')
    expect(sbText).toContain('.txt')

    // 审计（元数据口径：净化名/大小/visitor 摘要/IP/会话——文件内容不入账）
    const audits = await waitAudit(request, headers, 'share.pasteUpload', token)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(JSON.stringify(audits)).toContain('e2e-paste.txt')

    // 落盘回执 tip（pu-tip 2.4s 自灭——上传完成即现）
    await expect(page.getByTestId('pu-tip')).toContainText(/已落盘|Saved/, { timeout: 10_000 })
  })

  // 端点门禁三态（必改1 mode-aware 分档）：只读形态/双开关全关 404 存在性
  // 不可探测 → hold 无持权 403 → open 准入 200。页内 fetch 全真上下文
  // （同源 + 口令 cookie 已由 gate 解锁携带）
  test('粘贴上传端点门禁：只读形态 404 → hold 无持权 403 → open 准入', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    // 只读形态：双开关全关（writable off；申请通道关=guest-input off）
    const ro = await createTerminalShare(request, headers, 'ro404')
    createdSessions.push(ro.sessionId)
    expect((await request.post(`${BASE}/api/share/${ro.token}/guest-input`, {
      headers, data: { on: false },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${ro.token}`)
    const roStatus = await page.evaluate(async (tok) => {
      const fd = new FormData()
      fd.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
      const res = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: fd })
      return res.status
    }, ro.token)
    expect(roStatus).toBe(404)

    // hold 模式（申请通道缺省在场、未开直入）：无持权 403 direct_denied
    const hold = await createTerminalShare(request, headers, 'hold403')
    createdSessions.push(hold.sessionId)
    await page.goto(`${shareBase}/s/${hold.token}`)
    const holdStatus = await page.evaluate(async (tok) => {
      const fd = new FormData()
      fd.append('file', new File(['x'], 'a.txt', { type: 'text/plain' }))
      fd.append('visitorId', 'v-e2e-nohold')
      const res = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: fd })
      return res.status
    }, hold.token)
    expect(holdStatus).toBe(403)

    // open 模式：准入 200 + data.path 落盘形态
    const open = await createTerminalShare(request, headers, 'open200')
    createdSessions.push(open.sessionId)
    expect((await request.post(`${BASE}/api/share/${open.token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${open.token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${open.token}`)
    const openBody = await page.evaluate(async (tok) => {
      const fd = new FormData()
      fd.append('file', new File(['direct upload'], 'open.txt', { type: 'text/plain' }))
      fd.append('visitorId', 'v-e2e-open')
      const res = await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: fd })
      return { status: res.status, body: await res.json() }
    }, open.token)
    expect(openBody.status).toBe(200)
    expect(String(openBody.body?.data?.path || '')).toContain('sc-paste-')
  })

  // 频控（ratePair (token,IP) 10/min）：第 11 次 429 + Retry-After——上传与
  // 键入帧率闸独立的护栏面（drops.go dropMaxPerIP 同参数取态）
  test('粘贴上传频控：(token,IP) 每分钟 10 次，第 11 次 429', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token } = await createTerminalShare(request, headers, 'rate429')
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    const statuses = await page.evaluate(async (tok) => {
      const out: number[] = []
      for (let i = 0; i < 11; i++) {
        const fd = new FormData()
        fd.append('file', new File(['x'], 'r.txt', { type: 'text/plain' }))
        fd.append('visitorId', 'v-e2e-rate')
        out.push((await fetch(`/s/${tok}/paste-upload`, { method: 'POST', body: fd })).status)
      }
      return out
    }, token)
    expect(statuses.filter(s => s === 200).length).toBe(10)
    expect(statuses[10]).toBe(429)
  })

  // 压缩链降级（必改2/必改9）：image/* 载荷解码失败（损坏 PNG）时压缩链整体
  // 降级原图——上传照常成功落 .png、路径照常入 PTY，粘贴链不因压缩异常中断
  // （createImageBitmap 抛错 → catch 返回原 File 的回归面；真实大图重编码的
  // 阈值矩阵由主人端 pasteImageCompress 单测钉住，本页是近逐行同构移植）
  test('图片粘贴压缩降级：损坏 PNG 解码失败仍落盘 .png 并入 PTY', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'imgfallback')
    createdSessions.push(sessionId)
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/, { timeout: 10_000 })

    await page.locator('.xterm-screen').click()
    await page.evaluate(() => {
      const dt = new DataTransfer()
      // 类型是 image/png 但字节不是合法 PNG：解码必然失败 → 降级原图上传
      dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'broken.png', { type: 'image/png' }))
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    const sbDeadline = Date.now() + 15_000
    let sbText = ''
    while (Date.now().valueOf() < sbDeadline) {
      const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
      if (res.ok()) {
        sbText = await res.text()
        if (sbText.includes('sc-paste-') && sbText.includes('.png')) break
      }
      await new Promise(r => setTimeout(r, 300))
    }
    expect(sbText, 'fallback upload must still land as .png and reach the PTY').toContain('sc-paste-')
    expect(sbText).toContain('.png')
  })

  // 拖拽导航守卫（P-20261122-14 必改1，P-20261122-20 上提为五页族共享件）：
  // 拖拽上传经用户定向裁撤，但浏览器缺省动作是导航到本地文件——整页替换、
  // 终端视图丢失。collab 关（创建缺省）时守卫仅对 Files 载荷 preventDefault
  // （不读字节、不上传），drop 后守卫提示面 drag-tip 给既有词表文案改走
  // Ctrl+V/上传按钮（P-20261122-20 起监听在 dragguard.go，writablepage 旧监听
  // 已删——故断言 drag-tip 而非粘贴链专属的 pu-tip，同一次投放无双提示）。
  // 断言=缺省动作被拦（defaultPrevented）+ URL 不变 + tip 可见。
  test('拖拽导航守卫：collab 关时拖入文件 → 缺省导航被拦、URL 不变、提示改走 Ctrl+V', async ({ request, page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const { token } = await createTerminalShare(request, headers, 'dragguard')
    expect((await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    await page.goto(`${shareBase}/s/${token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${shareBase}/s/${token}`)
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    const urlBefore = page.url()

    // 合成拖放（DataTransfer 带 File）：dragover/drop 都应被守卫 preventDefault
    const guarded = await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File(['e2e drag guard body'], 'e2e-drag.txt', { type: 'text/plain' }))
      const over = new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })
      document.body.dispatchEvent(over)
      const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
      document.body.dispatchEvent(drop)
      return { overPrevented: over.defaultPrevented, dropPrevented: drop.defaultPrevented }
    })
    expect(guarded.overPrevented, 'dragover default action must be cancelled').toBe(true)
    expect(guarded.dropPrevented, 'drop default action must be cancelled').toBe(true)
    await expect(page.getByTestId('drag-tip')).toContainText(
      /拖拽不发送文件|Dragging does not send files/, { timeout: 5_000 },
    )
    // 无双提示：粘贴/上传链专属的 pu-tip 不得被拖放同时点亮（旧监听残留症状）
    await expect(page.getByTestId('pu-tip')).toBeHidden()
    expect(page.url()).toBe(urlBefore)
  })
})
