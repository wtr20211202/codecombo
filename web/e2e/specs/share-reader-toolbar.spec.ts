import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 访客阅读小件与链接元信息 E2E（P-20261020-11）：
 *   ① 文本/代码工具条：复制全文、自动换行、行号；大文件阈值降级纯 pre
 *   ② 目录头摘要：N 项 · 共 X（列表 entries/size 前端汇总，目录不累加）
 *   ③ 复制链接语义拆分：页面链接（含 ?path= 深链）与下载直链；snippet 只剩页面
 *   ④ 服务端直出 title/description/OG；口令/一次性分享泛化不泄露文件名
 *   ⑤ HTML/媒体「新标签打开」：既有 /html、/raw 端点，CSP sandbox 不变
 * 访客面打在分享子服务（主端口 +2，经 /api/share/status 动态获取）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const DIR = 'e2e-share-reader'
const TEXT = `${DIR}/notes.txt`
const HTML = `${DIR}/page.html`
const SVG = `${DIR}/pic.svg`
const BIG = 'e2e-share-reader-big.txt'
const PASS = 'e2e-share-reader-pass.txt'
const ONCE = 'e2e-share-reader-once.txt'

const TEXT_CONTENT = 'alpha\nbeta\ngamma\ndelta\n'
const HTML_CONTENT = '<!doctype html><html><body><h1>reader-new-tab</h1></body></html>'
const SVG_CONTENT = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>'
const BIG_CONTENT = 'L'.repeat(513 * 1024)
const PASS_CONTENT = 'pass-protected content\n'
const ONCE_CONTENT = 'one-time content\n'
const PASSPHRASE = 'reader-pass-123'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJ)
  if (!p) throw new Error(`project ${PROJ} not found`)
  return p.id
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

let headers: Record<string, string>
let projectId = ''
let shareBase = ''
const tokens: Record<string, string> = {}

async function createFixtureFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content },
  })
  expect(res.ok()).toBeTruthy()
}

async function createShare(
  request: APIRequestContext, path: string, extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await request.post(`${BASE}/api/share`, {
    headers, data: { projectId, path, ...extra },
  })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { token: string } }).data
  expect(data?.token).toBeTruthy()
  return data!.token
}

test.beforeAll(async ({ request }) => {
  headers = await unlockHeaders(request)
  projectId = await getProjectId(request, headers)
  shareBase = await getShareBase(request, headers)

  // 清掉同一夹具目标的旧分享（重复运行/上一轮失败残留），保证 token 语义确定
  const paths = new Set([DIR, TEXT, HTML, SVG, BIG, PASS, ONCE])
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as {
    data?: { token: string; projectId: string; path: string }[]
  }).data || []
  for (const s of list) {
    if (s.projectId === projectId && paths.has(s.path)) {
      await request.delete(`${BASE}/api/share/${s.token}`, { headers })
    }
  }

  await createFixtureFile(request, TEXT, TEXT_CONTENT)
  await createFixtureFile(request, HTML, HTML_CONTENT)
  await createFixtureFile(request, SVG, SVG_CONTENT)
  await createFixtureFile(request, BIG, BIG_CONTENT)
  await createFixtureFile(request, PASS, PASS_CONTENT)
  await createFixtureFile(request, ONCE, ONCE_CONTENT)

  tokens.dir = await createShare(request, DIR)
  tokens.text = await createShare(request, TEXT)
  tokens.html = await createShare(request, HTML)
  tokens.svg = await createShare(request, SVG)
  tokens.big = await createShare(request, BIG)
  tokens.pass = await createShare(request, PASS, { passphrase: PASSPHRASE })
  tokens.once = await createShare(request, ONCE, { viewOnce: true })
})

test.afterAll(async ({ request }) => {
  for (const token of Object.values(tokens)) {
    if (token) await request.delete(`${BASE}/api/share/${token}`, { headers })
  }
  // 夹具目录/文件整树删除（进回收站，不落工作区）；忽略不存在
  for (const p of [DIR, BIG, PASS, ONCE]) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: p } })
  }
})

/** 剪贴板桩：避免依赖 Chromium 权限与真实系统剪贴板，只记录 copyText 收到的文本 */
async function stubClipboard(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __clip: string[] }
    w.__clip = []
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (s: string) => { w.__clip.push(s); return Promise.resolve() } },
    })
  })
}

async function lastCopied(page: import('@playwright/test').Page): Promise<string | undefined> {
  return page.evaluate(() => (window as unknown as { __clip: string[] }).__clip.at(-1))
}

// ① + ③：文本工具条、行号/换行切换、复制全文、页面链接 vs 下载直链
test('文本工具条：行号/换行切换、复制全文、页面链接与下载链接语义分离', async ({ page }) => {
  await stubClipboard(page)
  await page.goto(`${shareBase}/s/${tokens.text}`)

  const tools = page.locator('.text-tools, .preview-tools')
  await expect(tools.first()).toBeVisible()
  const copyAll = page.locator('.preview-tools .tool-btn').filter({ hasText: '复制全文' })
  await expect(copyAll).toBeEnabled()

  // 行号默认开：5 个逻辑行（末尾换行产生一个空行）
  const lines = page.locator('.text-lines .tl')
  await expect(lines).toHaveCount(5)
  await expect(page.locator('.text-lines')).toHaveClass(/with-ln/)
  await expect(page.locator('.tl-n').first()).toHaveText('1')
  await expect(page.locator('.tl-c').first()).toHaveText('alpha')

  // 行号开关：关闭后行号隐藏，再开回来
  const lnBtn = page.locator('.preview-tools .tool-btn').filter({ hasText: '行号' })
  await lnBtn.click()
  await expect(page.locator('.text-lines')).not.toHaveClass(/with-ln/)
  await expect(page.locator('.tl-n').first()).toBeHidden()
  await lnBtn.click()
  await expect(page.locator('.text-lines')).toHaveClass(/with-ln/)

  // 自动换行：white-space 从 pre 切到 pre-wrap
  const wrapBtn = page.locator('.preview-tools .tool-btn').filter({ hasText: '自动换行' })
  await wrapBtn.click()
  await expect(page.locator('.text-lines')).toHaveClass(/with-wrap/)
  expect(await page.locator('.tl-c').first().evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre-wrap')
  await wrapBtn.click()
  expect(await page.locator('.tl-c').first().evaluate(el => getComputedStyle(el).whiteSpace)).toBe('pre')

  // 复制全文 = 原文逐字节一致（不是行号拼接后的文本）
  await copyAll.click()
  expect(await lastCopied(page)).toBe(TEXT_CONTENT)

  // 页面链接 = /s/{token}（可深链）；下载链接 = /dl/原路径；两者明确分离
  await page.locator('.header .actions button').filter({ hasText: '复制页面链接' }).click()
  expect(await lastCopied(page)).toBe(`${shareBase}/s/${tokens.text}`)
  await page.locator('.header .actions button').filter({ hasText: '复制下载链接' }).click()
  // 单文件分享的根就是该文件：下载直链是 /dl/（路径为空，服务端按根文件出包）；
  // 页面链接是 /s/{token}——两者语义仍明确分离
  expect(await lastCopied(page)).toBe(`${shareBase}/s/${tokens.text}/dl/`)
})

// ②：目录头摘要：项数 + 文件总大小（目录条目不累加）
test('目录头摘要：N 项 · 共 X（只累加文件大小）', async ({ page }) => {
  const total = Buffer.byteLength(TEXT_CONTENT) + Buffer.byteLength(HTML_CONTENT) + Buffer.byteLength(SVG_CONTENT)
  expect(total).toBeLessThan(1024) // 断言用 B 档，避免跨单位格式差异
  await page.goto(`${shareBase}/s/${tokens.dir}`)
  await expect(page.locator('.list tbody tr')).toHaveCount(3)
  await expect(page.locator('.header .sub')).toContainText(`3 项 · 共 ${total} B`)
})

// ③：子目录/文件定位的页面链接带 ?path=，下载链接带原路径；刷新深链仍落在同一文件
test('深链复制：页面链接带 ?path=，下载链接带原路径，刷新保持定位', async ({ page }) => {
  await stubClipboard(page)
  await page.goto(`${shareBase}/s/${tokens.dir}`)
  await page.locator('.list tbody tr').filter({ hasText: 'notes.txt' }).click()
  await expect(page.locator('.text-lines')).toBeVisible()
  expect(new URL(page.url()).searchParams.get('path')).toBe('notes.txt')

  await page.locator('.header .actions button').filter({ hasText: '复制页面链接' }).click()
  expect(await lastCopied(page)).toBe(`${shareBase}/s/${tokens.dir}?path=notes.txt`)
  await page.locator('.header .actions button').filter({ hasText: '复制下载链接' }).click()
  expect(await lastCopied(page)).toBe(`${shareBase}/s/${tokens.dir}/dl/notes.txt`)

  // 页面链接即深链：刷新后仍停在该文件（而不是回目录根）
  await page.reload()
  await expect(page.locator('.text-lines')).toBeVisible()
  await expect(page.locator('.header h1')).toHaveText('notes.txt')
})

// ⑤：HTML/媒体新标签打开——走既有 /html、/raw，CSP sandbox 不放宽
test('新标签打开：HTML 走 /html（sandbox 保留），媒体走 /raw', async ({ page }) => {
  await page.goto(`${shareBase}/s/${tokens.html}`)
  const openHtml = page.locator('.preview-tools .tool-btn').filter({ hasText: '新标签打开' })
  await expect(openHtml).toBeVisible()
  const htmlPopupPromise = page.waitForEvent('popup')
  await openHtml.click()
  const htmlPopup = await htmlPopupPromise
  await htmlPopup.waitForLoadState('domcontentloaded')
  const htmlURL = new URL(htmlPopup.url())
  expect(htmlURL.pathname).toBe(`/s/${tokens.html}/html`)
  // 单文件分享的根就是该文件，访客路径为空（?path= 空串）
  expect(htmlURL.searchParams.get('path')).toBe('')
  expect(htmlURL.searchParams.get('scripts')).toBeNull()
  await expect(htmlPopup.locator('h1')).toHaveText('reader-new-tab')
  await htmlPopup.close()

  await page.goto(`${shareBase}/s/${tokens.svg}`)
  const openSvg = page.locator('.preview-tools .tool-btn').filter({ hasText: '新标签打开' })
  await expect(openSvg).toBeVisible()
  const svgPopupPromise = page.waitForEvent('popup')
  await openSvg.click()
  const svgPopup = await svgPopupPromise
  await svgPopup.waitForLoadState('domcontentloaded')
  const svgURL = new URL(svgPopup.url())
  expect(svgURL.pathname).toBe(`/s/${tokens.svg}/raw`)
  expect(svgURL.searchParams.get('path')).toBe('')
  await svgPopup.close()
})

// ④：服务端直出 title/description/OG——IM/邮件网关不执行 JS 也能看到文件名
test('链接元信息：title/description/OG 直出文件名与项目；og:url 取请求 Host', async ({ request }) => {
  const res = await request.get(`${shareBase}/s/${tokens.text}`, {
    headers: { 'Accept-Language': 'zh-CN' },
  })
  const body = await res.text()
  expect(body).toContain(`<title>notes.txt · 文件分享</title>`)
  expect(body).toContain(`<meta name="description" content="notes.txt · 来自项目 ${PROJ} 的文件分享">`)
  expect(body).toContain(`<meta property="og:title" content="notes.txt · 文件分享">`)
  expect(body).toContain(`<meta property="og:description" content="notes.txt · 来自项目 ${PROJ} 的文件分享">`)
  expect(body).toContain(`<meta property="og:url" content="${shareBase}/s/${tokens.text}">`)
  expect(body).toContain(`<meta name="robots" content="noindex">`)
})

// ④：口令/一次性分享泛化——未解锁页面无文件名；解锁后的内容页 OG 仍泛化
test('口令与一次性分享：泛化标题不泄露文件名', async ({ request }) => {
  const zh = { 'Accept-Language': 'zh-CN' }

  // 口令门页：无文件名、无分享 OG
  const gate = await request.get(`${shareBase}/s/${tokens.pass}`, { headers: zh })
  const gateBody = await gate.text()
  expect(gateBody).not.toContain(PASS)
  expect(gateBody).not.toContain(`property="og:title"`)

  // 正确口令换取门会话后，内容页 HTML 的 title/OG 仍是泛化文案
  const unlock = await request.post(`${shareBase}/s/${tokens.pass}/gate`, {
    headers: zh, data: { passphrase: PASSPHRASE }, maxRedirects: 0,
  })
  expect(unlock.status()).toBe(303)
  const cookie = (unlock.headers()['set-cookie'] || '').split(';')[0]
  expect(cookie).toContain(`sc_gate_${tokens.pass}=`)
  const content = await request.get(`${shareBase}/s/${tokens.pass}`, {
    headers: { ...zh, Cookie: cookie },
  })
  const contentBody = await content.text()
  // 泛化标题品牌随 4adaf9da 切换为 Codecombo（server/share/page.go pageLinkMeta）
  expect(contentBody).toContain(`<title>Codecombo 文件分享</title>`)
  expect(contentBody).toContain(`<meta property="og:title" content="Codecombo 文件分享">`)
  expect(contentBody).toContain(`通过 Codecombo 分享的内容，打开链接查看。`)
  // 只锚 head 元信息：正文水印（默认开）会带分享名，那是解锁后的内容面，
  // 不属于「未解锁前的链接预览」泄露面
  const head = contentBody.slice(0, contentBody.indexOf('</head>'))
  expect(head).not.toContain(PASS)

  // 一次性确认页：同样不含记录字段
  const once = await request.get(`${shareBase}/s/${tokens.once}`, { headers: zh })
  const onceBody = await once.text()
  expect(onceBody).not.toContain(ONCE)
  expect(onceBody).not.toContain(`property="og:title"`)
})

// ①：大文件阈值降级——行号/高亮关闭，内容仍可读、换行与复制可用
test('大文件文本：行号与高亮降级为纯 pre，复制/换行保留', async ({ page }) => {
  await stubClipboard(page)
  await page.goto(`${shareBase}/s/${tokens.big}`)
  await expect(page.locator('.text-body .text-plain')).toBeVisible()
  await expect(page.locator('.text-lines')).toHaveCount(0)
  const lnBtn = page.locator('.preview-tools .tool-btn').filter({ hasText: '行号' })
  await expect(lnBtn).toBeDisabled()
  await page.locator('.preview-tools .tool-btn').filter({ hasText: '自动换行' }).click()
  await expect(page.locator('.text-body .text-plain')).toHaveClass(/with-wrap/)
  await page.locator('.preview-tools .tool-btn').filter({ hasText: '复制全文' }).click()
  expect((await lastCopied(page))?.length).toBe(BIG_CONTENT.length)
})
