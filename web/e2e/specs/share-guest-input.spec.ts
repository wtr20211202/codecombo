import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 访客输入统一双授权模式（P-20261121-1）E2E——申请批准路径 + 开放直入 + 两
 * 开关独立组合场景（直通档断言自 share-collab.spec.ts 迁出折一，素材到达/
 * 留言板段保留原文件）：
 *   1. 申请批准全链（hold 模式）：申请入口默认在场（无 owner 预开步骤——
 *      申请通道缺省开定案）→ 访客申请 → 列表行 pending 投影 → 批准 → 页面
 *      direct_state held(mine) → 页面键入经 WS 上行桥注入 → 审计
 *      share.writableInput mode=hold → 一键收回 → 页面回落申请钮
 *   2. 开放直入（open 模式）：行内开关三闸开启 → 访客页 hello 即键入（免申请）
 *      → 审计 mode=open；开启时申请通道在场 →「覆盖申请路径」为文案面（不
 *      自动互斥）
 *   3. 关申请通道组合场景：申请入口消失（页面不渲染非置灰）+ 申请端点恒 404
 *      + 在途申请/持权级联回收（RevokeDirect channel_closed）
 *   4. 持权中关开放直入：两开关独立——开放连接断开（writable_off 回落只读）、
 *      持权连接键入不受影响（授权物是批准不是开关）
 * 申请 10min 时效 / 持权 10min 滑动时效的超时回收不在 e2e 时间预算内（单测
 * TestDirectRequestExpiry / TestDirectIdleExpiry 已覆盖）。
 * 共享实例全局分享列表（workers=1 串行），beforeEach/afterEach 清空。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const WRITABLE_PASS = 'e2e-wr-pass-1'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态；撤销同时级联清收件目录与访客输入持权） */
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

/** 开终端（kind=shell|agent）并直播分享，返回 {token, sessionId}（纯终端运行
 *  时，runtime=shell 不依赖实例上的真实 agent CLI——share-collab 同款先例） */
async function createTerminalShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: 'shell' | 'agent',
  tag: string,
): Promise<{ token: string; sessionId: string }> {
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-guest-${tag}`, kind, ...(kind === 'agent' ? { runtime: 'shell' } : {}) },
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

/** 等审计导出中出现指定 action 且 Detail 含 token（3s 攒批冲刷 + 轮询） */
async function waitAudit(
  request: APIRequestContext,
  headers: Record<string, string>,
  action: string,
  token: string,
): Promise<string[]> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/audit/export?action=${encodeURIComponent(action)}`, { headers })
    if (res.ok()) {
      const text = await res.text()
      if (text.includes(token)) {
        return text.split('\n').filter(l => l.includes(token))
      }
    }
    await new Promise(r => setTimeout(r, 400))
  }
  return []
}

/** 等 owner 侧 scrollback 出现注入回显（「访客输入中」的裁决依据） */
async function waitScrollback(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  marker: string,
): Promise<void> {
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok() && (await res.text()).includes(marker)) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`scrollback never showed ${marker}`)
}

/** 访客 gate 页解锁（口令门在场的分享先验证再进直播页） */
async function unlockGate(page: import('@playwright/test').Page, shareBase: string, token: string, pass: string) {
  await page.goto(`${shareBase}/s/${token}`)
  await page.locator('input[name="passphrase"]').fill(pass)
  await page.locator('.field button').click()
  await page.waitForURL(`${shareBase}/s/${token}`)
}

test.describe('share-guest-input', () => {
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

  test('申请批准全链（hold 模式）：入口默认在场 → 申请 → 批准 → WS 键入注入（audit mode=hold）→ 收回回落', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'agent', 'hold')
    createdSessions.push(sessionId)
    // 默认在场定案（无 owner 预开步骤）：列表行 guestInput=true、无需任何
    // direct-input 预开调用——访客页申请入口直接可见
    const row = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: Array<{ token: string; guestInput?: boolean }> }).data
    expect(row?.find(x => x.token === token)?.guestInput).toBe(true)

    // 访客页：固定 visitorId（API 与页面共用同一 id——持权绑定键），申请入口
    // 即在（合并横幅右段状态条 + 申请槽；页面无「先开通道」前置）
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-gi-visitor-1'))
    await page.goto(`${visitor}/s/${token}`) // 无口令记录直达直播页（gate 免验）
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })

    // 页面申请（点击申请钮——真实访客路径）→ 等待文案（10 分钟时效措辞）
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/)

    // owner 感知：列表行 pending 投影 → 批准（agent 会话限定已退役——shell
    // 会话同样可批；此处 kind=agent 不再是判定前提，普通终端同语义）
    let pendingSeen = false
    for (let i = 0; i < 20 && !pendingSeen; i++) {
      const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: Array<{ token: string; direct?: { pending?: boolean } }> }).data || []
      pendingSeen = !!list.find(x => x.token === token)?.direct?.pending
      if (!pendingSeen) await new Promise(r => setTimeout(r, 300))
    }
    expect(pendingSeen, 'pending projection should surface in share list').toBeTruthy()
    const approve = await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })
    expect(approve.ok(), await approve.text()).toBeTruthy()

    // 页面 direct_state held(mine)：申请槽收起 → 键入资格开通（sub 翻可写文案）
    await expect(page.getByTestId('wr-request')).toBeHidden({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/)
    await expect(page.locator('#sub')).toContainText(/可写直播|Writable live/)

    // 页面键入（xterm onData → Binary 帧）：echo 标记 → owner scrollback 可见
    await page.locator('.xterm-screen').click()
    await page.keyboard.type('echo e2e-gi-hold\r')
    await waitScrollback(request, headers, sessionId, 'e2e-gi-hold')

    // 持权投影：管理面 direct 投影 held + 行内「收回」菜单数据面
    let heldSeen = false
    for (let i = 0; i < 20 && !heldSeen; i++) {
      const proj = ((await (await request.get(`${BASE}/api/share/${token}/direct`, { headers })).json()) as { data?: { hold?: unknown } }).data
      heldSeen = !!proj?.hold
      if (!heldSeen) await new Promise(r => setTimeout(r, 300))
    }
    expect(heldSeen, 'hold projection should surface').toBeTruthy()

    // 一键收回（幂等）→ 页面 direct_revoked：键入资格收回、申请槽回位
    const revoke = await request.post(`${BASE}/api/share/${token}/direct/revoke`, { headers, data: {} })
    expect(revoke.ok()).toBeTruthy()
    expect(((await revoke.json()) as { data?: { had: boolean } }).data?.had).toBe(true)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    // 幂等：再收回 had=false 也成功
    const revoke2 = await request.post(`${BASE}/api/share/${token}/direct/revoke`, { headers, data: {} })
    expect(revoke2.ok()).toBeTruthy()
    expect(((await revoke2.json()) as { data?: { had: boolean } }).data?.had).toBe(false)

    // 键入批次统一审计（share.writableInput 单事件 mode=hold 分档——必改8）：
    // 5s 聚合窗口在连接断开时兜底冲账（pasteAuditWindow 注记）——断言放在
    // 收回之后（收回即主动断开该访客 WS → flushConnAudit 成账），与
    // share-writable.spec「关闭下行后验审计」同一时序纪律
    const audits = await waitAudit(request, headers, 'share.writableInput', token)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits.join('\n')).toContain('mode=hold')
    // 旧 share.direct.input 批次键退役：export 按 action 过滤无新增批次
    const legacy = await request.get(`${BASE}/api/audit/export?action=${encodeURIComponent('share.direct.input')}`, { headers })
    if (legacy.ok()) expect(await legacy.text()).not.toContain(token)
  })

  test('开放直入（open 模式）：三闸开启 → 访客页 hello 即键入免申请（audit mode=open）', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token, sessionId } = await createTerminalShare(request, headers, 'shell', 'open')
    createdSessions.push(sessionId)

    // 开放直入三闸（缺 confirm 400 / 缺口令 400 stable——行内开关语义转正零变化）
    const noConfirm = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: true } })
    expect(noConfirm.status()).toBe(400)
    const noPass = await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: true, confirm: true } })
    expect(noPass.status()).toBe(400)
    expect(await noPass.text()).toContain('writable requires a passphrase')
    const ok = await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })
    expect(ok.ok(), await ok.text()).toBeTruthy()

    // 访客页：hello 即键入（申请槽隐藏——开放直入覆盖申请路径的访客面；
    // 槽元素常驻 DOM 以 display:none 收起，可见性断言用 toBeHidden）
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-gi-visitor-2'))
    await unlockGate(page, visitor, token, WRITABLE_PASS)
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/)
    await expect(page.getByTestId('wr-request')).toBeHidden()

    // 键入注入（无任何申请/批准动作）
    await page.locator('.xterm-screen').click()
    await page.keyboard.type('echo e2e-gi-open\r')
    await waitScrollback(request, headers, sessionId, 'e2e-gi-open')

    // 关闭开放直入：页面连接收 writable_off 断开（audit 5s 聚合窗口的断开
    // 兜底冲账——与 test-1 收回后验审计同一时序纪律）
    expect((await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-strip')).toBeHidden({ timeout: 10_000 })

    // 审计 mode=open（统一单事件双模式分档的对账面）
    const audits = await waitAudit(request, headers, 'share.writableInput', token)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits.join('\n')).toContain('mode=open')
  })

  test('关申请通道组合场景：入口消失（不渲染）+ 端点恒 404 + 在途申请级联回收', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const { token } = await createTerminalShare(request, headers, 'agent', 'chan')

    // 页面先载入（入口在场），API 侧预置一条在途申请（guestInputOff=false 缺省）
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-gi-visitor-3'))
    await page.goto(`${visitor}/s/${token}`)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    const submit = await fetch(`${visitor}/s/${token}/direct/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: 'e2e-gi-visitor-3', nickname: '访客丙' }),
    })
    expect(submit.status).toBe(200)

    // owner 关通道（guest-input 端点——旧 direct-input 退役）：在途申请级联回收
    const off = await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: false } })
    expect(off.ok(), await off.text()).toBeTruthy()
    expect(((await off.json()) as { data?: { guestInput?: boolean } }).data?.guestInput).toBe(false)
    let pendingGone = false
    for (let i = 0; i < 20 && !pendingGone; i++) {
      const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: Array<{ token: string; direct?: { pending?: boolean } }> }).data || []
      pendingGone = !list.find(x => x.token === token)?.direct?.pending
      if (!pendingGone) await new Promise(r => setTimeout(r, 300))
    }
    expect(pendingGone, 'pending request must be cascaded away on channel close').toBeTruthy()

    // 页面对账（direct_revoked/state none）：申请槽消失——入口不渲染非置灰
    await expect(page.getByTestId('wr-request')).toBeHidden({ timeout: 15_000 })

    // 端点侧同步拒收（服务端强制面，非仅前端隐藏）：申请恒 404（存在性不可
    // 探测，drop 族同款语义）；新开页面加载同样无入口
    const blocked = await fetch(`${visitor}/s/${token}/direct/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: 'e2e-gi-visitor-3' }),
    })
    expect(blocked.status).toBe(404)

    // 回开：入口重出（访客页轮询自愈——5s writable/state 轮询 guestInput=true 重连）
    expect((await request.post(`${BASE}/api/share/${token}/guest-input`, { headers, data: { on: true } })).ok()).toBeTruthy()
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 20_000 })
  })

  test('持权中关开放直入：两开关独立——开放连接断开、持权键入不受影响', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    // 创建即带口令（开启开放直入用 confirm 即可——若记录无门，开启时补设
    // 口令会让口令门在页面已载入后才生效，后续脚本 WS 连接没有门会话 cookie
    // 会被 gateGuard 401 拒绝——「ws error」假败的根因）
    const projectId = await getProjectId(request, headers)
    const created = await request.post(`${BASE}/api/terminals`, {
      headers, data: { projectId, name: 'e2e-guest-mix', kind: 'shell' },
    })
    expect(created.ok(), await created.text()).toBeTruthy()
    const sessionId = ((await created.json()) as { data?: { id?: string } }).data?.id
    expect(sessionId).toBeTruthy()
    createdSessions.push(sessionId!)
    const share = await request.post(`${BASE}/api/share/terminal`, {
      headers, data: { sessionId, passphrase: WRITABLE_PASS },
    })
    expect(share.ok(), await share.text()).toBeTruthy()
    const token = ((await share.json()) as { data?: { token: string } }).data?.token
    expect(token).toBeTruthy()

    // 先走申请批准路径（Writable 关——持权授权物是批准）；口令门在场先解锁
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-gi-visitor-4'))
    await unlockGate(page, visitor, token!, WRITABLE_PASS)
    await expect(page.getByTestId('wr-request')).toBeVisible({ timeout: 15_000 })
    await page.getByTestId('wr-request').click()
    await expect(page.getByTestId('wr-text')).toContainText(/等待分享者批准|waiting for owner approval/, { timeout: 10_000 })
    const approve = await request.post(`${BASE}/api/share/${token}/direct/approve`, { headers, data: {} })
    expect(approve.ok(), await approve.text()).toBeTruthy()
    await expect(page.getByTestId('wr-text')).toContainText(/你正在输入|You are typing/, { timeout: 10_000 })
    await page.locator('.xterm-screen').click()
    await page.keyboard.type('echo e2e-gi-mix-hold\r')
    await waitScrollback(request, headers, sessionId!, 'e2e-gi-mix-hold')

    // owner 开启开放直入：持权访客连接不受影响（模式按接入时点定格——既有
    // 连接保持 hold 语义），新访客（脚本第二连接）接入即 open 可键入（同一
    // 浏览器上下文携口令门 cookie——gateGuard 放行）
    const on = await request.post(`${BASE}/api/share/${token}/writable`, {
      headers, data: { on: true, confirm: true },
    })
    expect(on.ok(), await on.text()).toBeTruthy()
    const openFrames = await page.evaluate(async ({ tok }) => {
      return await new Promise<string[]>((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss://' : 'ws://'
        const ws = new WebSocket(`${proto}${location.host}/s/${tok}/termws?visitorId=e2e-gi-open-tmp`)
        const frames: string[] = []
        const timer = setTimeout(() => reject(new Error(`timeout, frames=${frames.join(' | ')}`)), 8000)
        ws.onmessage = (ev) => { frames.push(String(ev.data)) }
        ws.onopen = () => { ws.send(new TextEncoder().encode('echo e2e-gi-mix-open\r')) }
        ws.onclose = () => { clearTimeout(timer); resolve(frames) }
        ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')) }
        // 收 hello 即视为接入成功，注入后等 1s 收口（注入无回执帧）
        const poll = setInterval(() => {
          if (frames.some(f => f.includes('"hello"'))) {
            setTimeout(() => { clearInterval(poll); ws.close() }, 1000)
          }
        }, 200)
      })
    }, { tok: token })
    expect(openFrames[0]).toContain('"mode":"open"')

    // owner 关闭开放直入：开放连接收 writable_off 断开（脚本连接已关，此处
    // 验 wtyping 投影回落）；持权访客键入不受影响——两开关独立的服务端强制面
    expect((await request.post(`${BASE}/api/share/${token}/writable`, { headers, data: { on: false } })).ok()).toBeTruthy()
    await page.keyboard.type('echo e2e-gi-mix-after\r')
    await waitScrollback(request, headers, sessionId, 'e2e-gi-mix-after')

    // 持权投影仍在（关开放直入不回收持权）
    const proj = ((await (await request.get(`${BASE}/api/share/${token}/direct`, { headers })).json()) as { data?: { hold?: unknown } }).data
    expect(proj?.hold, 'hold must survive writable toggle').toBeTruthy()
  })
})
