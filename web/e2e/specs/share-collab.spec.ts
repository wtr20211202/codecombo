import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 分享协作通道（P-20261024-1）E2E——访客素材上行全路径：
 *   1. 开关生命周期：关闭恒 404（与端点不存在不可区分）→ 开启上传成功 →
 *      关闭即回收（再 404），存量已收素材保留可读（管理面清单不随开关断）
 *   2. 上传链：白名单内收件（png=image 档）+ 白名单外拒（.exe → rejected
 *      占位不落盘）+ 访客响应零路径泄露（无 fileName/absPath）+ 主人侧清单
 *      携绝对路径 + consume 消费语义（consumedAt 落投影）+ 单删幂等
 *   3. 通知入账：素材到达 titleKey=share.drop.notify.title（3s 攒批冲刷）
 *   4. 受限留言档：collab 开 1500 rune 放行（500 档会 400）→ 关回落 400
 *   5. 访客页协作位挂载/卸载（collab 关零协作位；cl-direct-* testid 随
 *      P-20261121-1 直通位退役全页面不再出现）
 * 直通/访客输入断言随 P-20261121-1 统一收编迁出至 share-guest-input.spec.ts
 * （素材到达/留言板段保留本文件）；申请时效 / 持权时效的超时回收不在 e2e
 * 时间预算内（单测 TestDirectRequestExpiry / TestDirectIdleExpiry 已覆盖）；
 * 级联回收同（TestDirectCascadeRelease + 撤销端点 handlers 级联）。
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


  test('协作位缺省零挂载：未开协作的直播访客页无任何协作位（存量语义）', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const live = await createTerminalShare(request, headers, 'shell', 'plain')
    createdSessions.push(live.sessionId)
    await page.goto(`${visitor}/s/${live.token}`)
    await expect(page.locator('.xterm-screen').last()).toBeVisible({ timeout: 20_000 })
    // collab 关：合并条内协作 chip 不渲染（count 0 语义=按钮级，评审必改5 裁定）；
    // 直通位随 P-20261121-1 统一收编退役——cl-direct-* testid 全页面不再出现
    await expect(page.getByTestId('cl-root-btn')).toHaveCount(0)
    await expect(page.getByTestId('cl-drop')).toHaveCount(0)
    await expect(page.locator('[data-testid^="cl-direct-"]')).toHaveCount(0)
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
    // 入口条合并（P-20261119-3）：协作入口在合并条内（cl-root-btn chip 形态）
    await expect(page.getByTestId('cl-root-btn')).toBeVisible()

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

  // 并开 paste 仲裁（P-20261122-1 必改3）：SC.collab 与 SC.writable 可并开，
  // canType 时文件粘贴归终端落盘链（writablepage 捕获相监听 preventDefault+
  // stopPropagation 抢先，collab 冒泡监听收不到）——协作收件箱零误收、路径
  // 入 PTY。无键入资格方向（collab 开、writable 关）的既有语义由上方
  // 「素材富输入」用例持续守护（HTML 内联图片粘贴进收件区），两方向合起来
  // 钉死仲裁不翻车
  test('并开 paste 仲裁：canType 时文件粘贴归终端落盘链，协作收件箱零误收', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    const visitor = await getShareBase(request, headers)
    const live = await createTerminalShare(request, headers, 'shell', 'arbit')
    createdSessions.push(live.sessionId)
    expect((await setCollab(request, headers, live.token, true)).ok()).toBeTruthy()
    // 可写开启（强制口令门）——open 模式 hello 即 canType
    const WRITABLE_PASS = 'collab-arbit-pass'
    expect((await request.post(`${BASE}/api/share/${live.token}/passphrase`, {
      headers, data: { passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()
    expect((await request.post(`${BASE}/api/share/${live.token}/writable`, {
      headers, data: { on: true, confirm: true, passphrase: WRITABLE_PASS },
    })).ok()).toBeTruthy()

    await page.goto(`${visitor}/s/${live.token}`)
    await page.locator('input[name="passphrase"]').fill(WRITABLE_PASS)
    await page.locator('.field button').click()
    await page.waitForURL(`${visitor}/s/${live.token}`)
    // 键入资格在场（wr-strip on 形态）= 仲裁取「终端链」的前提
    await expect(page.getByTestId('wr-strip')).toBeVisible({ timeout: 10_000 })
    await expect(page.getByTestId('wr-text')).toContainText(/可写模式|Writable mode/)

    // 文件粘贴：捕获相抢先归终端落盘链（若仲裁失效走 collab 链，收件区会
    // 多出素材而终端收不到路径——双向断言钉死）
    await page.locator('.xterm-screen').click()
    await page.evaluate(() => {
      const dt = new DataTransfer()
      dt.items.add(new File([new TextEncoder().encode('collab arbit body')], 'arbit-paste.txt', { type: 'text/plain' }))
      const ta = document.querySelector('.xterm-helper-textarea')
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
    })
    // 路径入 PTY：落盘名恒为 sc-paste-<unixms>.<ext>（主人端同款命名——原始名
    // 不进路径，按前缀+扩展名断言；本文件归属另经审计 share.pasteUpload 的
    // Detail 携净化原始名证明，避免「任何粘贴都能过」的弱断言）
    const sbDeadline = Date.now() + 15_000
    let sbText = ''
    while (Date.now().valueOf() < sbDeadline) {
      const res = await request.get(`${BASE}/api/terminals/${live.sessionId}/scrollback`, { headers })
      if (res.ok()) {
        sbText = await res.text()
        if (sbText.includes('sc-paste-') && sbText.includes('.txt')) break
      }
      await new Promise(r => setTimeout(r, 300))
    }
    expect(sbText, 'arbitrated file paste must land in the terminal chain').toContain('sc-paste-')
    expect(sbText).toContain('.txt')
    // 归属证据：原始名只在审计 Detail（与收件箱清单）出现——审计 share.pasteUpload
    // 携 arbit-paste.txt 即证明进终端链的就是本文件（3s 攒批，轮询窗口给足）
    let audited = ''
    for (let i = 0; i < 20; i++) {
      const res = await request.get(`${BASE}/api/audit?limit=500`, { headers })
      const events = ((await res.json()) as { data?: Array<{ action: string; detail?: string }> }).data || []
      audited = events.filter(e => e.action === 'share.pasteUpload')
        .map(e => e.detail || '').filter(d => d.includes(live.token)).join('\n')
      if (audited.includes('arbit-paste')) break
      await new Promise(r => setTimeout(r, 400))
    }
    expect(audited, 'audit should record the uploaded file by original name').toContain('arbit-paste.txt')
    // 协作收件箱零误收（上传有 3s 攒批窗口 + 落盘时差——轮询窗口给足）
    let inboxLeak = ''
    for (let i = 0; i < 15; i++) {
      const res = await request.get(`${BASE}/api/share/${live.token}/drops`, { headers })
      const list = ((await res.json()) as { data?: Array<{ name: string }> }).data || []
      inboxLeak = list.map(d => d.name).join(',')
      if (inboxLeak.includes('arbit-paste')) break
      await new Promise(r => setTimeout(r, 400))
    }
    expect(inboxLeak, 'arbitrated file paste must NOT reach the collab inbox').not.toContain('arbit-paste')
  })
})
