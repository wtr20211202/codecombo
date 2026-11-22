import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * frontend 动词族设备定向 e2e（P-20261117-4）：设备效应原语（frontend.download）
 * 的「单一浏览器效应」语义落地——
 *   1. 会话绑定定向：会话创建携 X-Browser-Id 初绑 → frontend.download 按
 *      X-Session-ID 路由到发起浏览器，另一浏览器零效应（用户实测主诉收口）；
 *   2. 同浏览器双标签单效应：定向广播对本浏览器全部标签送达，标签选举
 *      （Web Locks leader）裁决唯一执行标签——两标签合计恰一次 anchor 点击
 *      （选举烟测口径，不深断言时序防 CI 抖）；
 *   3. 多浏览器并存且无绑定 → 不广播设备效应，降级 notify.persist 通知化
 *      （两浏览器都收到降级弹面——通知是注意力面保持全广播；下载条目带
 *      download 动作复合载荷，点击触发既有下载链）；
 *   4. 绑定浏览器离线（他浏览器在场）→ 降级 offline 档，零效应；
 *   5. 注意力类事件全广播不回归哨兵：notify toast 两浏览器同达（定向不越族）；
 *   6. 降级通知静音档：任务类别静音命中 → 降级全链吞没（零入账零弹面，
 *      响应仍 200——既有静音语义随行）。
 * 单浏览器既有回归（启发式定向=旧行为等价面）由 ops-frontend-atoms.spec.ts
 * 原样承担（该 spec 全部用例无 X-Session-ID 上报，现走单浏览器启发式定向路径）。
 * 夹具项目/会话 spec 内自备/自清，不残留测试数据。
 */

const PROJ_NAME = 'e2e-ops-frontend-targeting'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-ops-frontend-targeting')
const REPORT_REL = 'reports/targeting-report.md'
const REPORT_NAME = 'targeting-report.md'
const REPORT_BODY = '# targeting report\n\ngenerated for frontend targeting e2e\n'
const SESSION_PREFIX = 'e2e-targeting-anchor'

// 页内点击计数器（context 级 localStorage 共享单键 = 本浏览器效应合账；
// sessionStorage 附 per-tab 执行日志供「合计恰一次」断言；spy 形态与
// ops-frontend-atoms.spec.ts spyAnchorClicks 同款：记录并原样放行真实点击）
const CLICK_COUNTER_INIT = `
  localStorage.setItem('__scTgtClicks', localStorage.getItem('__scTgtClicks') || '0')
  const proto = HTMLAnchorElement.prototype
  const orig = proto.click
  proto.click = function () {
    localStorage.setItem('__scTgtClicks', String(Number(localStorage.getItem('__scTgtClicks') || '0') + 1))
    const log = JSON.parse(sessionStorage.getItem('__scTgtLog') || '[]')
    log.push(Date.now())
    sessionStorage.setItem('__scTgtLog', JSON.stringify(log))
    return orig.call(this)
  }
`

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function lookupProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  return list.find(p => p.name === PROJ_NAME)?.id || ''
}

async function postAtom(request: APIRequestContext, headers: Record<string, string>, type: string, payload: unknown, sessionId?: string) {
  const h = { ...headers }
  if (sessionId) h['X-Session-ID'] = sessionId
  return request.post(`${API_BASE}/api/ops-notify`, { headers: h, data: { type, payload } })
}

async function createBoundSession(request: APIRequestContext, headers: Record<string, string>, browserId: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers: { ...headers, 'X-Browser-Id': browserId },
    data: { kind: 'agent', runtime: 'shell', name: SESSION_PREFIX, launchArgs: '设备定向夹具会话（可随时关闭）' },
  })
  expect(res.ok()).toBeTruthy()
  const id = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(id).not.toBe('')
  return id
}

async function cleanupSessions(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id?: string; name?: string }[] }).data || []
  for (const s of list) {
    if (s.name?.includes(SESSION_PREFIX) && s.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
    }
  }
}

async function readBrowserId(page: Page): Promise<string> {
  const id = await page.evaluate(() => localStorage.getItem('sc.ops.browserId') || '')
  expect(id, 'ops-channel WS 握手应已播种 browserId').not.toBe('')
  return id
}

async function clickCount(page: Page): Promise<number> {
  return Number(await page.evaluate(() => localStorage.getItem('__scTgtClicks') || '0'))
}

/** 进项目页并装点击计数器（页级 init 先于 app 脚本，counter 覆盖本页全部 anchor 点击） */
async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await page.addInitScript(CLICK_COUNTER_INIT)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

// 第二浏览器上下文集（显式 afterEach 收口——browser.newContext() 不走 fixture
// 生命周期，不显式 close 会跨用例泄漏：泄漏页的 ops-channel WS 连接仍在 hub
// 在册，单浏览器启发式/定向收件面被陈旧 browserId 污染，后续用例路由决策全歪）
const openedContexts: import('@playwright/test').BrowserContext[] = []

test.afterEach(async () => {
  while (openedContexts.length) {
    await openedContexts.pop()?.close().catch(() => {})
  }
})

/** 第二浏览器上下文（同 viewport/locale 形态；localStorage 天然 per-context 隔离） */
async function secondBrowserPage(browser: import('@playwright/test').Browser): Promise<Page> {
  const context = await browser.newContext({ locale: 'zh-CN', viewport: { width: 1280, height: 720 } })
  openedContexts.push(context)
  const page = await context.newPage()
  return page
}

async function notificationEntries(request: APIRequestContext): Promise<Array<{ action?: string; actionPayload?: string; title?: string }>> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/notifications`, { headers })
  return ((await res.json()) as { data?: Array<{ action?: string; actionPayload?: string; title?: string }> }).data || []
}

test.beforeAll(async ({ request }) => {
  const staleId = await lookupProjectId(request)
  if (staleId) await request.delete(`${API_BASE}/api/projects/${staleId}`, { headers: await unlockHeaders(request) })
  await cleanupSessions(request)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留占用 */ }
  const abs = path.join(REPO_DIR, 'reports', REPORT_NAME)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, REPORT_BODY)
  const res = await request.post(`${API_BASE}/api/projects`, {
    headers: await unlockHeaders(request),
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  expect([200, 201]).toContain(res.status())
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const id = await lookupProjectId(request)
  if (id) await request.delete(`${API_BASE}/api/projects/${id}`, { headers })
  await cleanupSessions(request)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用时忽略 */ }
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
})

test('会话绑定定向：frontend.download 只落在发起浏览器，另一浏览器零效应', async ({ page, browser, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const browserIdA = await readBrowserId(page)
  const sessionId = await createBoundSession(request, headers, browserIdA)

  const pageB = await secondBrowserPage(browser)
  await enterProject(pageB)

  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  const res = await postAtom(request, headers, 'frontend.download', { path: REPORT_REL, projectId: await lookupProjectId(request) }, sessionId)
  expect(res.ok()).toBeTruthy()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(REPORT_NAME)
  await expect(page.locator('[data-testid="ops-atom-download-toast"]')).toBeVisible({ timeout: 5000 })
  // 发起浏览器恰一次效应
  expect(await clickCount(page)).toBe(1)
  // 另一浏览器零效应（等待一拍确认不是时序侥幸）
  await pageB.waitForTimeout(1500)
  expect(await clickCount(pageB)).toBe(0)
  await expect(pageB.locator('[data-testid="ops-atom-download-toast"]')).toHaveCount(0)
})

test('同浏览器双标签单效应：标签选举裁决唯一执行标签（烟测口径）', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const page2 = await page.context().newPage()
  await enterProject(page2)

  const res = await postAtom(request, headers, 'frontend.download', { path: REPORT_REL, projectId: await lookupProjectId(request) })
  expect(res.ok()).toBeTruthy()
  // 同浏览器（同 browserId）两标签各持 WS，定向广播都到达——选举（BroadcastChannel
  // 单阶段 claim 竞选；headless 实探 Web Locks 每页独立 lock manager 不跨页仲裁，
  // 故主路径取跨页共享的 BroadcastChannel）保证浏览器级一次效应。
  // 恰一次口径：__scTgtClicks 是 context 级共享单键（两标签读写同一份，只读一次
  // ——两标签各读同值再相加会翻倍）；per-tab sessionStorage 执行日志合计恰 1 条
  // （效应落在哪个标签由确定性 tie-break 裁决，不预设）
  await expect.poll(async () => clickCount(page), {
    timeout: 15_000,
  }).toBe(1)
  const perTab = await Promise.all([
    page.evaluate(() => JSON.parse(sessionStorage.getItem('__scTgtLog') || '[]').length),
    page2.evaluate(() => JSON.parse(sessionStorage.getItem('__scTgtLog') || '[]').length),
  ])
  expect(perTab[0] + perTab[1], '两标签合计恰一次执行').toBe(1)
})

test('多浏览器并存且无绑定：降级通知化（零效应 + 两浏览器收到降级弹面 + download 动作条目）', async ({ page, browser, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const pageB = await secondBrowserPage(browser)
  await enterProject(pageB)

  const res = await postAtom(request, headers, 'frontend.download', { path: REPORT_REL, projectId: await lookupProjectId(request) })
  expect(res.ok()).toBeTruthy()
  // 零效应（作用面不可判定即不猜——广播越界正是本提案要消灭的行为）
  await page.waitForTimeout(1500)
  expect(await clickCount(page)).toBe(0)
  expect(await clickCount(pageB)).toBe(0)
  await expect(page.locator('[data-testid="ops-atom-download-toast"]')).toHaveCount(0)
  await expect(pageB.locator('[data-testid="ops-atom-download-toast"]')).toHaveCount(0)
  // 降级弹面（notify.persist 全广播——通知是注意力面）两浏览器同达
  const degradeToast = page.getByText('智能体请求下载文件（已转为通知）')
  await expect(degradeToast.first()).toBeVisible({ timeout: 8000 })
  await expect(pageB.getByText('智能体请求下载文件（已转为通知）').first()).toBeVisible({ timeout: 8000 })
  // 通知中心条目入账：download 动作 + {projectId,path} 复合载荷（前端点击触发既有下载链）
  const deadline = Date.now() + 10_000
  let found = false
  while (Date.now() < deadline && !found) {
    const items = await notificationEntries(request)
    found = items.some(n => n.action === 'download' && (n.actionPayload || '').includes('"path":"reports/targeting-report.md"'))
    if (!found) await page.waitForTimeout(400)
  }
  expect(found, '降级条目应入账 action=download 复合载荷').toBe(true)
})

test('绑定浏览器离线：降级 offline 档（他浏览器在场，零效应）', async ({ page, browser, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const browserIdA = await readBrowserId(page)
  const sessionId = await createBoundSession(request, headers, browserIdA)

  // 发起浏览器离场（WS 断开 → hub 索引即清，BrowserOnline 翻假）；他浏览器在场
  await page.close()
  const pageB = await secondBrowserPage(browser)
  await enterProject(pageB)
  await pageB.waitForTimeout(800)

  const res = await postAtom(request, headers, 'frontend.download', { path: REPORT_REL, projectId: await lookupProjectId(request) }, sessionId)
  expect(res.ok()).toBeTruthy()
  await pageB.waitForTimeout(1500)
  expect(await clickCount(pageB)).toBe(0)
  await expect(pageB.getByText('智能体请求下载文件（已转为通知）').first()).toBeVisible({ timeout: 8000 })
})

test('注意力类事件全广播不回归哨兵：notify toast 两浏览器同达', async ({ page, browser, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const pageB = await secondBrowserPage(browser)
  await enterProject(pageB)

  const res = await postAtom(request, headers, 'notify', { message: 'e2e-targeting-broadcast-sentinel' })
  expect(res.ok()).toBeTruthy()
  // 定向只管辖 frontend.* 设备效应族（白名单钉死）；注意力类保持全广播
  await expect(page.getByText('e2e-targeting-broadcast-sentinel')).toBeVisible({ timeout: 8000 })
  await expect(pageB.getByText('e2e-targeting-broadcast-sentinel')).toBeVisible({ timeout: 8000 })
})

test('降级通知静音档：任务类别静音命中 → 零入账零弹面（响应仍 200）', async ({ page, browser, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  // 服务端全局态自清不残留：清账面（前序降级用例的条目不在本用例断言域）+
  // 显式置 task=false、用例毕显式回 true（出厂默认；备份/还原式在 retry 重跑
  // 时会把「静音中」备份回去造成泄漏，显式值幂等无此患）
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
  const mute = await setTaskCategory(request, headers, false)
  expect(mute.ok()).toBeTruthy()

  // 静音档语义挂在**降级链**上（评审必改④a：静音命中即降级全链吞没）——
  // 场景必须真正走降级：双浏览器并存且会话无绑定
  await enterProject(page)
  const pageB = await secondBrowserPage(browser)
  await enterProject(pageB)
  const res = await postAtom(request, headers, 'frontend.download', { path: REPORT_REL, projectId: await lookupProjectId(request) })
  expect(res.ok()).toBeTruthy()
  // 静音命中：不入账不广播（效应零反馈随既有静音语义；定向路径不受通知
  // 偏好管辖——效应闸是 opsAtomPrefs 按原子开关，两套闸不同域）
  await page.waitForTimeout(1500)
  expect(await clickCount(page)).toBe(0)
  expect(await clickCount(pageB)).toBe(0)
  await expect(page.getByText('智能体请求下载文件（已转为通知）')).toHaveCount(0)
  const items = await notificationEntries(request)
  expect(items.some(n => (n.title || '').includes('智能体请求下载文件'))).toBe(false)

  // 还原任务类别开关（出厂默认开）
  const restore = await setTaskCategory(request, headers, true)
  expect(restore.ok()).toBeTruthy()
})

/** 任务类别开关显式置位（通知偏好 enabled.task；全局单键读改写） */
async function setTaskCategory(request: APIRequestContext, headers: Record<string, string>, enabled: boolean) {
  const prefsRes = await request.get(`${API_BASE}/api/notifications/prefs`, { headers })
  expect(prefsRes.ok()).toBeTruthy()
  const prefs = ((await prefsRes.json()) as { data?: Record<string, unknown> }).data || {}
  return request.put(`${API_BASE}/api/notifications/prefs`, {
    headers,
    data: { ...prefs, enabled: { ...(prefs.enabled as Record<string, boolean> | undefined), task: enabled } },
  })
}
