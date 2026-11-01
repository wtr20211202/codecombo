import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, rightClickTreeBackground } from '../../tests/helpers'

/**
 * 一次性分享（阅后即焚，P-20261006-27）E2E——分享时限的次数维。
 * P-20261020-3 起武装收口到显式确认：预览抓取 GET/HEAD 只拿到确认页
 * （不武装/不计数/不泄露文件名），POST /s/{token}/view 才武装 + 计一次
 * 访问 + 发查看 cookie；内容页要求该 cookie，同窗刷新不重复计数。
 *   1. API 链路：创建带 viewOnce（响应投影）→ bot UA GET/HEAD 不烧链
 *      （hits 仍为 0）→ 显式确认 303 + 查看 cookie → 内容页/meta 可用 →
 *      窗内刷新不重复计数 → 列表 viewOnce 投影；frozen/terminal/
 *      terminal-frozen 形态组合 400（定格留证与持续流语义不支持一次性）；
 *      snippet 同参
 *   2. UI 链路：访客确认页（泛化文案，无文件名）→ 点击查看 → 内容页 →
 *      刷新仍可用；创建弹层一次性勾选（frozen 选中即禁用）→ 管理器
 *      「一次性」徽标
 * 「窗后失效文案（410 share_consumed 专页）」依赖 10 分钟宽限窗走完——宽限
 * 窗是编译期常量（store.ViewOnceGrace）、无运行态压缩面，e2e 不可达；该态
 * 判定矩阵（窗界/窗外/不惰性删除/与口令门叠加/确认限流）由 Go 单测注入
 * 时钟覆盖（server/share/viewonce_test.go + server/store/share_viewonce_test.go），
 * 列表 consumed 投影同理在 server/api/share 单测覆盖。
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）。
 * 可重跑关键：每例自建唯一文件（唯一 token），afterEach 删除（进回收站），
 * beforeEach 清空全部分享。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'

/** 本轮用例创建的文件（afterEach 统一删除，保种子项目工作树干净） */
const createdFiles: string[] = []

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

/** 管理列表里该分享的 hits（计数 3s 批量落盘，断言前用 waitHits 轮询） */
async function hitsOf(request: APIRequestContext, headers: Record<string, string>, token: string): Promise<number> {
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string; hits?: number }[] }).data || []
  return list.find(s => s.token === token)?.hits ?? 0
}

/** 轮询管理列表直至该分享 hits ≥ want（不整页忙等） */
async function waitHits(
  request: APIRequestContext,
  headers: Record<string, string>,
  token: string,
  want: number,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if ((await hitsOf(request, headers, token)) >= want) return
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`share ${token} hits never reached ${want} within ${timeoutMs}ms`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** 一次性分享访客页的浏览器 UA/HEAD 伪装（IM/邮件网关预览抓取的同形请求） */
const PREVIEW_HEADERS = {
  'User-Agent': 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
  'Accept-Language': 'zh-CN',
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  for (const path of createdFiles.splice(0)) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  }
})

test('API：viewOnce 创建 → 预览 GET/HEAD 不烧链 → 显式确认可用 → 刷新不重复计数 → 列表投影 → 形态拒绝', async ({ request }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders(request)
  const shareBase = await getShareBase(request, headers)
  const projectId = await getProjectId(request, headers)
  const path = `e2e-viewonce-${Date.now()}.md`
  const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content: '# view-once e2e\n\nburn after reading\n' },
  })
  expect(mk.ok(), await mk.text()).toBeTruthy()
  createdFiles.push(path)

  // 创建带 viewOnce：响应投影 viewOnce=true、无 consumed（未查看）
  const cr = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path, viewOnce: true } })
  expect(cr.ok(), await cr.text()).toBeTruthy()
  const created = ((await cr.json()) as { data?: { token: string; viewOnce?: boolean; consumed?: boolean } }).data
  expect(created?.viewOnce).toBe(true)
  expect(created?.consumed).toBeFalsy()
  const token = created!.token!

  // 预览抓取 GET：只出泛化确认页（不渲染内容、不泄露文件名）
  const preview = await request.get(`${shareBase}/s/${token}`, { headers: PREVIEW_HEADERS })
  expect(preview.status()).toBe(200)
  const previewBody = await preview.text()
  expect(previewBody).toContain('这是一条一次性分享')
  expect(previewBody).not.toContain(path)
  expect(previewBody).not.toContain('id="page-css"')
  expect(preview.headers()['x-robots-tag']).toBe('noindex')

  // HEAD 探测不武装（Go 的 GET 路由同时匹配 HEAD）
  const head = await request.head(`${shareBase}/s/${token}`, { headers: PREVIEW_HEADERS })
  expect(head.status()).toBe(200)

  // 预览流量不产生访问计数：等一个 3s 冲刷周期后 hits 仍为 0
  await sleep(4_500)
  expect(await hitsOf(request, headers, token)).toBe(0)

  // 显式确认：303 回内容页 + 短时效查看 cookie（HttpOnly/SameSite=Lax）
  const confirm = await request.post(`${shareBase}/s/${token}/view`, { maxRedirects: 0 })
  expect(confirm.status()).toBe(303)
  expect((confirm.headers()['location'] || '').endsWith(`/s/${token}`)).toBe(true)
  const setCookie = confirm.headers()['set-cookie'] || ''
  expect(setCookie).toContain(`sc_view_${token}=`)
  expect(setCookie).toContain(`Path=/s/${token}`)
  expect(setCookie.toLowerCase()).toContain('httponly')
  expect(setCookie.toLowerCase()).toContain('samesite=lax')

  // 确认后内容页可用（APIRequestContext 持有查看 cookie）
  const content = await request.get(`${shareBase}/s/${token}`, { headers: { 'Accept-Language': 'zh-CN' } })
  expect(content.status()).toBe(200)
  const contentBody = await content.text()
  expect(contentBody).toContain('id="page-css"')
  // 内容页会内嵌整表文案（boot state Dict 含 confirmHeading），不能按文案
  // 断言「没回确认页」——按确认页独有的标题标记断言（内容页无此 h1）
  expect(contentBody).not.toContain('<h1 class="title">这是一条一次性分享</h1>')

  // 窗内刷新/重开：仍 200，且不重复计数（确认时记一次，刷新后仍为 1）
  const refresh = await request.get(`${shareBase}/s/${token}`, { headers: { 'Accept-Language': 'zh-CN' } })
  expect(refresh.status()).toBe(200)
  await waitHits(request, headers, token, 1)
  await sleep(4_500)
  expect(await hitsOf(request, headers, token)).toBe(1)

  // meta 正常（内容页渲染的取数端点）
  const meta = await request.get(`${shareBase}/s/${token}/meta`)
  expect(meta.status()).toBe(200)
  const metaBody = (await meta.json()) as { entry?: { name: string } }
  expect(metaBody.entry?.name).toBe(path)

  // 列表投影：viewOnce=true、consumed 缺省（服务端判宽限窗，前端不复制判定）
  const list = await request.get(`${BASE}/api/share`, { headers })
  const row = (((await list.json()) as { data?: { token: string; viewOnce?: boolean }[] }).data || [])
    .find(s => s.token === token)
  expect(row?.viewOnce).toBe(true)

  // 形态拒绝：frozen 组合 400；直播/快照显式拒绝位 400（可编程感知）
  const frozen = await request.post(`${BASE}/api/share`, {
    headers, data: { projectId, path, mode: 'frozen', viewOnce: true },
  })
  expect(frozen.status()).toBe(400)
  const live = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: 'no-such', viewOnce: true } })
  expect(live.status()).toBe(400)
  const snap = await request.post(`${BASE}/api/share/terminal-frozen`, { headers, data: { sessionId: 'no-such', viewOnce: true } })
  expect(snap.status()).toBe(400)

  // snippet 同参：一次性片段创建成功并回投影
  const sn = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: `e2e view-once snippet ${Date.now()}`, viewOnce: true } })
  expect(sn.ok()).toBeTruthy()
  expect(((await sn.json()) as { data?: { viewOnce?: boolean } }).data?.viewOnce).toBe(true)
})

test.describe('一次性分享 UI 链路', () => {
  test.use({ locale: 'zh-CN' })

  test('访客：确认页（无文件名）→ 点击查看 → 内容页 → 刷新仍可用', async ({ page, request }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    const projectId = await getProjectId(request, headers)
    const path = `e2e-viewonce-ui-${Date.now()}.md`
    const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
      headers, data: { path, content: '# view-once UI\n\nburn after reading\n' },
    })
    expect(mk.ok(), await mk.text()).toBeTruthy()
    createdFiles.push(path)
    const cr = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path, viewOnce: true } })
    expect(cr.ok(), await cr.text()).toBeTruthy()
    const token = ((await cr.json()) as { data?: { token: string } }).data!.token!

    // 确认页：泛化标题 + 单个提交钮，页面不含文件名
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.title')).toHaveText('这是一条一次性分享')
    await expect(page.locator('body')).not.toContainText(path)

    // 显式确认 → 303 回内容页（查看 cookie 随浏览器上下文持有）
    await page.getByRole('button', { name: '查看内容' }).click()
    await page.waitForURL(`**/s/${token}`)
    await expect(page.locator('.header h1')).toHaveText(path)

    // 窗内刷新不失效（宽限窗存在的意义）
    await page.reload()
    await expect(page.locator('.header h1')).toHaveText(path)
  })

  test('创建弹层一次性勾选（frozen 选中即禁用）→ 管理器「一次性」徽标', async ({ page, request }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders(request)
    await getProjectId(request, headers) // 确认种子项目在位（UI 走文件树入口）

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, PROJECT_NAME).first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 创建：背景右键 → 生成分享链接 → 勾一次性 → 确认
    await rightClickTreeBackground(page)
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
    const createModal = page.locator('.share-create-modal')
    await expect(createModal).toBeVisible()

    // 默认不勾选（阅后即焚是 opt-in 的激进选项，缺省关）。
    // naive-ui n-checkbox 无真实 input 元素：勾选态走 aria-checked（testid
    // 落 role=checkbox 根节点，agent-git-status-summary.spec 同款口径）
    const onceCheck = createModal.locator('[data-testid="share-create-viewonce"]')
    await expect(onceCheck).toBeVisible()
    await expect(onceCheck).toHaveAttribute('aria-checked', 'false')

    // frozen 与一次性互斥：切到 frozen 即禁用并清勾（前端先于服务端 400
    // 引导；禁用态 n-checkbox--disabled 类，aria-checked 保持 false——
    // 「看起来选了实际没选」的诚实性由 watch 清勾保证）
    await createModal.locator('[data-testid="share-mode-frozen"]').click()
    await expect(onceCheck).toHaveClass(/n-checkbox--disabled/)
    await expect(onceCheck).toHaveAttribute('aria-checked', 'false')
    await createModal.locator('[data-testid="share-mode-live"]').click()
    await expect(onceCheck).not.toHaveClass(/n-checkbox--disabled/)
    await onceCheck.click()
    await expect(onceCheck).toHaveAttribute('aria-checked', 'true')

    await createModal.locator('[data-testid="share-create-confirm"]').click()
    const modal = page.locator('.share-result-modal')
    await expect(modal).toBeVisible()
    const link = await modal.locator('input').inputValue()
    const token = link.split('/').pop()!

    // 管理视图：该行挂「一次性」徽标（失效态徽标 consumed 由服务端宽限窗
    // 判定，e2e 不可达面——Go 单测覆盖）
    await modal.getByRole('button', { name: '管理全部分享' }).click()
    await expect(modal).toBeHidden()
    const row = page.locator('tr').filter({ hasText: '（项目根）' })
    await expect(row).toBeVisible()
    await expect(row.locator('[data-testid="sm-viewonce-badge"]')).toContainText('一次性')
    expect(token).toBeTruthy()
  })
})
