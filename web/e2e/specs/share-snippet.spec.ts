import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 文本片段分享（排障贴短链，P-20261002-71）E2E：
 *   1. 管理 API：创建（缺省名取首行）/幂等（同内容恒同 token）/32KB 上限 413/
 *      列表 kind=snippet + expiresAt/撤销后失效
 *   2. 访客面：meta kind=snippet、render 代码块形态（正文转义）、raw text/plain 原文
 *   3. UI 链路：编辑器选中 → 命令面板「分享文本片段」→ 确认框（含长度与公开警示）
 *      → 短链结果卡 → 访客页代码块展示 → 管理列表片段徽标 + 过期倒计时 → 撤销
 * 共享 :9999 实例的全局分享列表（workers=1 串行），beforeEach 清空保证确定性
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const OPEN_FILE = 'main.go'
const SNIPPET_CONTENT = 'SCSEED-SNIPPET panic: quota exceeded\n  at e2e-snippet-spec'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getShareBase(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request }) => {
  await cleanupShares(request)
})

test('片段 API：创建/幂等/32KB 上限 413 + 访客 meta/render/raw + 撤销失效', async ({ request }) => {
  const headers = await unlockHeaders(request)

  // 创建：缺省名 = 内容首行；kind=snippet + expiresAt
  const r1 = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_CONTENT } })
  expect(r1.ok()).toBeTruthy()
  const s1 = ((await r1.json()) as { data?: { token: string; kind: string; name: string; expiresAt: string } }).data
  expect(s1?.token).toBeTruthy()
  expect(s1?.kind).toBe('snippet')
  expect(s1?.name).toBe('SCSEED-SNIPPET panic: quota exceeded')
  expect(s1?.expiresAt).toBeTruthy()

  // 幂等：同内容恒同 token
  const r2 = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_CONTENT } })
  const s2 = ((await r2.json()) as { data?: { token: string } }).data
  expect(s2?.token).toBe(s1?.token)

  // 列表：kind=snippet
  const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as
    { data?: { kind: string }[] }).data || []
  expect(list.some(s => s.kind === 'snippet')).toBe(true)

  // 访客面：meta kind=snippet；render 代码块 + 正文转义；raw 原文
  const shareBase = await getShareBase(request, headers)
  const meta = await request.get(`${shareBase}/s/${s1!.token}/meta`)
  const metaBody = (await meta.json()) as { entry?: { kind: string; isDir: boolean }; expiresAt?: string }
  expect(metaBody.entry?.kind).toBe('snippet')
  expect(metaBody.entry?.isDir).toBe(false)
  expect(metaBody.expiresAt).toBeTruthy()

  const render = await request.get(`${shareBase}/s/${s1!.token}/render`)
  expect(render.ok()).toBeTruthy()
  const renderHtml = await render.text()
  expect(renderHtml).toContain('<pre><code>')
  expect(renderHtml).toContain('SCSEED-SNIPPET panic: quota exceeded')

  const raw = await request.get(`${shareBase}/s/${s1!.token}/raw`)
  expect(raw.ok()).toBeTruthy()
  expect(await raw.text()).toBe(SNIPPET_CONTENT)

  // 32KB 上限：超限 413
  const big = await request.post(`${BASE}/api/share/snippet`, {
    headers, data: { content: 'a'.repeat(32 * 1024 + 1) },
  })
  expect(big.status()).toBe(413)

  // 撤销后：访客 meta 立即失效
  const del = await request.delete(`${BASE}/api/share/${s1!.token}`, { headers })
  expect(del.ok()).toBeTruthy()
  const meta2 = await request.get(`${shareBase}/s/${s1!.token}/meta`)
  expect(meta2.status()).toBe(404)
})

test('UI：编辑器选区 → 命令面板分享 → 结果卡 → 访客代码块 → 管理徽标与倒计时', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')

  // 打开根文件并全选（编辑器选区 = 片段弹窗预填来源；选区在失焦后仍保留）
  let tree = page.locator('.file-tree .item-name', { hasText: OPEN_FILE }).first()
  for (let i = 0; i < 3; i++) {
    if (await tree.isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await tree.click()
  await expect(page.locator('.monaco-editor .view-lines').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+a')

  // 命令面板 → 「分享文本片段」：焦点先移出 Monaco（Monaco 吞 Ctrl+K 弦，
  // 同 editor-snippets 先例）；点活跃标签不动选区
  await page.locator('.editor-tab.active').click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>分享文本片段')
  await page.locator('.palette-item').filter({ hasText: '分享文本片段' }).first().click()

  // 确认框：预填编辑器选区 + 长度计数 + 公开警示
  const modal = page.locator('.share-snippet-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  const textarea = modal.locator('textarea')
  await expect(textarea).not.toHaveValue('')
  await expect(modal.getByText('将公开此文本')).toBeVisible()

  // 覆写为确定性内容后创建
  await textarea.fill(SNIPPET_CONTENT)
  await modal.locator('[data-testid="snippet-share-create"]').click()

  // 结果卡：短链形态正确
  const result = page.locator('.share-result-modal')
  await expect(result).toBeVisible({ timeout: 5000 })
  const link = await result.locator('input').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  const token = link.split('/s/')[1]!

  // 访客页：代码块形态展示片段内容
  const shareBase = await getShareBase(page.request, await unlockHeaders(page.request))
  await page.goto(`${shareBase}/s/${token}`)
  await expect(page.locator('.md-article pre code')).toContainText('SCSEED-SNIPPET panic: quota exceeded', { timeout: 10000 })
  await expect(page.locator('.doc-note').filter({ hasText: '自动过期' })).toBeVisible()

  // 管理列表：片段徽标 + 过期倒计时（回主应用后经命令面板切主区视图）
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+k')
  await expect(page.locator('.palette-input input')).toBeVisible({ timeout: 5000 })
  await page.locator('.palette-input input').fill('>文件分享管理')
  await page.locator('.palette-item').filter({ hasText: '打开文件分享管理' }).first().click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })

  const snippetRow = page.locator('.sm-card tbody tr').filter({ hasText: 'SCSEED-SNIPPET panic: quota exceeded' })
  await expect(snippetRow).toBeVisible()
  await expect(snippetRow.locator('.n-tag').filter({ hasText: '片段' })).toBeVisible()
  await expect(snippetRow.locator('.sc-share-countdown')).toContainText(/分钟后过期|小时后过期/)

  // 撤销：行尾「更多」菜单（P-20261020-9）→ 确认弹窗后片段行消失
  await snippetRow.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('撤销', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10_000 })
})

test('UI：片段弹窗可选口令——结果卡邀请复制 + 访客需口令', async ({ page, request }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders(request)
  const passphrase = 'e2e-snippet-pass'
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')

  // 命令面板裸开片段弹窗（无需选区），输入确定性内容 + 访问口令
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>分享文本片段')
  await page.locator('.palette-item').filter({ hasText: '分享文本片段' }).first().click()
  const modal = page.locator('.share-snippet-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  const content = `SCSEED-SNIPPET passphrase ${Date.now()}`
  await modal.locator('textarea').fill(content)
  await modal.locator('[data-testid="snippet-share-passphrase"] input').fill(passphrase)
  await expect(modal.getByText('访客需凭「链接 + 访问口令」查看')).toBeVisible()
  await modal.locator('[data-testid="snippet-share-create"]').click()

  // 结果卡：链接/二维码不含口令，邀请复制含口令
  const result = page.locator('.share-result-modal')
  await expect(result).toBeVisible({ timeout: 5000 })
  const linkInput = result.locator('[data-testid="share-result-qr-url"] input')
  await expect(linkInput).toBeVisible({ timeout: 10000 })
  const link = await linkInput.inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  expect(link).not.toContain(passphrase)
  await page.context().grantPermissions(['clipboard-read'])
  await result.locator('[data-testid="share-invite-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '邀请信息已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain(link)
  expect(clip).toContain(`访问口令：${passphrase}`)

  // 访客面：口令门拦在内容前，直取 raw 亦 401
  const token = link.split('/s/')[1]!
  const shareBase = await getShareBase(request, headers)
  const visitorHtml = await (await request.get(`${shareBase}/s/${token}`)).text()
  expect(visitorHtml).toContain(`action="/s/${token}/gate"`)
  expect((await request.get(`${shareBase}/s/${token}/raw`)).status()).toBe(401)
})
