import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD } from '../../tests/helpers'
import { serverIsRemote } from '../../tests/dualpath'

/**
 * 访客页族拖拽导航守卫（P-20261122-20）E2E：
 *   P-20261122-14 的守卫只生在可写页 mountWritable 内且 writable/guestInput 双关
 *   早退——只读直播 / 终端定格 / 回放（cast）/ 会话回放 / 文件分享页拖入本地文件
 *   仍走浏览器缺省动作「导航到 file://」，分享视图整页丢失。本 spec 钉五页族
 *   共用守卫（dragguard.go scDragGuard）的实际效果：
 *     1. 只读直播（collab 关）：dragover/drop 都 defaultPrevented + URL 不变 +
 *        提示复用既有词表键 wrDragNoUpload（改走 Ctrl+V / 上传按钮）
 *     2. 终端定格页：同上（自带依 SC.lang 的通用提示）
 *     3. 回放页（cast）：同上
 *     4. 会话回放页（session）：同上（homedir 夹具，仅同机拓扑）
 *     5. 文件分享页：同上
 *     6. collab 开时 live drop 仍进协作收件箱（守卫零注册，无双收口/双上传）
 *   断言照抄 share-writable.spec 的 overPrevented/dropPrevented 形态——只断言
 *   URL 会被合成 drop 的「本来就不可取消」假通过（评审必改3）。
 *   子服务端口经 /api/share/status 动态获取（默认主端口+2）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
// 直播页提示=既有词表键 wrDragNoUpload；其余四页=守卫自带通用串（双语）
const LIVE_TIP = /拖拽不发送文件|Dragging does not send files/
const GEN_TIP = /拖入的文件不会发送|Dropped files are not sent/
// 会话回放夹具（share-session-replay.spec 同款约定：标题带标记便于精确清理）
const SESSION_ID = 'e2e-drag-guard-sess01'
const FAKE_DIR_NAME = 'D--e2e-drag-guard-fixtures'

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

/** 审批/录制残留清场（cast 用例中途失败也不给后续 spec 留 pending 审批与
 *  录制窗口——share-cast-replay.spec 同款清场面） */
async function cleanupApprovals(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
  const apr = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const pending = ((await apr.json()) as { data?: Array<{ id: string; status: string }> }).data || []
  for (const a of pending.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
  const recs = await request.get(`${BASE}/api/recordings`, { headers })
  const rlist = ((await recs.json()) as { data?: Array<{ id: string }> }).data || []
  for (const r of rlist) {
    await request.delete(`${BASE}/api/recordings/${r.id}`, { headers })
  }
}

/** 开普通 shell 终端并回读会话 ID（访问页/快照源的共用前置） */
async function createShellTerminal(
  request: APIRequestContext,
  headers: Record<string, string>,
  tag: string,
): Promise<string> {
  const projectId = await getProjectId(request, headers)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers, data: { projectId, name: `e2e-dragguard-${tag}` },
  })
  expect(res.ok(), await res.text()).toBeTruthy()
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id
  if (!id) throw new Error('terminal id missing')
  return id
}

async function createShare(
  request: APIRequestContext,
  headers: Record<string, string>,
  endpoint: string,
  data: Record<string, unknown>,
): Promise<string> {
  const url = endpoint ? `${BASE}/api/share/${endpoint}` : `${BASE}/api/share`
  const res = await request.post(url, { headers, data })
  expect(res.ok(), await res.text()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token?: string } }).data?.token
  if (!token) throw new Error(`share token missing (${endpoint || 'file'})`)
  return token
}

/** 向会话写入标记并等 scrollback 可见（定格快照的内容源需先有内容） */
async function writeMarkerAndWait(
  request: APIRequestContext,
  headers: Record<string, string>,
  sessionId: string,
  marker: string,
): Promise<void> {
  const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data: `echo ${marker}\r` },
  })
  expect(wr.ok()).toBeTruthy()
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok() && (await res.text()).includes(marker)) return
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`marker ${marker} not in scrollback in time`)
}

/**
 * 核心断言（评审必改3）：合成含 Files 的拖放，dragover/drop 都必须被守卫
 * defaultPrevented（缺省导航已拦）且 URL 不变；守卫提示面 drag-tip 出文案。
 * 只断言 URL 不够——合成 drop 在无监听时本来就不可取消，假通过。
 */
async function assertDragGuard(page: Page, url: string, tip: RegExp): Promise<void> {
  await page.goto(url)
  await expect(page.locator('body')).toBeVisible()
  const urlBefore = page.url()
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
  await expect(page.getByTestId('drag-tip')).toContainText(tip, { timeout: 5_000 })
  expect(page.url(), 'drop must not navigate away from the share view').toBe(urlBefore)
}

/** 会话回放夹具播种（share-session-replay.spec 同款最小形态） */
function buildSessionFixture() {
  const dir = path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME)
  fs.mkdirSync(dir, { recursive: true })
  const at = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()
  const lines = [
    `{"type":"last-prompt","sessionId":"${SESSION_ID}"}`,
    JSON.stringify({
      parentUuid: null, isSidechain: false, type: 'user',
      message: { role: 'user', content: '[e2e-drag-guard] 守卫夹具' },
      timestamp: at(3), cwd: 'D:\\e2e-drag-guard-fixtures',
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: '夹具就绪' }] },
      timestamp: at(2),
    }),
  ]
  const file = path.join(dir, `${SESSION_ID}.jsonl`)
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
}

function cleanupSessionFixture() {
  try {
    fs.rmSync(path.join(os.homedir(), '.claude', 'projects', FAKE_DIR_NAME, `${SESSION_ID}.jsonl`), { force: true })
  } catch { /* 已清理/不可写忽略 */ }
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})
test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: Array<{ id: string; name: string }> }).data || []
  for (const s of list.filter(x => x.name.startsWith('e2e-dragguard-'))) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
  await cleanupApprovals(request, headers)
})

test('只读直播页（collab 关）：拖入文件 → dragover/drop 缺省导航被拦、URL 不变、提示改走 Ctrl+V', async ({ request, page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const sessionId = await createShellTerminal(request, headers, 'live')
  const token = await createShare(request, headers, 'terminal', { sessionId })
  await assertDragGuard(page, `${shareBase}/s/${token}`, LIVE_TIP)
})

test('终端定格页：拖入文件 → 缺省导航被拦、URL 不变、自带提示', async ({ request, page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const sessionId = await createShellTerminal(request, headers, 'frozen')
  await writeMarkerAndWait(request, headers, sessionId, 'DRAGGUARD_FROZEN_MARK')
  const token = await createShare(request, headers, 'terminal-frozen', { sessionId })
  await assertDragGuard(page, `${shareBase}/s/${token}`, GEN_TIP)
})

test('回放页（cast）：拖入文件 → 缺省导航被拦、URL 不变', async ({ request, page }) => {
  test.setTimeout(180_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  // 录制窗口由审批生命周期开启（无直开录制的端点，share-cast-replay 同链）
  expect((await request.put(`${BASE}/api/settings`, { headers, data: { approvalRecording: true } })).ok()).toBeTruthy()
  try {
    const sessionId = await createShellTerminal(request, headers, 'cast')
    const appr = await request.post(`${BASE}/api/ops-confirm`, {
      headers, data: { sessionId, op: 'reset --hard', target: 'main', detail: 'e2e drag guard cast share' },
    })
    expect(appr.ok()).toBeTruthy()
    const approvalId = ((await appr.json()) as { data?: { id?: string } }).data?.id || ''
    let recordingId = ''
    for (let i = 0; i < 40 && !recordingId; i++) {
      const res = await request.get(`${BASE}/api/recordings?approvalId=${approvalId}`, { headers })
      const list = ((await res.json()) as { data?: { id: string }[] }).data || []
      if (list.length) recordingId = list[0]!.id
      else await new Promise(r => setTimeout(r, 250))
    }
    expect(recordingId, 'recording should start on approval pending').toBeTruthy()
    const MARKER = 'DRAGGUARD_CAST_MARK'
    expect((await request.post(`${BASE}/api/terminals/broadcast-write`, {
      headers, data: { ids: [sessionId], data: `echo ${MARKER}\r` },
    })).ok()).toBeTruthy()
    for (let i = 0; i < 60; i++) {
      const res = await request.get(`${BASE}/api/recordings/${recordingId}/cast`, { headers })
      if (res.ok() && (await res.text()).includes(MARKER)) break
      await new Promise(r => setTimeout(r, 500))
    }
    const token = await createShare(request, headers, 'cast', { recordingId })
    await assertDragGuard(page, `${shareBase}/s/${token}`, GEN_TIP)
    // 清场：撤销审批录制（pending 审批 resolve 后录制窗口关闭，记录删除）
    await request.post(`${BASE}/api/ops-confirm/${approvalId}/resolve`, {
      headers, data: { allow: true, always: false },
    })
    await request.delete(`${BASE}/api/recordings/${recordingId}`, { headers })
  } finally {
    await request.put(`${BASE}/api/settings`, { headers, data: { approvalRecording: false } })
  }
})

test('会话回放页（session）：拖入文件 → 缺省导航被拦、URL 不变', async ({ request, page }) => {
  test.skip(serverIsRemote, '会话回放夹具在测试侧 homedir，跨拓扑服务端不可见——仅同机拓扑')
  test.setTimeout(90_000)
  buildSessionFixture()
  try {
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const token = await createShare(request, headers, 'session', { sessionId: SESSION_ID })
    await assertDragGuard(page, `${shareBase}/s/${token}`, GEN_TIP)
  } finally {
    cleanupSessionFixture()
  }
})

test('文件分享页：拖入文件 → 缺省导航被拦、URL 不变', async ({ request, page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const projectId = await getProjectId(request, headers)
  const rel = `e2e-dragguard-${Date.now()}.md`
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path: rel, content: '# drag guard e2e target\n' },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  try {
    const token = await createShare(request, headers, '', { projectId, path: rel })
    await assertDragGuard(page, `${shareBase}/s/${token}`, GEN_TIP)
  } finally {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: rel } })
  }
})

test('collab 开时 live drop 仍进协作收件箱（守卫零注册，无双收口/双上传）', async ({ request, page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const sessionId = await createShellTerminal(request, headers, 'collab')
  const token = await createShare(request, headers, 'terminal', { sessionId })
  expect((await request.post(`${BASE}/api/share/${token}/collab`, { headers, data: { collab: true } })).ok()).toBeTruthy()

  await page.goto(`${shareBase}/s/${token}`)
  // 协作位在场（cl-root-btn chip 形态）= 收件箱 drop 链已挂载
  await expect(page.getByTestId('cl-root-btn').or(page.getByTestId('cl-root'))).toBeVisible({ timeout: 10_000 })
  const urlBefore = page.url()
  const prevented = await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File([new TextEncoder().encode('collab drag body')], 'drag-inbox.txt', { type: 'text/plain' }))
    const drop = new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })
    document.body.dispatchEvent(drop)
    return drop.defaultPrevented
  })
  expect(prevented, 'collab inbox drop must still cancel the default navigation').toBe(true)
  expect(page.url()).toBe(urlBefore)
  // 归属证据：文件确实进了主人侧收件箱（守卫零注册 → 无双收口丢件/双上传）
  let names: string[] = []
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/share/${token}/drops`, { headers })
    const list = ((await res.json()) as { data?: Array<{ name: string }> }).data || []
    names = list.map(d => d.name)
    if (names.some(n => n.endsWith('.txt'))) break
    await new Promise(r => setTimeout(r, 300))
  }
  expect(names.some(n => n.endsWith('.txt')), `drag drop should land in the collab inbox, got ${names.join(',')}`).toBe(true)
})
