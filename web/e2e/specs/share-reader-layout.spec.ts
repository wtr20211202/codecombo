import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD } from '../../tests/helpers'

/**
 * 访客页 reader 布局（P-20261020-7）E2E：
 *   ① 单文件分享 = 文档阅读器：无 .card/.footer、细顶栏（无渐变 hero）、
 *      文件根页无面包屑；md 阅读列 860px + 全宽切换；enhanceArticle 管线
 *      （代码复制/表格拖拽手柄/标题锚点）保留；导出图片从 reader 容器克隆
 *      并产出非空栅格；HTML iframe 贴边（PDF 同 .preview.fill 路径）
 *   ② 目录分享：无卡片全宽表格 + 细顶栏/面包屑；≤700px 修改时间列隐藏并
 *      下移到名称副行；目录内文件进入同一 reader（仅返回/面包屑条）
 *   ③ ≤700px（390/360/320）：顶栏与页面无横向溢出、标题宽度非零、下载常驻
 *      一级、主题/复制/导出/全屏/新标签进「⋯」菜单（40px 热区、可达）
 *   ④ 纯文本：页面底色单滚动（文本主体自身不滚；P-20261020-11 行级渲染 DOM）
 * 访客面打在分享子服务（主端口 +2，经 /api/share/status 动态获取）。
 * 探针文件建在种子项目，跑完清理不残留；目录分享复用仓库 docs/design。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const MD_FILE = 'e2e-share-reader.md'
const HTML_FILE = 'e2e-share-reader.html'
const TXT_FILE = 'e2e-share-reader.txt'
const BIN_FILE = 'e2e-share-reader.bin'
const DIR_PATH = 'docs/design'
const DIR_FILE = 'polish-rounds.md'

const LONG_DESC = '这一列是长说明文字，用于验证阅读列内表格不撑破容器。'.repeat(6)
const MD_CONTENT = [
  '# Reader 布局探针',
  '',
  '正文段落。',
  '',
  '```go',
  'func readerProbe() { return 42 }',
  '```',
  '',
  '| # | 事项 | 说明 | 状态 |',
  '| --- | --- | --- | --- |',
  `| 1 | 接口联调 | ${LONG_DESC} | 待回复 |`,
  '| 2 | 环境准备 | 次长说明文字占位。 | 已完成 |',
  '',
].join('\n')
const HTML_CONTENT = '<!doctype html><html><head><title>reader html</title></head>' +
  '<body><h1>reader-html</h1><p>edge to edge</p></body></html>'
const TXT_CONTENT = Array.from({ length: 160 }, (_, i) => `reader-text-line-${i + 1}`).join('\n')
const BIN_CONTENT = 'reader-binary-probe'

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
let apiCtx: APIRequestContext
let mdToken = ''
let htmlToken = ''
let txtToken = ''
let binToken = ''
let dirToken = ''

async function createShare(path: string): Promise<string> {
  const res = await apiCtx.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: { token?: string } }
  if (!body.data?.token) throw new Error(`share token missing for ${path}`)
  return body.data.token
}

test.beforeAll(async ({ request }) => {
  apiCtx = request
  headers = await unlockHeaders(request)
  projectId = await getProjectId(request, headers)
  shareBase = await getShareBase(request, headers)

  // 探针文件（先删后建幂等，残留会让 create 409）
  for (const f of [MD_FILE, HTML_FILE, TXT_FILE, BIN_FILE]) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: f } })
  }
  const created = [
    [MD_FILE, MD_CONTENT],
    [HTML_FILE, HTML_CONTENT],
    [TXT_FILE, TXT_CONTENT],
    [BIN_FILE, BIN_CONTENT],
  ] as const
  for (const [path, content] of created) {
    const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, { headers, data: { path, content } })
    expect(res.ok()).toBeTruthy()
  }
  mdToken = await createShare(MD_FILE)
  htmlToken = await createShare(HTML_FILE)
  txtToken = await createShare(TXT_FILE)
  binToken = await createShare(BIN_FILE)
  dirToken = await createShare(DIR_PATH)
})

test.afterAll(async ({ request }) => {
  // 撤销本 spec 的全部分享 + 清理探针文件（种子项目仓库不得残留）
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as
    { data?: { token: string }[] }).data || []
  for (const s of list) await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  for (const f of [MD_FILE, HTML_FILE, TXT_FILE, BIN_FILE]) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: f } })
  }
})

async function openReader(page: Page, token: string): Promise<void> {
  await page.goto(`${shareBase}/s/${token}`)
  await expect(page.locator('.md-article h1')).toBeVisible({ timeout: 10_000 })
}

test('单文件 reader：无卡片/细顶栏/阅读列全宽/md 增强与导出图片', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await openReader(page, mdToken)

  // ① 去卡片：旧骨架 .card/.footer 不再存在，页脚与渐变 hero 一并移除
  await expect(page.locator('.card')).toHaveCount(0)
  await expect(page.locator('.footer')).toHaveCount(0)
  const header = page.locator('.header')
  await expect(header).toBeVisible()
  expect((await header.boundingBox())!.height).toBeLessThan(70)
  expect(await header.evaluate(el => getComputedStyle(el).backgroundImage)).toBe('none')
  // 单文件根页不渲染面包屑（文件名已在顶栏）
  await expect(page.locator('.crumbs')).toBeHidden()

  // ② md 阅读列 760~860px + 全宽切换
  const art = page.locator('.md-article')
  const colW = await art.evaluate(el => el.getBoundingClientRect().width)
  expect(colW).toBeGreaterThan(700)
  expect(colW).toBeLessThanOrEqual(861)
  await page.locator('.wide-btn').click()
  await expect(art).toHaveClass(/wide/)
  expect(await art.evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThan(colW + 100)
  await page.locator('.wide-btn').click()
  await expect(art).not.toHaveClass(/wide/)

  // ③ enhanceArticle 管线回归：代码复制按钮/表格拖拽手柄/标题锚点仍在
  await expect(page.locator('.pre-wrap .pre-copy')).toHaveCount(1)
  await expect(page.locator('.tbl-wrap')).toHaveCount(1)
  await expect(page.locator('.md-article table th .col-handle').first()).toBeVisible()
  await expect(page.locator('.md-article h1 .h-anchor')).toHaveCount(1)
  await page.locator('.pre-wrap').hover()
  await page.locator('.pre-copy').click()
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain('readerProbe')

  // ④ 导出图片：克隆源 = reader 容器，栅格化产物非空
  await page.locator('.export-btn').click()
  await expect(page.locator('.export-dialog')).toBeVisible({ timeout: 15_000 })
  const shot = page.locator('.export-dialog img')
  await expect(shot).toBeVisible()
  await expect.poll(() => shot.evaluate(el => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(100)
  await page.locator('.export-foot .btn-ghost').click()
  await expect(page.locator('.export-dialog')).toHaveCount(0)
})

test('≤700px：390/360/320 顶栏不溢出、标题可见、下载一级动作、⋯菜单可达', async ({ page }) => {
  for (const width of [390, 360, 320]) {
    await page.setViewportSize({ width, height: 800 })
    await openReader(page, mdToken)
    const label = `viewport ${width}`
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), label).toBe(true)
    expect(
      await page.locator('.header').evaluate(el => el.scrollWidth <= el.clientWidth + 1),
      `${label} header overflow`,
    ).toBe(true)
    expect(
      await page.locator('.header h1').evaluate(el => el.getBoundingClientRect().width),
      `${label} title width`,
    ).toBeGreaterThan(40)
    // 下载常驻一级；次级动作的桌面入口隐藏，由「⋯」承接
    await expect(page.locator('.header .btn.primary')).toBeVisible()
    await expect(page.locator('.more-btn')).toBeVisible()
    await expect(page.locator('.actions > .theme-select')).toBeHidden()
    await expect(page.locator('.header .icon-btn').first()).toBeHidden()
  }

  // 390px 下「⋯」菜单：复制/导出/全宽/全屏/新标签 + 主题，全部 40px 热区可用
  await page.setViewportSize({ width: 390, height: 844 })
  await openReader(page, mdToken)
  await page.locator('.more-btn').click()
  const menu = page.locator('.more-menu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.more-item')).toHaveCount(5)
  for (const item of await menu.locator('.more-item').all()) {
    expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(39.5)
  }
  const themeSel = menu.locator('.more-theme select')
  await expect(themeSel).toBeVisible()
  await themeSel.selectOption('dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.keyboard.press('Escape')
  await expect(menu).toBeHidden()
  // 新标签打开：菜单项可用且落在当前分享页
  await page.locator('.more-btn').click()
  const popupPromise = page.waitForEvent('popup')
  await menu.locator('.more-item').filter({ hasText: '新标签打开' }).click()
  const popup = await popupPromise
  await expect(popup).toHaveURL(new RegExp(`/s/${mdToken}$`))
  await popup.close()
})

test('768px：桌面动作仍全部可见且顶栏不溢出', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 800 })
  await openReader(page, mdToken)
  expect(await page.locator('.header').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  await expect(page.locator('.header .btn.primary')).toBeVisible()
  await expect(page.locator('.actions > .theme-select')).toBeVisible()
  await expect(page.locator('.header .export-btn')).toBeVisible()
  await expect(page.locator('.wide-btn')).toBeVisible()
  await expect(page.locator('.header .icon-btn')).toHaveCount(2)
  await expect(page.locator('.more-btn')).toBeHidden()
})

test('HTML 贴边 + 目录全宽表格 + 目录内文件返回链', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })

  // ① HTML（与 PDF 同 .preview.fill 路径）：iframe 边到边，无 12px 内衬/圆角
  await page.goto(`${shareBase}/s/${htmlToken}`)
  const frame = page.locator('.preview.fill iframe')
  await expect(frame).toBeVisible({ timeout: 10_000 })
  const fb = (await frame.boundingBox())!
  expect(fb.x).toBeLessThanOrEqual(1)
  expect(fb.width).toBeGreaterThanOrEqual(385)
  await expect(page.frameLocator('.preview.fill iframe').locator('h1')).toHaveText('reader-html')
  // 不支持导出的类型：菜单里的导出项如实禁用
  await page.locator('.more-btn').click()
  await expect(page.locator('.more-menu .more-item').filter({ hasText: '导出图片' })).toBeDisabled()
  await page.keyboard.press('Escape')

  // ② 目录分享：无卡片全宽表格 + 细顶栏/面包屑；修改时间列下移
  await page.goto(`${shareBase}/s/${dirToken}`)
  const table = page.locator('table.list')
  await expect(table).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.card')).toHaveCount(0)
  await expect(page.locator('.crumbs')).toBeVisible()
  const tb = (await table.boundingBox())!
  expect(tb.x).toBeLessThanOrEqual(1)
  expect(tb.width).toBeGreaterThanOrEqual(370)
  // 固定列宽后表不横溢：行内下载/复制按钮完整落在视口内（自动布局下长文件名
  // 会把操作列裁到 390px 之外，需横向拖动才能点到）
  expect(await page.locator('.scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
  const acts = (await page.locator('tbody tr').first().locator('.row-acts').boundingBox())!
  expect(acts.x + acts.width).toBeLessThanOrEqual(390)
  await expect(page.locator('th.col-modified')).toBeHidden()
  await expect(page.locator('tbody tr').first().locator('.mtime-m')).toBeVisible()
  // 排序保留：点名称列头出指示符
  await page.locator('table.list th').first().click()
  await expect(page.locator('table.list th .sort-ind')).toHaveCount(1)

  // ③ 目录内文件进入同一 reader，仅保留返回/面包屑条
  await page.locator('tbody tr').filter({ hasText: DIR_FILE }).click()
  await expect(page.locator('.md-article h1')).toBeVisible({ timeout: 10_000 })
  await expect(page.locator('.header h1')).toHaveText(DIR_FILE)
  await expect(page.locator('.crumbs')).toBeVisible()
  await expect(page.locator('.up-btn')).toBeVisible()
  await expect(page.locator('.card')).toHaveCount(0)
  await expect(page.locator('.header .btn.primary')).toBeVisible()
})

test('纯文本：页面底色单滚动，文本主体自身不滚', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto(`${shareBase}/s/${txtToken}`)
  // P-20261020-11 起纯文本走行级渲染（.text-body > .text-lines；超阈值才降级
  // 为单个 pre）——旧 .preview pre 断言迁移到新 DOM，硬约束不变：
  // 文本主体透明底（页面底色单一面）、overflow visible（不自成滚动容器）、
  // 窄屏 12px 档
  const body = page.locator('.preview.text .text-body')
  const lines = body.locator('.text-lines')
  await expect(lines).toContainText('reader-text-line-160', { timeout: 10_000 })
  expect(await body.evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgba(0, 0, 0, 0)')
  expect(await body.evaluate(el => getComputedStyle(el).overflow)).toBe('visible')
  // 自身不滚：写 scrollTop 不生效且无溢出（滚动只发生在页面级 .scroll）
  expect(await body.evaluate(el => {
    el.scrollTop = 120
    return { top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }
  })).toEqual({ top: 0, overflow: 0 })
  expect(await lines.evaluate(el => getComputedStyle(el).fontSize)).toBe('12px')
  await expect(page.locator('.card')).toHaveCount(0)
  const scrolled = await page.locator('.scroll').evaluate(el => {
    const max = el.scrollHeight - el.clientHeight
    el.scrollTop = 120
    return { max, top: el.scrollTop }
  })
  expect(scrolled.max).toBeGreaterThan(0)
  expect(scrolled.top).toBeGreaterThan(0)

  // 信息卡：不支持预览的格式，kv 在窄屏可换行且下载仍可达
  await page.goto(`${shareBase}/s/${binToken}`)
  await expect(page.locator('.info h2')).toHaveText(BIN_FILE, { timeout: 10_000 })
  expect(await page.locator('.info .kv').evaluate(el => getComputedStyle(el).flexWrap)).toBe('wrap')
  await expect(page.locator('.info .kv > div')).toHaveCount(3)
  await expect(page.locator('.info .btn2')).toBeVisible()
  await expect(page.locator('.header .btn.primary')).toBeVisible()
})
