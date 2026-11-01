import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话身份与命名闭环（P-20261023-3）E2E：
 *   1. 同任务重复创建派生名自动步进「·2/·3」（先截断后去重——后缀叠加在
 *      「24 rune+省略号」上），服务端列表 derived 标记置位
 *   2. rename 重名响应附 duplicate 同名会话摘要警示（不阻断——显示名允许
 *      重名的既有语义不变，知情补全）；改名到独一名无 duplicate 键
 *   3. 命名系统注记注入：设置默认开可关；带 prompt 创建运行时会话时注记
 *      出现在启动命令尾部（scrollback 事实源），meta.initialPrompt 存原文
 *      （「重新发起」预填不被注记污染）
 *   4. 「新/接续」徽标与行内创建时间：24h 内创建且尚无命令活动的会话亮
 *      「新」；--resume 旗标创建亮「接续」（互斥不叠加）；创建时间短格式
 *      行内可见（同名会话第二区分维度）
 * 自备临时目录（agent 会话免项目绑定，dir 直传）；afterEach 清理全部终端
 * 会话。徽标/行内时间判据纯函数单测见 utils/sessionIdentity.test.ts
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-session-identity')
const PROJ_NAME = 'e2e-session-identity'
// 派生名夹具：首行超 24 rune（触发截断分支），三连建验证步进链
const LONG_PROMPT = '江西农商行-发现事件导出报告-月度对账单核对与差异分析任务'

let projectId = ''

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」，残留会话会污染步进链 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** API 建 agent 会话（显式命名/launchArgs 由用例给），返回创建响应 data */
async function createSession(
  request: APIRequestContext,
  body: Record<string, unknown>,
  lang?: string,
): Promise<{ id?: string; name?: string; [k: string]: unknown } | null> {
  const headers = await unlockHeaders(request)
  if (lang) headers['Accept-Language'] = lang
  const res = await request.post(`${API_BASE}/api/terminals`, { headers, data: body })
  const json = (await res.json()) as { data?: { id?: string; name?: string; [k: string]: unknown } }
  return json?.data ?? null
}

async function listSessions(request: APIRequestContext): Promise<{ id: string; name: string; kind: string; derived?: boolean; resumed?: boolean; initialPrompt?: string }[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: { id: string; name: string; kind: string; derived?: boolean; resumed?: boolean; initialPrompt?: string }[] }).data || []
}

/** prompt 首行派生名期望值（与 LaunchAgentSession 同规则：≤24 rune 截断加省略号） */
function expectedDerivedName(firstLine: string): string {
  const runes = [...firstLine]
  return runes.length > 24 ? runes.slice(0, 24).join('') + '…' : firstLine
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 残留项目清理 + 夹具目录重建
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 注册项目（docked 管理页的活动栏入口在项目路由 Layout 上）
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test('同任务重复创建：派生名自动步进「·2/·3」（先截断后去重），derived 置位', async ({ request }) => {
  // 三连建同一超长 prompt：截断产物（24 rune+省略号）作为基名，逐个步进
  const first = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), launchArgs: LONG_PROMPT })
  const second = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), launchArgs: LONG_PROMPT })
  const third = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), launchArgs: LONG_PROMPT })
  expect(first?.name, '创建全部成功').toBeTruthy()
  const base = expectedDerivedName(LONG_PROMPT)
  expect(first?.name).toBe(base)
  expect(second?.name).toBe(`${base}·2`)
  expect(third?.name).toBe(`${base}·3`)

  // 服务端列表：派生名会话 derived 置位（「新」徽标与命名来源数据面）
  const list = await listSessions(request)
  const mine = list.filter(s => s.kind === 'agent' && [first?.id, second?.id, third?.id].includes(s.id))
  expect(mine).toHaveLength(3)
  for (const s of mine) expect(s.derived, `derived 置位: ${s.name}`).toBe(true)
})

test('显式命名不受消歧影响；rename 重名响应附 duplicate 警示（不阻断）', async ({ request }) => {
  // 用户显式名不被步进（意图保留）——同名由 rename 警示面承接
  const a = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-A' })
  const b = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-B' })
  expect(a?.name).toBe('身份-A')
  expect(b?.name).toBe('身份-B')

  const headers = await unlockHeaders(request)

  // 改名撞既有名：200 不阻断，响应附 duplicate 同名摘要（含对方 id/名/创建时间）
  const res = await request.put(`${API_BASE}/api/terminals/${b!.id}/rename`, { headers, data: { name: '身份-A' } })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { message?: string; duplicate?: { id: string; name: string; createdAt: string }[] }
  expect(body.message).toBe('renamed')
  expect(body.duplicate?.map(d => d.id), 'duplicate 指向同名的 A').toContain(a!.id)
  expect(body.duplicate?.[0]?.name).toBe('身份-A')
  expect(body.duplicate?.[0]?.createdAt).toBeTruthy()

  // 改名到独一名：无 duplicate 键（缺 key = 无同名）
  const res2 = await request.put(`${API_BASE}/api/terminals/${b!.id}/rename`, { headers, data: { name: '独一无二的名称' } })
  const body2 = (await res2.json()) as { duplicate?: unknown }
  expect(body2.duplicate, '独一名不应带 duplicate').toBeUndefined()

  // 重名语义不变：两个同名会话并存（允许重名的既有契约）
  const list = await listSessions(request)
  const sameNamed = list.filter(s => s.kind === 'agent' && s.name === '身份-A')
  expect(sameNamed).toHaveLength(1) // b 已被上一步改走；A 独占其名
  expect(sameNamed[0]?.id).toBe(a!.id)
})

test('命名注记注入：设置默认开可关，注记随启动命令入 PTY，meta 存原文', async ({ request }) => {
  const headers = await unlockHeaders(request)

  // 默认开（未配置 = OrDefault true；升级兼容：旧配置缺键同形态）
  const settings = await (await request.get(`${API_BASE}/api/settings`, { headers })).json() as { data?: { agentNamingNoteEnabled?: boolean } }
  expect(settings.data?.agentNamingNoteEnabled).toBe(true)

  // 带 prompt 创建真实运行时会话（zh 头 = 中文注记）：响应 initialPrompt =
  // 原文（不含注记，「重新发起」预填干净），列表 derived 置位
  const prompt = '对当前目录做一次文件清单盘点'
  const created = await createSession(request, { kind: 'agent', runtime: 'claude', dir: serverPath(REPO_DIR), launchArgs: prompt }, 'zh-CN')
  expect(created?.id, 'claude 会话创建成功（预检通过）').toBeTruthy()
  expect(created?.initialPrompt).toBe(prompt)
  const list = await listSessions(request)
  const mine = list.find(s => s.id === created?.id)
  expect(mine?.derived).toBe(true)
  expect(mine?.resumed, 'prompt 形态非旗标，resumed 不置位').toBeFalsy()

  // 注记随启动命令进入 PTY（scrollback 事实源，裸字节契约）：注记在 prompt 尾部
  await expect.poll(async () => {
    const res = await request.get(`${API_BASE}/api/terminals/${created!.id}/scrollback`, { headers })
    return (await res.body()).toString('utf-8')
  }, { timeout: 30000, message: 'scrollback 应出现注入的命名注记' }).toContain('[系统注记]')
  const scroll = await (await request.get(`${API_BASE}/api/terminals/${created!.id}/scrollback`, { headers })).body()
  expect(scroll.toString('utf-8')).toContain('$CC_TERMINAL_ID')

  // 设置可关：写入 false 读回 false（注入门控的单测守门见
  // TestWithAgentNamingNote——e2e 只守设置面读写回路）
  await request.put(`${API_BASE}/api/settings`, { headers, data: { agentNamingNoteEnabled: false } })
  const after = await (await request.get(`${API_BASE}/api/settings`, { headers })).json() as { data?: { agentNamingNoteEnabled?: boolean } }
  expect(after.data?.agentNamingNoteEnabled).toBe(false)
  // 还原环境默认（本 spec 对全局设置的清洁纪律）
  await request.put(`${API_BASE}/api/settings`, { headers, data: { agentNamingNoteEnabled: true } })
})

test('恢复旗标创建 resumed 置位（「接续」徽标数据面）', async ({ request }) => {
  const created = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-接续', launchArgs: '--resume fake-session-uuid' })
  expect(created?.id).toBeTruthy()
  const list = await listSessions(request)
  const mine = list.find(s => s.id === created?.id)
  expect(mine?.resumed, '旗标形态 launchArgs → resumed 置位').toBe(true)
  expect(mine?.derived, '显式命名非派生').toBeFalsy()
})

// ============== UI：新/接续徽标 + 行内创建时间 ==============

/** 进项目页并打开 docked 管理页（活动栏入口在项目路由 Layout，agent-session-name 同款） */
async function openAgentDocked(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

test('侧栏行内时间可见；新会话亮「新」徽标、恢复会话亮「接续」徽标（互斥）', async ({ page, request }) => {
  // 占位会话先建（点选它做附着面——活动时间只进被附着会话，「新」判据的
  // hasActivity 不被污染）；接续会话带 --resume 旗标
  const dummy = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-占位' })
  const resumed = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-接续', launchArgs: '--resume fake-session-uuid' })
  expect(dummy?.id && resumed?.id).toBeTruthy()

  const view = await openAgentDocked(page)
  const rowOf = (name: string) => view.locator('.ats-item').filter({ hasText: name })

  // 行内创建时间（P-20261023-3）：今天创建 → HH:mm 弱灰短格式
  await expect(rowOf('身份-占位')).toBeVisible({ timeout: 15000 })
  await expect(rowOf('身份-占位').locator('[data-test="session-created-time"]')).toHaveText(/\d{2}:\d{2}/)

  // 占位会话点选为附着面：其 PTY 活动不再污染「新」判据的未用语义
  await rowOf('身份-占位').click()
  await page.waitForTimeout(1200)

  // 占位会话有过 OSC 活动后不亮「新」；接续会话亮「接续」不亮「新」
  //（创建响应先行 + meta 落库快照对账——改名触发一次广播保证 meta 已落）
  const headers = await unlockHeaders(request)
  await request.put(`${API_BASE}/api/terminals/${resumed!.id}/rename`, { headers, data: { name: '身份-接续' } })
  await expect(rowOf('身份-接续').locator('[data-test="session-resumed-badge"]')).toBeVisible({ timeout: 15000 })
  await expect(rowOf('身份-接续').locator('[data-test="session-new-badge"]')).toHaveCount(0)

  // 新会话在附着面稳定后创建：从未附着 → 无 OSC 活动 → 亮「新」+ 行内时间
  const fresh = await createSession(request, { kind: 'agent', runtime: 'shell', dir: serverPath(REPO_DIR), name: '身份-新会话' })
  expect(fresh?.id).toBeTruthy()
  const freshRow = rowOf('身份-新会话')
  await expect(freshRow).toBeVisible({ timeout: 15000 })
  await expect(freshRow.locator('[data-test="session-new-badge"]')).toBeVisible({ timeout: 15000 })
  await expect(freshRow.locator('[data-test="session-new-badge"]')).toHaveText(/^新$/)
  await expect(freshRow.locator('[data-test="session-created-time"]')).toHaveText(/\d{2}:\d{2}/)
  // 「新」与「接续」互斥不叠加
  await expect(freshRow.locator('[data-test="session-resumed-badge"]')).toHaveCount(0)
})
