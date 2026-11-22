import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, mockRelayAddressContext, projectCardByName, closeShareManagerAndClearState, RELAY_FIXTURE_LAN, type RelayAddressFixture } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理行内 QR 快捷（P-20261003-282）E2E：
 *   1. 行内 QR 钮 → 弹层出现 → NQrCode canvas 渲染（尺寸非零）
 *   2. 码内容 = 该行访客短链（链接输入框同源断言——qr-relay 同惯例，canvas 像素不解码）
 *   3. 弹层复制按钮走 copyText 通道，剪贴板即访客短链
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性。
 * P-20261020-2 起短链走统一地址计划；P-20261120-4 起回环入口默认「自动（浏览器
 * 地址）」——页面层 mock 网络候选为空 + 合成回环候选注入，链接 = 当前 origin
 * 的 /s/<token>（主端口同源代理），复制追加 loopbackSelf 可达性警示；显式切换
 * 局域网候选后三方（下拉/hint/链接框）同源且警示切到 candidate 档。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const FILE_TARGET = 'docs/design/polish-rounds.md'
const PASSPHRASE = 'e2e-qr-pass'

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

async function openManager(page: Page, opts?: { addresses?: RelayAddressFixture[] }): Promise<void> {
  await fixedLocale(page)
  await mockRelayAddressContext(page, { addresses: opts?.addresses ?? [], externalAccessUrl: '', sharePublicBaseUrl: '' })
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

// 分享管理开态残留清场（P-20261112-6-S3）：本 spec 用例以管理视图在屏结束，
// 开态即时写落 uiState 后会在后续用例/后续 spec 的新页面恢复出管理视图——rail
// 再点被 toggle 语义反转（closeDshConsoleAndClearState 头注同款事故面）。先卸载
// SPA 防 unload 路径回写，再 API 只清 shareManager 命名空间
test.afterEach(async ({ page, request }) => {
  await closeShareManagerAndClearState(page, request, BASE)
})
test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request, page }) => {
  await cleanupShares(request)
  // 页面层路由在用例结束时可能仍有在途请求；忽略回调错误防 teardown 竞态标 flaky
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

/** API 建一条口令分享并返回 token */
async function createPassShare(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const create = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET, passphrase: PASSPHRASE } })
  expect(create.ok()).toBeTruthy()
  return ((await create.json()) as { data?: { token: string } }).data?.token || ''
}

test('行内 QR 钮：弹层渲染二维码 canvas（尺寸非零）且编码该行访客短链', async ({ page, request }) => {
  const token = await createPassShare(request)

  await openManager(page)
  // 回环入口 + 自动态（页面层 mock 候选为空 + 合成回环项注入，P-20261120-4）：
  // 管理器全局徽标红态，把「本机回环」在扫码前就告知（P-20261020-2）
  const badge = page.locator('[data-testid="sm-share-reach"] [data-testid="share-reach-badge"]')
  await expect(badge).toHaveAttribute('data-tone', 'red')
  await expect(badge).toContainText('本机回环')
  const row = page.locator('.sm-card tbody tr').filter({ hasText: 'polish-rounds.md' })
  await expect(row).toHaveCount(1)

  // 行内 QR 钮（aria-label = tooltip）→ 弹层出现
  await row.locator('button[aria-label="二维码"]').click()
  const modal = page.locator('.n-modal.sm-qr-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  // NQRCode canvas 渲染且尺寸非零（弹窗有 zoom 入场动画，轮询等几何稳定后量）
  const canvas = modal.locator('[data-testid="sm-qr-canvas"] canvas')
  await expect(canvas).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => {
    const box = await canvas.boundingBox()
    return Math.min(box?.width ?? 0, box?.height ?? 0)
  }, { timeout: 3000 }).toBeGreaterThan(0)

  // 码内容断言走同源 input（地址计划同源）：自动态链接 = 当前 origin 的
  // /s/<token>（主端口同源代理，P-20261120-4）——hostname/port 从 page.url()
  // 派生，不假设 127.0.0.1 还是 localhost；口令绝不进入码内容（P-20261020-6）
  const value = await modal.locator('[data-testid="sm-qr-url"] input').inputValue()
  const parsed = new URL(value)
  const pageOrigin = new URL(page.url()).origin
  expect(parsed.origin).toBe(pageOrigin)
  expect(parsed.pathname).toBe(`/s/${token}`)
  expect(value).not.toContain(PASSPHRASE)
  // 三色可达性徽标在场（回环本源 = 红态）
  await expect(modal.locator('[data-testid="sm-qr-status"]')).toBeVisible()
})

test('弹层复制按钮：剪贴板即访客短链（copyText 通道）+ 回环本源警示', async ({ page, request }) => {
  const token = await createPassShare(request)
  const pageOrigin = new URL(BASE).origin

  await openManager(page)
  await page.locator('.sm-card tbody tr').first().locator('button[aria-label="二维码"]').click()
  const modal = page.locator('.n-modal.sm-qr-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByTestId('sm-qr-copy').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  // loopbackSelf 可达性警示（P-20261120-4）：回环本源链接对方无法访问——
  // 成功 toast 之后追加警示（判定 shouldWarnCopy source=loopbackSelf）
  await expect(page.locator('.n-message').filter({ hasText: '本机回环地址生成' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  const parsed = new URL(clip)
  expect(parsed.origin).toBe(pageOrigin)
  expect(parsed.pathname).toBe(`/s/${token}`)
  // 裸链复制绝不含口令（口令只在「邀请信息」里，且二维码只编码链接）
  expect(clip).not.toContain(PASSPHRASE)
})

test('下拉显式选局域网候选：hint/链接框/复制三方同源切换 + candidate 警示', async ({ page, request }) => {
  const token = await createPassShare(request)

  await openManager(page, { addresses: [RELAY_FIXTURE_LAN] })
  await page.locator('.sm-card tbody tr').first().locator('button[aria-label="二维码"]').click()
  const modal = page.locator('.n-modal.sm-qr-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  const input = modal.locator('[data-testid="sm-qr-url"] input')
  const pageOrigin = new URL(page.url()).origin
  const pagePort = new URL(page.url()).port

  // 自动态默认：链接 = 当前 origin + /s/<token>；hint = 回环本源语境
  await expect(input).toHaveValue(`${pageOrigin}/s/${token}`)
  await expect(modal.locator('[data-testid="sm-qr-hint"]')).toContainText('浏览器地址栏')

  // 显式选局域网候选（用户截图二一致性场景）：hint 与链接框同步切到候选 origin
  await modal.locator('[data-testid="sm-qr-address-select"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: RELAY_FIXTURE_LAN.ip }).first().click()
  await expect(input).toHaveValue(`http://${RELAY_FIXTURE_LAN.ip}${pagePort ? `:${pagePort}` : ''}/s/${token}`)
  await expect(modal.locator('[data-testid="sm-qr-hint"]')).toContainText(RELAY_FIXTURE_LAN.ip)

  // 复制 = 当前选中地址 + candidate 警示档（P-20261119-7 文案随显式选择语义修订）
  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByTestId('sm-qr-copy').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.n-message').filter({ hasText: '所选局域网地址生成' })).toBeVisible({ timeout: 5000 })
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://${RELAY_FIXTURE_LAN.ip}${pagePort ? `:${pagePort}` : ''}/s/${token}`)
})
