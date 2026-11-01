import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 分享 HTML 预览保真 + 脚本隔离 E2E（P-20261020-4）：
 *   ① 阶段 A：外链 CSS/JS 按浏览器可消费的 MIME 回源（/f/）——外链样式必须
 *      真正生效（修复前 text/plain + nosniff 被浏览器拒绝）；字体响应补 ACAO
 *   ② 阶段 A：单文件分享的边界就是 html 文件本身——访客页出「外部资源不会
 *      随文件生效」提示（创建弹层同款提示，经文件树 isDir 带出），同目录子
 *      资源 404
 *   ③ 阶段 B：脚本默认停用（iframe sandbox="" + 响应 CSP sandbox）；访客
 *      显式「运行脚本（隔离）」后只加 allow-scripts，绝不出现
 *      allow-same-origin——内联/外链脚本在隔离沙箱中执行，可随时停止
 * 访客面打在分享子服务（主端口 +2，经 /api/share/status 动态获取）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ = 'simple-coding'
const DIR = 'e2e-share-html'
const INDEX = `${DIR}/index.html`
const CSS = `${DIR}/style.css`
const JS = `${DIR}/app.js`
const FONT = `${DIR}/font.woff2`

// 外链 CSS 把 #out 染成白字（浏览器默认黑字——未加载样式时可区分）；
// 内联脚本 + 外链脚本各留一个执行标记，默认禁用时两者都不得运行
const INDEX_HTML = [
  '<!doctype html>',
  '<html><head><meta charset="utf-8"><link rel="stylesheet" href="style.css"></head>',
  '<body>',
  '<div id="out">script-pending</div>',
  "<script>document.getElementById('out').textContent = 'script-ran';</script>",
  '<script src="app.js"></script>',
  '</body></html>',
].join('\n')
const STYLE_CSS = 'body{background-color:rgb(12,34,56)}#out{color:rgb(250,250,250)}'
const APP_JS = "document.body.dataset.ext = 'ran'"

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
let dirToken = ''
let fileToken = ''

async function createFixtureFile(request: APIRequestContext, path: string, content: string): Promise<void> {
  // 先删后建幂等：残留会让 create 409
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } })
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content },
  })
  expect(res.ok()).toBeTruthy()
}

async function createShare(request: APIRequestContext, path: string): Promise<string> {
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path } })
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
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as {
    data?: { token: string; projectId: string; path: string }[]
  }).data || []
  for (const s of list) {
    if (s.projectId === projectId && (s.path === DIR || s.path === INDEX)) {
      await request.delete(`${BASE}/api/share/${s.token}`, { headers })
    }
  }
  await createFixtureFile(request, INDEX, INDEX_HTML)
  await createFixtureFile(request, CSS, STYLE_CSS)
  await createFixtureFile(request, JS, APP_JS)
  await createFixtureFile(request, FONT, 'FONTDATA-e2e')
  dirToken = await createShare(request, DIR)
  fileToken = await createShare(request, INDEX)
})

test.afterAll(async ({ request }) => {
  for (const token of [dirToken, fileToken]) {
    if (token) await request.delete(`${BASE}/api/share/${token}`, { headers })
  }
  // 夹具目录整树删除（进回收站，不落仓库）；忽略不存在
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: DIR } })
})

test('目录分享：外链 CSS 生效、脚本默认不跑，显式开启后在隔离沙箱运行', async ({ page }) => {
  await page.goto(`${shareBase}/s/${dirToken}`)
  const row = page.locator('.list tbody tr').filter({ hasText: 'index.html' })
  await expect(row).toBeVisible()
  await row.click()

  const iframe = page.locator('.preview iframe')
  await expect(iframe).toBeVisible()
  const frame = page.frameLocator('.preview iframe')

  // ① 外链 CSS 真正生效：修复前 /f/ 把 css 标成 text/plain + nosniff，
  //    浏览器拒绝当样式表，#out 保持默认黑字
  await expect(frame.locator('#out')).toHaveText('script-pending')
  const color = await frame.locator('#out').evaluate(el => getComputedStyle(el).color)
  expect(color).toBe('rgb(250, 250, 250)')

  // ② 默认脚本禁用：内联/外链脚本都未执行；页面给出停用提示与 opt-in 按钮
  expect(await frame.locator('body').getAttribute('data-ext')).toBeNull()
  await expect(page.locator('.sc-html-script-note')).toBeVisible()
  await expect(page.locator('.sc-html-script-note')).toContainText(/脚本|Scripts/)
  // 目录分享没有单文件提示
  await expect(page.locator('.sc-html-single-note')).toHaveCount(0)
  await expect(iframe).toHaveAttribute('sandbox', '')

  // ③ 显式 opt-in：风险确认 → 只放开 allow-scripts → 内联/外链脚本都执行
  await page.locator('.sc-html-script-note .note-act').click()
  await expect(page.locator('.confirm-dialog')).toBeVisible()
  await expect(page.locator('.confirm-dialog')).toContainText(/网络|network/i)
  await page.locator('.confirm-acts .btn2').click()
  await expect(frame.locator('#out')).toHaveText('script-ran')
  await expect(frame.locator('body')).toHaveAttribute('data-ext', 'ran')
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts')
  expect(await iframe.getAttribute('sandbox')).not.toContain('allow-same-origin')

  // ④ 停止脚本：回到默认禁用（iframe 重载，脚本不再执行）
  await page.locator('.sc-html-script-note .note-act').click()
  await expect(frame.locator('#out')).toHaveText('script-pending')
  await expect(iframe).toHaveAttribute('sandbox', '')
})

test('单文件 HTML：外部资源不随文件生效的提示出现，子资源 404', async ({ page, request }) => {
  await page.goto(`${shareBase}/s/${fileToken}`)
  // 单文件提示（meta.share.isDir=false 驱动）+ 脚本开关提示同现
  const singleNote = page.locator('.sc-html-single-note')
  await expect(singleNote).toBeVisible()
  await expect(singleNote).toContainText(/文件夹|folder/i)
  await expect(page.locator('.sc-html-script-note')).toBeVisible()

  // 边界 = 该文件：同目录 style.css 不在分享内
  const sibling = await request.get(`${shareBase}/s/${fileToken}/f/style.css`)
  expect(sibling.status()).toBe(404)
})

/** 文件树行可见性保障：左栏可能处于收起态（rail-files），行出现依赖面板展开 */
async function waitForTreeRow(page: Page, name: string): Promise<void> {
  const row = page.locator('.tree-item').filter({ hasText: name }).first()
  const railFiles = page.locator('[data-testid="rail-files"]')
  const deadline = Date.now() + 15000
  for (;;) {
    if (await row.isVisible().catch(() => false)) return
    if (Date.now() > deadline) break
    const expanded = await railFiles.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') await railFiles.click().catch(() => { /* 未挂载，下一轮重试 */ })
    await page.waitForTimeout(400)
  }
  await expect(row).toBeVisible()
}

/** 行右键 → 生成分享链接 → 创建弹层（live 默认，不确认创建） */
async function openShareCreate(page: Page, row: Locator): Promise<void> {
  await row.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
  await expect(page.locator('.share-create-modal')).toBeVisible()
}

test('创建弹层：单文件 HTML 提示外部资源边界，目录目标不提示', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJ).first().click()
  await page.waitForURL('**/project')
  await waitForTreeRow(page, DIR)
  const dirRow = page.locator('.tree-item').filter({ hasText: DIR }).first()
  // 目录行左键 = 展开夹具目录；文件在子层，右键才带 isDir=false
  await dirRow.click()
  await waitForTreeRow(page, 'index.html')
  const fileRow = page.locator('.tree-item').filter({ hasText: 'index.html' }).first()

  await openShareCreate(page, fileRow)
  const note = page.locator('[data-testid="share-create-single-html-note"]')
  await expect(note).toBeVisible()
  await expect(note).toContainText(/文件夹|folder/i)
  await page.locator('[data-testid="share-create-cancel"]').click()
  await expect(page.locator('.share-create-modal')).toBeHidden()

  // 目录目标：分享边界是整棵子树，不出现单文件提示
  await openShareCreate(page, dirRow)
  await expect(page.locator('[data-testid="share-create-single-html-note"]')).toHaveCount(0)
  await page.locator('[data-testid="share-create-cancel"]').click()
  await expect(page.locator('.share-create-modal')).toBeHidden()
})

test('子资源 MIME 与 /html CSP：css/js 可消费、字体带 CORS、脚本默认 sandbox', async ({ request }) => {
  const css = await request.get(`${shareBase}/s/${dirToken}/f/style.css`)
  expect(css.status()).toBe(200)
  expect(css.headers()['content-type']).toBe('text/css; charset=utf-8')

  const js = await request.get(`${shareBase}/s/${dirToken}/f/app.js`)
  expect(js.status()).toBe(200)
  expect(js.headers()['content-type']).toBe('text/javascript; charset=utf-8')

  // 字体：font/* MIME + ACAO（不透明源下 @font-face 需 CORS）；宽松面只限字体
  const font = await request.get(`${shareBase}/s/${dirToken}/f/font.woff2`)
  expect(font.status()).toBe(200)
  expect(font.headers()['content-type']).toBe('font/woff2')
  expect(font.headers()['access-control-allow-origin']).toBe('*')
  expect(css.headers()['access-control-allow-origin']).toBeUndefined()

  // /html：默认 CSP sandbox；?scripts=1 仅 allow-scripts，绝不 allow-same-origin
  const def = await request.get(`${shareBase}/s/${dirToken}/html?path=index.html`)
  expect(def.status()).toBe(200)
  expect(def.headers()['content-security-policy']).toBe('sandbox')
  const run = await request.get(`${shareBase}/s/${dirToken}/html?path=index.html&scripts=1`)
  expect(run.status()).toBe(200)
  expect(run.headers()['content-security-policy']).toBe('sandbox allow-scripts')
  expect(run.headers()['content-security-policy']).not.toContain('allow-same-origin')
})
