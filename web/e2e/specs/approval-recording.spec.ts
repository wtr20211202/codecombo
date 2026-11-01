import { execSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 审批窗口过程实况录制（P-20261001-15）：
 * 1. API 全链路：开启设置开关 → ops-confirm 产生 → 对应会话开录（recordings
 *    索引 status=recording + cast 为 asciinema v2）→ resolve 后缓冲洗停
 *    （completed + stoppedAt）
 * 2. 隐私边界：开关默认关，审批不产生任何录制
 * 3. UI 入口：审批卡「查看过程实况」→ 浏览器模态（列表选中焦点审批的录制
 *    + 回放器 xterm 渲染）
 *
 * 满种方式对齐 approval-jump.spec 审批用例（API 造 pending → 全局卡片）；
 * 会话创建走 API（纯终端 runtime，不拉起 claude TUI）；afterEach 清账防残留。
 * 本文件为 P-15 新建用例文件，不改既有 spec（与并行播种改造避文件冲突）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

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

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清理 pending 审批 + 全部录制 + 开关复位关闭 */
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

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovalsAndRecordings(request)
})

// afterEach 清账：本 spec 会留 pending 审批/终端会话/录制/开关开启态——
// monitor-dashboard 的「机群空闲空态」断言对遗留 pending 敏感（卡片墙非空
// 即挂），跑在其前时必须还原干净面
test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovalsAndRecordings(request)
})

/** 建纯终端会话（agent runtime=shell），返回会话 id */
async function createShellSession(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const dir = await mkdtemp(path.join(tmpdir(), 'sc-appr-rec-'))
  const created = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name, runtime: 'shell', dir: serverPath(dir) },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[])
    .find(s => s.name === name)
  expect(session).toBeTruthy()
  return session!.id
}

test('审批窗口录制联动：pending 开录 → cast v2 → resolved 缓冲洗停', async ({ request }) => {
  test.setTimeout(90000) // 裁决后 10s 缓冲窗口 + 轮询余量
  const headers = await unlockHeaders(request)
  await setRecording(request, true)

  const sessionId = await createShellSession(request, 'appr-rec-agent')
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId, op: 'reset --hard', target: 'main', detail: 'e2e 录制联动验证' },
  })
  expect(appr.ok()).toBeTruthy()
  const approvalId = (((await appr.json()) as { data?: { id?: string } }).data?.id) || ''

  // 窗口开启：索引可见且状态 recording，会话归属正确
  let meta: { id: string; status: string; sessionId: string; approvalIds: string[] } | undefined
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/recordings?approvalId=${approvalId}`, { headers })
    const list = ((await res.json()) as { data?: typeof meta[] }).data || []
    if (list.length === 1) { meta = list[0]; break }
    await new Promise(r => setTimeout(r, 250))
  }
  expect(meta, 'recording should start on approval pending').toBeTruthy()
  expect(meta!.status).toBe('recording')
  expect(meta!.sessionId).toBe(sessionId)

  // cast 为 asciinema v2（header 行 version:2）
  const castRes = await request.get(`${BASE}/api/recordings/${meta!.id}/cast`, { headers })
  expect(castRes.ok()).toBeTruthy()
  const castText = (await castRes.body()).toString('utf-8')
  const headerLine = castText.split('\n')[0] || ''
  expect(JSON.parse(headerLine)).toMatchObject({ version: 2 })

  // 裁决 → 缓冲窗口内仍 recording → 冲停后 completed + 止时落库
  const resolve = await request.post(`${BASE}/api/ops-confirm/${approvalId}/resolve`, {
    headers, data: { allow: true, always: false },
  })
  expect(resolve.ok()).toBeTruthy()

  let done: { status: string; stoppedAt?: string; sizeBytes: number } | undefined
  for (let i = 0; i < 120; i++) {
    const res = await request.get(`${BASE}/api/recordings/${meta!.id}`, { headers })
    const cur = ((await res.json()) as { data?: typeof done }).data
    if (cur?.status === 'completed') { done = cur; break }
    await new Promise(r => setTimeout(r, 250))
  }
  expect(done, 'recording should stop after grace window').toBeTruthy()
  expect(done!.stoppedAt).toBeTruthy()
  expect(done!.sizeBytes).toBeGreaterThan(0)
})

test('隐私边界：开关默认关，审批不产生录制', async ({ request }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders(request)
  // beforeEach 已复位为 false：默认关直接验证
  const state = (await (await request.get(`${BASE}/api/settings`, { headers })).json()) as {
    data?: { approvalRecording?: boolean }
  }
  expect(state.data?.approvalRecording).toBe(false)

  const sessionId = await createShellSession(request, 'appr-rec-off')
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId, op: 'delete file', target: 'tmp.txt', detail: 'e2e 默认关验证' },
  })
  expect(appr.ok()).toBeTruthy()

  // 窗口期与裁决后均无录制产生
  const approvalId = (((await appr.json()) as { data?: { id?: string } }).data?.id) || ''
  await request.post(`${BASE}/api/ops-confirm/${approvalId}/resolve`, {
    headers, data: { allow: true, always: false },
  })
  await new Promise(r => setTimeout(r, 1500))
  const res = await request.get(`${BASE}/api/recordings?approvalId=${approvalId}`, { headers })
  expect(((await res.json()) as { data?: unknown[] }).data || []).toHaveLength(0)
})

test('审批卡「查看过程实况」→ 浏览器模态 + 回放器渲染', async ({ page, request }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await setRecording(request, true)

  // 先开页面再造审批（卡片靠 approval.pending 广播出现，与 approval-jump 同序）
  await gotoAndUnlock(page, '/')

  const sessionId = await createShellSession(request, 'appr-rec-ui')
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId, op: 'push --force-with-lease', target: 'main', detail: 'e2e 实况入口验证' },
  })
  expect(appr.ok()).toBeTruthy()
  const approvalId = (((await appr.json()) as { data?: { id?: string } }).data?.id) || ''

  // 等窗口录制落盘（有内容可回放）
  await expect.poll(async () => {
    const res = await request.get(`${BASE}/api/recordings?approvalId=${approvalId}`, { headers })
    return (((await res.json()) as { data?: unknown[] }).data || []).length
  }, { timeout: 15000 }).toBe(1)

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('push --force-with-lease')

  // 卡片入口 → 浏览器模态：列表焦点选中 + 回放器 xterm 渲染
  await card.getByRole('button', { name: '查看过程实况' }).click()
  const modal = page.locator('.rb-modal')
  await expect(modal).toBeVisible({ timeout: 10000 })
  await expect(modal.locator('.rb-item')).toHaveCount(1, { timeout: 10000 })
  await expect(modal.locator('.rb-item').first()).toContainText('录制中')
  await expect(modal.locator('.cr-screen .xterm').first()).toBeVisible({ timeout: 15000 })
  await expect(modal.locator('.cr-toolbar')).toContainText('1×')

  // 播放控制可用：点播放立即切暂停文案（回放引擎在走）
  await modal.getByRole('button', { name: '播放' }).click()
  await expect(modal.getByRole('button', { name: '暂停' }).first()).toBeVisible({ timeout: 5000 })

  await modal.locator('.rb-main-head').getByRole('button', { name: '关闭' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})
