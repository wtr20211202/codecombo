import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编队成组与进度聚合（P-20261005-145）E2E——舰队编排「发起后追踪」的另一半：
 *   1. API 面：bulk-agent 响应携带 fleetBatch（batchId+发起时间+成员花名册）→
 *      GET /api/terminals?fleet=<batchId> 按批过滤（元数据过滤，unknown 批空列表），
 *      会话快照各成员携带同值 fleetBatch（agent 编程追踪的数据面）
 *   2. UI 面：两项目 bulk 发起 → 值班大屏聚合卡「0 成功 · 0 失败 · 2 运行中」→
 *      逐个上报终态（ops-notify 真实链）→ 计数随动 1/0/1 → 1/1/0 + 失败红边 →
 *      通知中心单条「编队完成：1 成功 1 失败」（批级聚合去重，不逐成员刷屏）→
 *      点击直达 /monitor?fleet=<batchId>，聚合卡高亮+自动展开成员行
 * runtime 显式纯终端（shell 一等选项）保证创建确定性；终态由 /api/ops-notify
 * 注入（与 monitor-task-stale 同款真实 WS 链路）；夹具与清理沿用 fleet-bulk-agent
 */

const REPO_DIR_A = path.join(os.tmpdir(), 'sc-e2e-fleetbt-a')
const REPO_DIR_B = path.join(os.tmpdir(), 'sc-e2e-fleetbt-b')
const PROJ_A = 'e2e-fleetbt-alpha'
const PROJ_B = 'e2e-fleetbt-beta'
const PROMPT = '聚合追踪 e2e'

let projAId = ''
let projBId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」，残留会话会污染聚合卡 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

async function findProjectId(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const body = (await res.json()) as { data?: { id: string; name: string }[] }
  return body.data?.find(p => p.name === name)?.id || ''
}

async function createRepoWithProject(
  request: APIRequestContext,
  repoDir: string,
  projName: string,
): Promise<string> {
  const headers = await unlockHeaders(request)
  const stale = await findProjectId(request, projName)
  if (stale) await fetch(`${API_BASE}/api/projects/${stale}`, { method: 'DELETE', headers })
  try { fs.rmSync(repoDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(repoDir, { recursive: true })
  git(repoDir, ['init'])
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${projName}\n`)
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-m', `c1: init ${projName}`])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: projName, path: serverPath(repoDir) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async ({ request }) => {
  projAId = await createRepoWithProject(request, REPO_DIR_A, PROJ_A)
  projBId = await createRepoWithProject(request, REPO_DIR_B, PROJ_B)
  expect(projAId).toBeTruthy()
  expect(projBId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  for (const id of [projAId, projBId]) {
    if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR_A, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(REPO_DIR_B, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 清理通知中心（服务端持久面）：通知跨 spec 重跑/重试累积，会让「单条批级
 *  通知」的计数断言在非首跑必假败——每用例前置清空保证确定性 */
async function cleanupNotifications(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupNotifications(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupNotifications(request)
})

interface BulkBody {
  data?: {
    created: Array<{ projectId: string; terminalId: string; name: string }>
    skipped: Array<{ projectId: string; reason: string }>
    fleetBatch: { batchId: string; launchedAt: string; members: string[] }
  }
}

/** 两项目编队发起（shell 一等选项，确定性创建），返回响应 data 段 */
async function launchFleet(request: APIRequestContext): Promise<NonNullable<BulkBody['data']>> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/terminals/bulk-agent`, {
    headers,
    data: { projectIds: [projAId, projBId], runtime: 'shell', prompt: PROMPT },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as BulkBody
  expect(body.data?.created).toHaveLength(2)
  return body.data!
}

/** task.progress 上报（真实链路：ops-notify → ops-channel WS → assistantTask store） */
async function reportProgress(
  request: APIRequestContext,
  headers: Record<string, string>,
  terminalId: string,
  status: string,
): Promise<void> {
  const res = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: PROMPT, status, terminalId } },
  })
  expect(res.ok()).toBeTruthy()
}

test('API：bulk 响应带 fleetBatch + ?fleet= 按批过滤 + 快照携带批元数据', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const data = await launchFleet(request)
  const batch = data.fleetBatch
  expect(batch.batchId).toMatch(/^fleet-/)
  expect(batch.launchedAt).toBeTruthy()
  // 花名册 = 已创建成员（创建序）；跳过项从未成为会话不入册（本批无跳过）
  expect(batch.members).toEqual(data.created.map(c => c.terminalId))

  // ?fleet=<batchId> 按批过滤：恰为两名成员，快照各条目携带同值 fleetBatch
  const res = await request.get(`${API_BASE}/api/terminals?fleet=${encodeURIComponent(batch.batchId)}`, { headers })
  expect(res.ok()).toBeTruthy()
  const list = ((await res.json()) as { data?: Array<{ id: string; fleetBatch?: { batchId: string; members: string[] } }> }).data || []
  expect(list.map(s => s.id).sort()).toEqual([...batch.members].sort())
  for (const s of list) {
    expect(s.fleetBatch?.batchId).toBe(batch.batchId)
    expect(s.fleetBatch?.members).toEqual(batch.members)
  }

  // 未知批/非编队 → 空列表（非错误；agent 轮询收敛判定的合法空态）
  const miss = await request.get(`${API_BASE}/api/terminals?fleet=fleet-e2e-unknown`, { headers })
  expect(((await miss.json()) as { data?: unknown[] }).data).toHaveLength(0)
})

test('UI：两项目发起 → 大屏聚合卡 0/0/2 → 逐个终态 1/0/1 → 1/1/0 失败高亮 → 通知一条含计数直达高亮', async ({ page, request }) => {
  // 长链路用例（大屏两轮计数随动 + 项目页通知中心 + 直达回大屏）——默认 30s
  // 不够，长 spec 提额惯例（pull-summary-notify 同款）
  test.setTimeout(90000)
  const headers = await unlockHeaders(request)
  const data = await launchFleet(request)
  const batch = data.fleetBatch
  const [memberA, memberB] = batch.members

  // 大屏聚合卡：发起后即看（快照 meta 反查带 fleetBatch），计数 0/0/2
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  await expect(page.locator('.mon-root')).toBeVisible()
  const card = page.locator(`[data-testid="fleet-card-${batch.batchId}"]`)
  await expect(card).toBeVisible({ timeout: 15000 })
  const counts = card.locator('[data-testid="fleet-card-counts"]')
  await expect(counts).toHaveText('0 成功 · 0 失败 · 2 运行中')
  await expect(card).not.toHaveClass(/is-failed/)

  // 成员 A 完成：计数随动 1/0/1（WS task.progress → bySession → 聚合重算）
  await reportProgress(request, headers, memberA!, 'done')
  await expect(counts).toHaveText('1 成功 · 0 失败 · 1 运行中', { timeout: 10000 })

  // 展开成员行：roster 全量（两名成员，A 已完成）
  await card.click()
  const members = card.locator('[data-testid="fleet-members"]')
  await expect(members).toBeVisible()
  await expect(members.locator('.mon-fleet-member')).toHaveCount(2)
  await expect(members).toContainText('已完成')

  // 成员 B 失败：1/1/0 + 失败红边 + 失败成员行红名；App 根批级观察入账通知
  await reportProgress(request, headers, memberB!, 'failed')
  await expect(counts).toHaveText('1 成功 · 1 失败 · 0 运行中', { timeout: 10000 })
  await expect(card).toHaveClass(/is-failed/)

  // 通知中心：批级单条「编队完成：1 成功 1 失败」（不逐成员刷屏；任务卡等既有
  // 逐会话通知不进本断言面）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.ide-header button[title="通知中心"]').click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  const batchEntry = page.locator('.nc-item').filter({ hasText: '编队完成：1 成功 1 失败' })
  await expect(batchEntry).toHaveCount(1, { timeout: 10000 })

  // 点击直达：/monitor?fleet=<batchId>，聚合卡高亮 + 自动展开成员行
  //（RegExp 而非 glob——URL 模板里 ? 在 glob 语义是单字符通配，易误匹配）
  await batchEntry.click()
  await page.waitForURL(new RegExp(`/monitor\\?fleet=${batch.batchId}$`))
  const cardAgain = page.locator(`[data-testid="fleet-card-${batch.batchId}"]`)
  await expect(cardAgain).toBeVisible({ timeout: 15000 })
  await expect(cardAgain).toHaveClass(/is-highlight/, { timeout: 10000 })
  await expect(cardAgain.locator('[data-testid="fleet-members"]')).toBeVisible()
  await expect(cardAgain).toContainText('失败')
})
