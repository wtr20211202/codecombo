import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享协作通道（P-20261024-1）E2E——访客素材上行 + 直通输入档全路径：
 *   1. 开关生命周期：关闭恒 404（与端点不存在不可区分）→ 开启上传成功 →
 *      关闭即回收（再 404），存量已收素材保留可读（管理面清单不随开关断）
 *   2. 上传链：白名单内收件（png=image 档）+ 白名单外拒（.exe → rejected
 *      占位不落盘）+ 访客响应零路径泄露（无 fileName/absPath）+ 主人侧清单
 *      携绝对路径 + consume 消费语义（consumedAt 落投影）+ 单删幂等
 *   3. 通知入账：素材到达 titleKey=share.drop.notify.title（3s 攒批冲刷）
 *   4. 受限留言档：collab 开 1500 rune 放行（500 档会 400）→ 关回落 400
 *   5. 直通输入档：agent 会话限定（shell 分享批准 400）+ 握手全路径（申请 →
 *      列表行 pending 投影 → 批准 → 访客轮询 held → 输入批次 200 → 一键收回
 *      → 再输入 403）+ 访客页协作位挂载/卸载（collab 关零协作位）
 * 60s 申请时效 / 10min 持权时效的超时回收不在 e2e 时间预算内（单测
 * TestDirectRequestExpiry / TestDirectIdleExpiry 已覆盖）；级联回收同（
 * TestDirectCascadeRelease + 撤销端点 handlers 级联）。
 * 共享实例全局分享列表（workers=1 串行），beforeEach/afterEach 清空。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

// 本轮创建的分享目标文件（afterEach 统一删除——种子项目仓库不得残留：
// 根目录每多一行树就长一行，rightClickTreeBackground 系 spec 依赖树尾部
// 留白，泄漏文件会把它挤没——share-guestbook createdFiles 同款纪律）
const createdFiles: string[] = []

/** 1x1 png（最小合法图片，image 档主形态样本） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态；撤销同时级联清收件目录与直通持权） */
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

/** 建唯一目标文件并分享（kind=file，唯一 token → 全新频控桶），返回 token */
async function createFileShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
): Promise<string> {
  const projectId = await getProjectId(request, headers)
  const path = `e2e-collab-${Date.now()}-${tag}.md`
  createdFiles.push(path)
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: `# collab e2e target (${tag})\n` },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
  expect(res.ok(), await res.text()).toBeTruthy()
  const body = (await res.json()) as { data?: { token: string } }
  expect(body.data?.token).toBeTruthy()
  return body.data!.token
}

/** 开终端（kind=shell|agent）并直播分享，返回 {token, sessionId} */
async function createTerminalShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  kind: 'shell' | 'agent',
  tag: string,
): Promise<{ token: string; sessionId: string }> {
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/terminals`, {
    // agent 会话 runtime=shell（agent-chain.spec 同款先例——纯终端运行时不
    // 依赖实例上安装的真实 agent CLI）；projectId 对 agent 形态被忽略
    headers, data: { projectId, name: `e2e-collab-${tag}`, kind, ...(kind === 'agent' ? { runtime: 'shell' } : {}) },
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

/** 访客上传一批素材（multipart），返回状态码与响应体 */
async function guestDrop(
  shareBase0: string,
  token: string,
  files: Array<{ name: string; mimeType: string; buffer: Buffer }>,
  nickname = '测试员',
) {
  const res = await fetch(`${shareBase0}/s/${token}/drop`, {
    method: 'POST',
    body: (() => {
      const fd = new FormData()
      fd.append('nickname', nickname)
      for (const f of files) {
        fd.append('files', new Blob([new Uint8Array(f.buffer)], { type: f.mimeType }), f.name)
      }
      return fd
    })(),
  })
  const body = (await res.json().catch(() => ({}))) as { added?: Array<{ id?: string; name?: string; kind?: string }>; warnings?: string[] }
  return { status: res.status, body }
}

async function setCollab(request: APIRequestContext, headers: Record<string, string>, token: string, collab: boolean) {
  return request.post(`${BASE}/api/share/${token}/collab`, { headers, data: { collab } })
}

test.describe('share-collab', () => {
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
    const projectId = await getProjectId(request, headers).catch(() => '')
    for (const path of createdFiles.splice(0)) {
      if (projectId) {
        await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
      }
    }
  })

  test('开关生命周期：关 404 → 开上传成功 → 白名单/零路径泄露/消费语义 → 关回收存续可读', async ({ request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const token = await createFileShare(request, headers, 'cycle')

    // 关闭态：上传/清单端点恒 404（存在性不可探测——不是 403）
    const closed = await guestDrop(visitor, token, [{ name: 'bug.png', mimeType: 'image/png', buffer: PNG_1PX }])
    expect(closed.status).toBe(404)
    expect((await request.get(`${visitor}/s/${token}/drops`)).status()).toBe(404)

    // 开启：png 收件（image 档）+ .exe 白名单外拒（rejected 占位，无 id 不落盘）
    expect((await setCollab(request, headers, token, true)).ok()).toBeTruthy()
    const up = await guestDrop(visitor, token, [
      { name: 'bug.png', mimeType: 'image/png', buffer: PNG_1PX },
      { name: 'evil.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
    ])
    expect(up.status).toBe(200)
    expect(up.body.added).toHaveLength(2)
    expect(up.body.added?.[0]).toMatchObject({ name: 'bug.png', kind: 'image' })
    expect(up.body.added?.[0]?.id).toBeTruthy()
    expect(up.body.added?.[1]).toMatchObject({ name: 'evil.exe', kind: 'rejected' })
    expect(up.body.added?.[1]?.id).toBeFalsy()

    // 访客清单：可见完成态但零路径泄露（无 fileName/absPath 字段）
    const vlist = await request.get(`${visitor}/s/${token}/drops`)
    expect(vlist.status()).toBe(200)
    const vtext = await vlist.text()
    expect(vtext).toContain('bug.png')
    expect(vtext).not.toContain('absPath')
    expect(vtext).not.toContain('fileName')

    // 主人侧清单：绝对路径在场（贴进会话动作链的取数点）
    const mres = await request.get(`${BASE}/api/share/${token}/drops`, { headers })
    expect(mres.ok()).toBeTruthy()
    const mlist = ((await mres.json()) as { data?: Array<{ id: string; absPath: string; fileName: string; consumedAt?: string }> }).data || []
    expect(mlist).toHaveLength(1)
    expect(mlist[0]!.absPath).toContain('share-drops')
    expect(mlist[0]!.absPath).toContain('bug.png')

    // 消费语义：consume 后 consumedAt 落投影；单删幂等（未知 id 也成功）
    expect((await request.post(`${BASE}/api/share/${token}/drops/${mlist[0]!.id}/consume`, { headers })).ok()).toBeTruthy()
    const after = ((await (await request.get(`${BASE}/api/share/${token}/drops`, { headers })).json()) as { data?: Array<{ consumedAt?: string }> }).data || []
    expect(after[0]?.consumedAt).toBeTruthy()
    expect((await request.delete(`${BASE}/api/share/${token}/drops/no-such-id`, { headers })).ok()).toBeTruthy()

    // 关闭即回收：访客面再 404；存量素材管理面保留可读（清单不随开关断）
    expect((await setCollab(request, headers, token, false)).ok()).toBeTruthy()
    const reclosed = await guestDrop(visitor, token, [{ name: 'again.png', mimeType: 'image/png', buffer: PNG_1PX }])
    expect(reclosed.status).toBe(404)
    expect((await request.get(`${BASE}/api/share/${token}/drops`, { headers })).ok()).toBeTruthy()
  })

  test('通知入账：素材到达 titleKey=share.drop.notify.title（攒批冲刷增量）', async ({ request }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const token = await createFileShare(request, headers, 'notify')
    expect((await setCollab(request, headers, token, true)).ok()).toBeTruthy()

    const listNotices = async (): Promise<number> => {
      const res = await request.get(`${BASE}/api/notifications`, { headers })
      const data = ((await res.json()) as { data?: { titleKey?: string }[] }).data || []
      return data.filter(n => n.titleKey === 'share.drop.notify.title').length
    }
    const baseline = await listNotices()
    const up = await guestDrop(visitor, token, [{ name: 'shot.png', mimeType: 'image/png', buffer: PNG_1PX }], '同事丙')
    expect(up.status).toBe(200)

    // 3s 攒批冲刷：轮询通知中心增量 +1
    let notices = baseline
    for (let i = 0; i < 40 && notices <= baseline; i++) {
      notices = await listNotices()
      if (notices <= baseline) await new Promise(r => setTimeout(r, 400))
    }
    expect(notices, 'drop notification should arrive').toBeGreaterThan(baseline)
  })

  test('受限留言档：collab 开 1500 rune 放行 → 关回落 500 档 400', async ({ request }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const token = await createFileShare(request, headers, 'msg')
    const long = '字'.repeat(1500)
    const post = () => fetch(`${visitor}/s/${token}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: long }),
    })

    // 缺省 500 档：1500 rune → 400
    expect((await post()).status).toBe(400)
    expect((await setCollab(request, headers, token, true)).ok()).toBeTruthy()
    // 协作档 2000：1500 rune → 200
    expect((await post()).status).toBe(200)
    expect((await setCollab(request, headers, token, false)).ok()).toBeTruthy()
    // 回落 500 档：再发 1500 rune → 400（开关即时取档）
    expect((await post()).status).toBe(400)
  })

  test('直通输入档：agent 会话限定 + 握手全路径 + 一键收回 + 访客页协作位挂载', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)

    // 两路直播分享：shell 会话（红线反例）+ agent 会话（正例）
    const shell = await createTerminalShare(request, headers, 'shell', 'sh')
    const agent = await createTerminalShare(request, headers, 'agent', 'ag')
    createdSessions.push(shell.sessionId, agent.sessionId)
    for (const t of [shell.token, agent.token]) {
      expect((await setCollab(request, headers, t, true)).ok()).toBeTruthy()
      const on = await request.post(`${BASE}/api/share/${t}/direct-input`, { headers, data: { on: true, confirm: true } })
      expect(on.ok(), await on.text()).toBeTruthy()
    }
    // 缺 confirm 的开启调用被服务端硬闸拒绝（管理面摩擦双闸的服务端半边）
    const noConfirm = await request.post(`${BASE}/api/share/${agent.token}/direct-input`, { headers, data: { on: true } })
    expect(noConfirm.status()).toBe(400)

    // 访客页与 API 侧共用同一 visitorId：页面首访生成 localStorage 随机 id
    // （collabpage.go VID_KEY，单持有者握手的绑定键），API 驱动的申请/批准
    // 必须持同一 id，页面 2s 轮询 /direct/state 才判 mine=true 收起申请钮换
    // 输入位——addInitScript 预置后 goto，页面侧全路径（pending→held→发送
    // →收回回 none）才可观测（spec 假败修复：原写法 API 用 'e2e-visitor-ui-1'
    // 而页面自生成随机 id，held 后页面判 mine=false 永不出 textarea）
    await page.addInitScript(() => localStorage.setItem('sc.share.visitorId', 'e2e-visitor-ui-1'))
    await page.goto(`${visitor}/s/${agent.token}`)
    await expect(page.getByTestId('cl-root')).toBeVisible()
    // 协作条缺省收起（P-20261107-4：展开内容浮于终端区之上，不再进列流挤压
    // 终端卡片）——展开后见上传位与直通位
    await expect(page.getByTestId('cl-drop')).toBeHidden()
    await page.getByTestId('cl-toggle').click()
    await expect(page.getByTestId('cl-drop')).toBeVisible()
    await expect(page.getByTestId('cl-direct-request')).toBeVisible()

    // 无在途申请批准 → 409（批准无对象）
    const empty = await request.post(`${BASE}/api/share/${agent.token}/direct/approve`, { headers, data: {} })
    expect(empty.status()).toBe(409)

    // agent 会话限定红线：同流程打 shell 分享 → 批准 400（匿名远程 shell 不做）
    await fetch(`${visitor}/s/${shell.token}/direct/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId: 'e2e-visitor-shell', nickname: '访客S' }),
    })
    const deny = await request.post(`${BASE}/api/share/${shell.token}/direct/approve`, { headers, data: {} })
    expect(deny.status()).toBe(400)

    // 握手全路径（agent 分享）：访客申请 → 列表行 pending 投影 → 批准
    const visitorId = 'e2e-visitor-ui-1'
    const req = await fetch(`${visitor}/s/${agent.token}/direct/request`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, nickname: '测试员甲' }),
    })
    expect(req.status).toBe(200)
    let pendingSeen = false
    for (let i = 0; i < 20 && !pendingSeen; i++) {
      const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: Array<{ token: string; direct?: { pending?: boolean } }> }).data || []
      pendingSeen = !!list.find(x => x.token === agent.token)?.direct?.pending
      if (!pendingSeen) await new Promise(r => setTimeout(r, 300))
    }
    expect(pendingSeen, 'pending projection should surface in share list').toBeTruthy()
    const approve = await request.post(`${BASE}/api/share/${agent.token}/direct/approve`, { headers, data: { visitorId } })
    expect(approve.ok(), await approve.text()).toBeTruthy()
    expect(((await approve.json()) as { data?: { nick?: string } }).data?.nick).toBe('测试员甲')

    // 持权卡通知：授予即入账带「收回」行内动作的通知条目（回收四路入口
    // 之二——payload=token 直达回收端点）
    const notices = ((await (await request.get(`${BASE}/api/notifications`, { headers })).json()) as { data?: Array<{ action?: string; actionPayload?: string }> }).data || []
    expect(
      notices.some(n => n.action === 'shdirect-revoke' && n.actionPayload === agent.token),
      'grant should create a hold card notice with revoke action',
    ).toBeTruthy()

    // 持权投影：管理面 direct 投影 held + 访客轮询 held(mine)
    let heldSeen = false
    for (let i = 0; i < 20 && !heldSeen; i++) {
      const proj = ((await (await request.get(`${BASE}/api/share/${agent.token}/direct`, { headers })).json()) as { data?: { hold?: unknown } }).data
      heldSeen = !!proj?.hold
      if (!heldSeen) await new Promise(r => setTimeout(r, 300))
    }
    expect(heldSeen, 'hold projection should surface').toBeTruthy()
    const state = await fetch(`${visitor}/s/${agent.token}/direct/state?visitorId=${encodeURIComponent(visitorId)}`)
    const stateBody = (await state.json()) as { status?: string; mine?: boolean }
    expect(stateBody).toMatchObject({ status: 'held', mine: true })

    // 访客页直通位流转：2s 轮询内 textarea 出现 → 发送批次 → 「已送达会话」
    const ta = page.getByTestId('cl-direct-text')
    await expect(ta).toBeVisible({ timeout: 8000 })
    await ta.fill('复现步骤：打开设置页点第三个开关就崩')
    await page.getByTestId('cl-direct-send').click()
    await expect(page.getByTestId('cl-direct-status')).toContainText('已送达会话')

    // 输入批次全量审计（元数据口径）：审计导出按 action 过滤后含本分享 token
    //（列表端点不支持 action 过滤，export CSV 是过滤面的既有出口）
    let inputAudited = false
    for (let i = 0; i < 20 && !inputAudited; i++) {
      const audit = await request.get(`${BASE}/api/audit/export?action=${encodeURIComponent('share.direct.input')}`, { headers })
      if (audit.ok()) {
        inputAudited = (await audit.text()).includes(agent.token)
      }
      if (!inputAudited) await new Promise(r => setTimeout(r, 400))
    }
    expect(inputAudited, 'direct input batch should be audited').toBeTruthy()

    // 一键收回（四路入口共用的回收端点）：幂等成功 → 再输入 403（权不在）
    const revoke = await request.post(`${BASE}/api/share/${agent.token}/direct/revoke`, { headers, data: {} })
    expect(revoke.ok()).toBeTruthy()
    expect(((await revoke.json()) as { data?: { had: boolean } }).data?.had).toBe(true)
    const input = await fetch(`${visitor}/s/${agent.token}/direct/input`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitorId, text: '收回后还想输入' }),
    })
    expect(input.status).toBe(403)
    // 幂等：再收回 had=false 也成功
    const revoke2 = await request.post(`${BASE}/api/share/${agent.token}/direct/revoke`, { headers, data: {} })
    expect(revoke2.ok()).toBeTruthy()
    expect(((await revoke2.json()) as { data?: { had: boolean } }).data?.had).toBe(false)

    // 访客页对账：轮询到 none 后 textarea 收起、申请钮回位
    await expect(page.getByTestId('cl-direct-request')).toBeVisible({ timeout: 8000 })
  })

  test('协作位缺省零挂载：未开协作的直播访客页无任何协作位（存量语义）', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const live = await createTerminalShare(request, headers, 'shell', 'plain')
    createdSessions.push(live.sessionId)
    await page.goto(`${visitor}/s/${live.token}`)
    await expect(page.locator('.xterm-screen').last()).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('cl-root')).toHaveCount(0)
    await expect(page.getByTestId('cl-drop')).toHaveCount(0)
    await expect(page.getByTestId('cl-direct-request')).toHaveCount(0)
  })

  test('素材富输入：协作条不挤压终端 → 文字素材成 .txt 直达收件区 → HTML 内联图片粘贴上行 → 只读页纯文字粘贴进素材框', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const live = await createTerminalShare(request, headers, 'shell', 'rich')
    createdSessions.push(live.sessionId)
    expect((await setCollab(request, headers, live.token, true)).ok()).toBeTruthy()

    await page.goto(`${visitor}/s/${live.token}`)
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.getByTestId('cl-root')).toBeVisible()

    // ③ 不挤压：展开协作浮层前后终端卡片高度不变（浮层覆于终端区之上，不进列流）
    const cardH = () => page.locator('.card').evaluate(el => el.getBoundingClientRect().height)
    const before = await cardH()
    await page.getByTestId('cl-toggle').click()
    await expect(page.getByTestId('cl-panel')).toBeVisible()
    expect(Math.abs((await cardH()) - before)).toBeLessThan(2)

    // ④ 文字素材：输入 → 提交 → 完成态行 + 主人侧收件区出现 .txt 素材
    const marker = `文字素材-${Date.now()}`
    await page.getByTestId('cl-text').fill(`复现步骤：${marker}\n第二行`)
    await page.getByTestId('cl-text-send').click()
    await expect(page.getByTestId('cl-text-status')).toContainText('已上传', { timeout: 15_000 })
    const waitInbox = async (pred: (d: { name: string; absPath: string }) => boolean) => {
      for (let i = 0; i < 30; i++) {
        const res = await request.get(`${BASE}/api/share/${live.token}/drops`, { headers })
        const list = ((await res.json()) as { data?: Array<{ name: string; absPath: string; kind: string }> }).data || []
        const hit = list.find(pred)
        if (hit) return hit
        await new Promise(r => setTimeout(r, 300))
      }
      return undefined
    }
    const textDrop = await waitInbox(d => d.name.endsWith('.txt'))
    expect(textDrop, 'text material should land in the owner inbox as a .txt file').toBeTruthy()
    expect(textDrop!.absPath).toContain('share-drops')

    // ④ 粘贴失败形态②实勘修复：剪贴板只有 text/html 内联 <img src="data:image/png…">
    //（.files 为空——网页/办公软件复制图片的常见形态）→ 解码成文件走同一上行链
    await page.getByTestId('cl-toggle').click() // 先收起，验证粘贴从折叠态也能上行
    await page.evaluate((b64) => {
      const dt = new DataTransfer()
      dt.setData('text/html', `<meta charset="utf-8"><img src="data:image/png;base64,${b64}">`)
      document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    }, PNG_1PX.toString('base64'))
    const imgDrop = await waitInbox(d => d.name.endsWith('.png'))
    expect(imgDrop, 'html-inline image paste should upload a png material').toBeTruthy()
    // 折叠态摘要给反馈（已收份数）
    await expect(page.getByTestId('cl-summary')).toContainText('已收', { timeout: 10_000 })

    // 只读页上的纯文字粘贴：送进文字素材框待确认（不直接上传）
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.setData('text/plain', 'pasted-into-material-box')
      document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    await expect(page.getByTestId('cl-panel')).toBeVisible()
    await expect(page.getByTestId('cl-text')).toHaveValue('pasted-into-material-box')
  })
})
