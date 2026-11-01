import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * frontend 动词族三原子端到端（P-20261023-4）：协议从「引导注意力」升维
 * 「替用户执行浏览器动作」——
 *   1. frontend.download：ops-notify 上报 → 隐藏 <a download> 指向既有文件
 *      下载端点 → 浏览器下载框真实弹出（Playwright download 事件）+ 可见 toast；
 *   2. 效应面限频：10 次/分钟触顶后丢弃 + 可见 warning（丢弃不静默也不转化为
 *      toast 轰炸——每窗口一条）；
 *   3. frontend.clipboard：copyText 直写剪贴板（权限放行时读回对账）+ 敏感值
 *      遮蔽截断预览 toast（无静默写入）；writeText 被拒 → 中继槽回落链
 *      （写服务端单槽 + 点击读取即焚 toast）；
 *   4. frontend.open：window.open noopener 新标签（spy 承接不真开外链）；
 *      popup 被拦 → 回落通知中心 action=url 条目（既有形态，点击开）；
 *   5. 发布口注册表校验面（坏载荷 400 冻结原文）+ 手册=实现（/ops-manual 含
 *      三原子与组合配方小节；/api/meta ops.present-atoms 自动跟随）。
 * 夹具项目 spec 内自备/自清，不残留测试数据
 */

const PROJ_NAME = 'e2e-ops-frontend-atoms'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-ops-frontend-atoms')
const REPORT_REL = 'reports/bandwidth-analysis.md'
const REPORT_NAME = 'bandwidth-analysis.md'
const REPORT_BODY = '# bandwidth report\n\ngenerated for frontend-atoms e2e\n'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

async function lookupProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  return list.find(p => p.name === PROJ_NAME)?.id || ''
}

test.beforeAll(async ({ request }) => {
  // 清掉前次运行残留（崩溃遗留的旧项目/旧夹具）
  const staleId = await lookupProjectId(request)
  if (staleId) await request.delete(`${API_BASE}/api/projects/${staleId}`, { headers: await unlockHeaders(request) })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留占用 */ }
  const abs = path.join(REPO_DIR, 'reports', REPORT_NAME)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, REPORT_BODY)
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const res = await request.post(`${API_BASE}/api/projects`, {
    headers: await unlockHeaders(request),
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  expect([200, 201]).toContain(res.status())
  projectId = await lookupProjectId(request)
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const id = await lookupProjectId(request)
  if (id) await request.delete(`${API_BASE}/api/projects/${id}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用时忽略 */ }
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
})

// 进项目页（OpsChannelBridge 随 App 挂载、WS 建连）：路上留出窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

function postAtom(page: import('@playwright/test').Page, headers: Record<string, string>, type: string, payload: unknown) {
  return page.request.post(`${API_BASE}/api/ops-notify`, { headers, data: { type, payload } })
}

// 播种前装 anchor 点击 spy（记录 href/download，原样放行真实点击——下载框
// 该弹照弹，请求落点与服务端链路全真）
async function spyAnchorClicks(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __scAtomClicks: { href: string, download: string }[] }
    w.__scAtomClicks = []
    const proto = HTMLAnchorElement.prototype
    const orig = proto.click
    proto.click = function (this: HTMLAnchorElement) {
      w.__scAtomClicks.push({ href: this.getAttribute('href') || '', download: this.getAttribute('download') || '' })
      orig.call(this)
    }
  })
}

test('frontend.download → 浏览器下载框真实弹出 + 可见 toast + 请求落点', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await spyAnchorClicks(page)
  await enterProject(page)
  const downloadPromise = page.waitForEvent('download', { timeout: 15_000 })
  const res = await postAtom(page, headers, 'frontend.download', { path: REPORT_REL, projectId })
  expect(res.ok()).toBeTruthy()
  // 浏览器下载框真实弹出：建议文件名 = Content-Disposition 净化链产出
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(REPORT_NAME)
  // spy 记录的 anchor 落点 = 既有文件下载端点（projectId 寻址 + path 编码）
  const clicks = await page.evaluate(() => (window as unknown as { __scAtomClicks: { href: string, download: string }[] }).__scAtomClicks)
  expect(clicks).toHaveLength(1)
  expect(clicks[0].href).toBe(`/api/projects/${projectId}/file/download?path=${encodeURIComponent(REPORT_REL)}`)
  expect(clicks[0].download).toBe(REPORT_NAME)
  // 必带可见反馈（无静默效应）
  await expect(page.locator('[data-testid="ops-atom-download-toast"]')).toBeVisible({ timeout: 5000 })
})

test('frontend.download 效应面限频：触顶丢弃 + 每窗口一条可见 warning', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  await spyAnchorClicks(page)
  await enterProject(page)
  // 12 连发：前 10 次放行，11/12 丢弃——丢弃不静默（warning 可见）也不轰炸
  //（每窗口至多一条）
  for (let i = 0; i < 12; i++) {
    const res = await postAtom(page, headers, 'frontend.download', { path: `f${i}.md`, projectId })
    expect(res.ok()).toBeTruthy()
    await page.waitForTimeout(50)
  }
  // 服务端 60 条/分钟预算内 12 条全受理；效应面独立预算只放 10 次点击
  await expect.poll(async () => page.evaluate(() => (window as unknown as { __scAtomClicks: unknown[] }).__scAtomClicks.length), {
    timeout: 10_000,
  }).toBe(10)
  await expect(page.locator('[data-testid="ops-atom-rate-limited-toast"]')).toHaveCount(1)
})

test('frontend.clipboard → 直写剪贴板 + 遮蔽截断预览 toast（无静默写入）', async ({ page, context, request }) => {
  test.setTimeout(60_000)
  // headless Chromium 的 Clipboard API 需显式授权（读回对账 + 直写放行）
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  const headers = await unlockHeaders(request)
  await enterProject(page)
  const secret = 'token=sk-secret123 deploy now'
  const res = await postAtom(page, headers, 'frontend.clipboard', { text: secret })
  expect(res.ok()).toBeTruthy()
  // 直写真实落剪贴板（读回逐字对账——载荷语义：写入字节与 agent 意图一致）
  await expect.poll(async () => page.evaluate(() => navigator.clipboard.readText()), {
    timeout: 10_000,
  }).toBe(secret)
  // 可见预告带遮蔽预览：敏感值 *** 化（投毒防线第一层）
  const toast = page.locator('[data-testid="ops-atom-clipboard-toast"]')
  await expect(toast).toBeVisible({ timeout: 5000 })
  await expect(toast).toContainText('***')
})

test('frontend.clipboard 直写被拒 → 中继槽回落链（点击读取即焚）', async ({ page, context, request }) => {
  test.setTimeout(60_000)
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  const headers = await unlockHeaders(request)
  // writeText 恒拒 + execCommand 恒 false（copyText 的两级直写全关——headless
  // 下 execCommand 偶发真返 true 会走降级路径而非回落链，模拟必须确定性）；
  // readText 保持真实供回落点击后的落盘对账
  await page.addInitScript(() => {
    const proto = Object.getPrototypeOf(navigator.clipboard) as Record<string, unknown>
    Object.defineProperty(proto, 'writeText', {
      value: async () => { throw new DOMException('denied', 'NotAllowedError') },
      configurable: true,
    })
    Object.defineProperty(document, 'execCommand', {
      value: () => false,
      configurable: true,
      writable: true,
    })
  })
  await enterProject(page)
  const res = await postAtom(page, headers, 'frontend.clipboard', { text: 'relay-me-please' })
  expect(res.ok()).toBeTruthy()
  // 回落形态 = clipboard.arrived 同款可点击 toast（点击 GET 读取即焚落本地）
  const fallback = page.locator('[data-testid="clip-arrive-toast"]')
  await expect(fallback).toBeVisible({ timeout: 10_000 })
  await fallback.click()
  // 读取即焚：中继槽被消费（GET /api/clip 404 = takeArrived 已取走）
  await expect.poll(async () => (await request.get(`${API_BASE}/api/clip`, { headers })).status(), {
    timeout: 10_000,
  }).toBe(404)
})

test('frontend.open → 新标签打开（noopener spy 承接）；popup 被拦回落通知中心 url 条目', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  // spy window.open：记录入参并返回假窗口（既断言 noopener 语义，又不真开外链）
  await page.addInitScript(() => {
    const w = window as unknown as { __scAtomOpens: unknown[][] }
    w.__scAtomOpens = []
    w.__scAtomBlocked = false
    Object.defineProperty(window, 'open', {
      value: (...args: unknown[]) => {
        w.__scAtomOpens.push(args)
        return w.__scAtomBlocked ? null : ({ fake: true }) as unknown as Window
      },
      configurable: true,
      writable: true,
    })
  })
  await enterProject(page)
  const ok = await postAtom(page, headers, 'frontend.open', { url: 'https://ci.example.net/runs/42' })
  expect(ok.ok()).toBeTruthy()
  const opens = await page.evaluate(() => (window as unknown as { __scAtomOpens: unknown[][] }).__scAtomOpens)
  expect(opens).toHaveLength(1)
  expect(opens[0][0]).toBe('https://ci.example.net/runs/42')
  expect(opens[0][1]).toBe('_blank')
  expect(opens[0][2]).toBe('noopener')
  await expect(page.locator('[data-testid="ops-atom-open-toast"]')).toBeVisible({ timeout: 5000 })

  // popup 被拦（open 返回 null = 浏览器边界）：回落通知中心 action=url 条目
  await page.evaluate(() => { (window as unknown as { __scAtomBlocked: boolean }).__scAtomBlocked = true })
  const blocked = await postAtom(page, headers, 'frontend.open', { url: 'https://ci.example.net/runs/43' })
  expect(blocked.ok()).toBeTruthy()
  await expect(page.locator('[data-testid="ops-atom-open-blocked-toast"]')).toBeVisible({ timeout: 5000 })
  // 通知中心条目入账（既有形态：用户点击开）——store.add 直发 POST /notifications
  const deadline = Date.now() + 10_000
  let found = false
  while (Date.now() < deadline && !found) {
    const list = await request.get(`${API_BASE}/api/notifications`, { headers })
    const items = ((await list.json()) as { data?: Array<{ title?: string, action?: string, actionPayload?: string }> }).data || []
    found = items.some(n => n.action === 'url' && n.actionPayload === 'https://ci.example.net/runs/43')
    if (!found) await page.waitForTimeout(400)
  }
  expect(found, '被拦回落应入账 action=url 通知条目').toBe(true)
})

test('发布口校验面 400 冻结原文；手册=实现（三原子 + 组合配方 + meta 能力项）', async ({ request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  // 坏载荷 400：message 是注册表冻结原文（agent 侧分支依据不漂移）
  const bad: Array<[string, unknown, string]> = [
    ['frontend.download', { path: '../escape', projectId: 'p' }, 'invalid frontend.download payload'],
    ['frontend.download', { path: 'a.md' }, 'invalid frontend.download payload'],
    ['frontend.clipboard', { text: '' }, 'invalid frontend.clipboard payload'],
    ['frontend.clipboard', { text: 'x'.repeat(32 * 1024 + 1) }, 'invalid frontend.clipboard payload'],
    ['frontend.open', { url: 'javascript:alert(1)' }, 'invalid frontend.open payload'],
    ['frontend.open', { url: '/project?file=a.ts' }, 'invalid frontend.open payload'],
  ]
  for (const [type, payload, want] of bad) {
    const res = await request.post(`${API_BASE}/api/ops-notify`, { headers, data: { type, payload } })
    expect(res.status(), `${type} 坏载荷应 400`).toBe(400)
    expect(await res.text()).toContain(want)
  }

  // 手册=实现：注册表渲染的三原子 + 组合配方小节在册
  const manualRes = await fetch(`${API_BASE}/ops-manual`, { headers })
  expect(manualRes.status).toBe(200)
  const manual = ((await manualRes.json()) as { data?: { manual?: string } }).data?.manual || ''
  for (const fragment of ['frontend.download', 'frontend.clipboard', 'frontend.open', '组合配方', 'notify.persist']) {
    expect(manual, `手册缺 ${fragment}`).toContain(fragment)
  }
  // 能力探测面：ops.present-atoms 族项（注册表扩容自动跟随，无需新族项）
  const metaRes = await fetch(`${API_BASE}/api/meta`)
  expect(metaRes.status).toBe(200)
  const meta = (await metaRes.json()) as { capabilities?: string[] }
  expect(meta.capabilities || []).toContain('ops.present-atoms')
})
