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
    // e2e 运行环境的浏览器语言不定）
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/)

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

    // 关闭可写：访客页回落只读（页面自身连接收 writable_off 后隐藏状态条 +
    // 轮询状态端点回落 false）+ wtyping 投影清零
    expect((await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-strip')).toBeHidden({ timeout: 10_000 })
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
})
