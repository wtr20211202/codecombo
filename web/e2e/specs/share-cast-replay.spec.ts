import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 会话回放分享（P-20261004-103）E2E：
 *   1. API 全链路：开启审批录制 → 录制窗口产出 cast → POST /api/share/cast
 *      （kind=cast、默认 1 小时 TTL、recordingId 锚点）→ 访客回放页形态
 *      （xterm + /cast 取数、无 SSE 接线）→ /cast 净本可见（事件文本 + v2
 *      header）→ 附件下载 → 撤销 → 页面与 /cast 立即失效
 *   2. UI 入口：审批卡「查看过程实况」→ 实况浏览器列表项「分享回放」→
 *      结果卡 + 管理列表「回放」徽标；终端 tab 右键「分享回放」入口可见
 *   录制由审批窗口自动开启（设置默认关），用例自带开关复位/清场
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setRecording(request: APIRequestContext, enabled: boolean): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.put(`${BASE}/api/settings`, {
    headers, data: { approvalRecording: enabled },
  })
  expect(res.ok()).toBeTruthy()
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

async function cleanupApprovalsAndRecordings(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
  const recs = await request.get(`${BASE}/api/recordings`, { headers })
  const rlist = ((await recs.json()) as { data?: { id: string }[] }).data || []
  for (const r of rlist) {
    await request.delete(`${BASE}/api/recordings/${r.id}`, { headers })
  }
  await setRecording(request, false)
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

/** 当前全部终端会话 id（UI 新建终端后按差集定位新会话） */
async function listTerminalIds(request: APIRequestContext): Promise<Set<string>> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  return new Set(list.map(s => s.id))
}

/** 等 UI 新建终端落库：返回不在 before 集里的新会话 id */
async function waitForNewTerminal(request: APIRequestContext, before: Set<string>): Promise<string> {
  for (let i = 0; i < 40; i++) {
    const now = await listTerminalIds(request)
    for (const id of now) {
      if (!before.has(id)) return id
    }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('new terminal session not found')
}

/** 建项目 shell 终端会话（kind=shell，会经 terminals.changed 出现在底部 tab），返回会话 id */
async function createShellSession(request: APIRequestContext, projectId: string, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { projectId, name },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === name)
  expect(session).toBeTruthy()
  return session!.id
}

/** 触发一次审批 → 对应录制窗口开启；返回审批 id 与录制 id */
async function startRecording(request: APIRequestContext, sessionId: string): Promise<{ approvalId: string; recordingId: string }> {
  const headers = await unlockHeaders(request)
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId, op: 'reset --hard', target: 'main', detail: 'e2e 回放分享验证' },
  })
  expect(appr.ok()).toBeTruthy()
  const approvalId = (((await appr.json()) as { data?: { id?: string } }).data?.id) || ''

  let recordingId = ''
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/recordings?approvalId=${approvalId}`, { headers })
    const list = ((await res.json()) as { data?: { id: string }[] }).data || []
    if (list.length === 1) { recordingId = list[0]!.id; break }
    await new Promise(r => setTimeout(r, 250))
  }
  expect(recordingId, 'recording should start on approval pending').toBeTruthy()
  return { approvalId, recordingId }
}

/** 向会话写入标记并等 cast 落盘可读（录制中即可分享——创建时快照定格） */
async function writeMarkerAndWait(request: APIRequestContext, sessionId: string, recordingId: string, marker: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data: `echo ${marker}\r` },
  })
  expect(wr.ok()).toBeTruthy()
  for (let i = 0; i < 60; i++) {
    const res = await request.get(`${BASE}/api/recordings/${recordingId}/cast`, { headers })
    if (res.ok() && (await res.text()).includes(marker)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`marker ${marker} not in cast in time`)
}

/** 确保底部终端面板打开：rail-terminal 是 togglePanel 语义（点击 = 开↔关）——
 *  分享管理/其他主区视图打开后盲目点击可能把已开面板关掉，先看可见性再点 */
async function ensureTerminalPanel(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 15_000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
  await cleanupTerminals(request)
  await cleanupApprovalsAndRecordings(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  await cleanupTerminals(request)
  await cleanupApprovalsAndRecordings(request)
})

test('API 全链路：录制 → 分享回放 → 访客页可见 → 附件下载 → 撤销断链', async ({ request, page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const shareBase = await getShareBase(request, headers)
  await setRecording(request, true)

  const sessionId = await createShellSession(request, projectId, 'e2e-cast-api')

  const { recordingId } = await startRecording(request, sessionId)
  const MARKER = 'CAST_E2E_MARKER'
  await writeMarkerAndWait(request, sessionId, recordingId, MARKER)

  // 创建分享：kind=cast、recordingId 锚点、默认 ~1 小时 TTL
  const created = await request.post(`${BASE}/api/share/cast`, { headers, data: { recordingId } })
  expect(created.ok()).toBeTruthy()
  const body = (await created.json()) as {
    data?: { token: string; kind: string; recordingId: string; terminalId: string; size: number; expiresAt: string }
    warnings?: string[]
  }
  const share = body.data
  expect(share?.kind).toBe('cast')
  expect(share?.recordingId).toBe(recordingId)
  expect(share?.terminalId).toBe(sessionId)
  expect(share?.size).toBeGreaterThan(0)
  const remain = new Date(share!.expiresAt).getTime() - Date.now()
  expect(remain).toBeGreaterThan(59 * 60_000)
  expect(remain).toBeLessThanOrEqual(61 * 60_000)

  // 访客回放页：xterm + /cast 取数；无 SSE 接线（异步回放不是直播）
  const pageResp = await request.get(`${shareBase}/s/${share!.token}`)
  expect(pageResp.status()).toBe(200)
  const html = await pageResp.text()
  expect(html).toContain('/assets/xterm.js')
  expect(html).toContain('/cast')
  expect(html).toMatch(/REPLAY|回放/)
  expect(html).not.toContain('EventSource')
  expect(html).not.toContain('/stream')

  // 浏览器实跑回放页：解析事件 → 自动播放至完成（data-cast-* 是页面自报的
  // 回放引擎状态；xterm 画布内容不可直接断言，事件数与完成态证明「播放可见」）
  await page.goto(`${shareBase}/s/${share!.token}`)
  await expect(page.locator('body')).toHaveAttribute('data-cast-ready', '1', { timeout: 20_000 })
  await expect(page.locator('body')).toHaveAttribute('data-cast-done', '1', { timeout: 20_000 })
  const eventCount = Number(await page.locator('body').getAttribute('data-cast-events'))
  expect(eventCount).toBeGreaterThan(0)

  // /cast 净本：asciinema v2 header + 录制标记可见
  const cast = await request.get(`${shareBase}/s/${share!.token}/cast`)
  expect(cast.ok()).toBeTruthy()
  expect(cast.headers()['content-type']).toContain('text/plain')
  const castText = await cast.text()
  expect(JSON.parse(castText.split('\n')[0] || '{}')).toMatchObject({ version: 2 })
  expect(castText).toContain(MARKER)

  // 附件下载（导出 cast 交外部播放器）
  const dl = await request.get(`${shareBase}/s/${share!.token}/cast?dl=1`)
  expect(dl.ok()).toBeTruthy()
  expect(dl.headers()['content-disposition']).toContain('attachment')

  // meta：kind=cast 投影
  const meta = await request.get(`${shareBase}/s/${share!.token}/meta`)
  expect(meta.ok()).toBeTruthy()
  expect(await meta.text()).toContain('"kind":"cast"')

  // 撤销 → 页面与 /cast 立即失效（快照随撤销删除）
  const del = await request.delete(`${BASE}/api/share/${share!.token}`, { headers })
  expect(del.ok()).toBeTruthy()
  expect((await request.get(`${shareBase}/s/${share!.token}`)).status()).toBe(404)
  expect((await request.get(`${shareBase}/s/${share!.token}/cast`)).status()).toBe(404)
})

test('UI 入口：实况列表「分享回放」→ 结果卡/管理徽标；终端 tab 右键入口可见', async ({ page, request }) => {
  test.setTimeout(180_000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await setRecording(request, true)

  // 先开项目页再开审批（卡片靠 approval.pending 广播出现，与 approval-recording
  // 同序；项目页上下文也是后续「管理全部分享」跳转的落点）
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // 终端 tab 必须真实存在才可验证右键入口：经 UI 新建终端（terminals.changed
  // 对账追加 tab），再按 API 会话列表差集定位其 session id（tab 名保持可辨识）
  await ensureTerminalPanel(page)
  const before = await listTerminalIds(request)
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  const uiTab = page.locator('.term-tab').last()
  await expect(uiTab).toBeVisible({ timeout: 15_000 })
  const uiTabName = ((await uiTab.textContent()) || '').trim()
  expect(uiTabName.length).toBeGreaterThan(0)
  const sessionId = await waitForNewTerminal(request, before)

  const { approvalId, recordingId } = await startRecording(request, sessionId)
  await writeMarkerAndWait(request, sessionId, recordingId, 'CAST_UI_MARKER')

  // 审批卡入口 → 实况浏览器：列表项「分享回放」→ 结果卡
  const card = page.locator('.aprv-card').filter({ hasText: 'reset --hard' }).first()
  await expect(card).toBeVisible({ timeout: 20_000 })
  await card.getByRole('button', { name: '查看过程实况' }).click()
  const modal = page.locator('.rb-modal')
  await expect(modal).toBeVisible({ timeout: 10_000 })
  await expect(modal.locator('.rb-item')).toHaveCount(1, { timeout: 10_000 })
  await modal.locator('.rb-item').first().getByTestId('recording-share').click()

  const dialog = page.locator('.share-result-modal')
  await expect(dialog).toBeVisible({ timeout: 20_000 })
  await expect(dialog).toContainText('回放')
  // 先关结果卡与实况弹层，再从主区导航进分享管理（避免叠层遮挡后续交互）。
  // 结果卡底部按钮与右下角审批卡堆同锚点：本用例为录制而挂着 pending 审批卡
  // （裁决面 z3000 优先于弹层，产品既有语义），底部「关闭」会被动「最近裁决」
  // 条拦截——改用头部 ×（关闭语义不变，仍断言卡片确实收起）
  await dialog.locator('.n-base-close').click()
  await expect(dialog).toBeHidden({ timeout: 5000 })
  await modal.locator('.rb-main-head').getByRole('button', { name: '关闭' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.share-manager')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-testid="sm-cast-badge"]').first()).toBeVisible({ timeout: 20_000 })

  // 终端 tab 右键「分享回放」入口可见（该会话已有录制）。主区此时是分享管理，
  // 底部终端面板可能仍开着（rail-terminal 是 toggle，盲目点击会关掉它）——
  // 先探测可见性，必要时才点开
  await ensureTerminalPanel(page)
  const tab = page.locator('.term-tab').filter({ hasText: uiTabName }).first()
  await expect(tab).toBeVisible({ timeout: 20_000 })
  await tab.click({ button: 'right' })
  await expect(page.locator('[data-testid="terminal-replay-share"]')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="terminal-replay-share"]')).toContainText('分享回放')
  await page.keyboard.press('Escape')

  // 清洁收尾：解析审批让录制窗口收尾（afterEach 兜底）
  await request.post(`${BASE}/api/ops-confirm/${approvalId}/resolve`, {
    headers, data: { allow: true, always: false },
  })
})
