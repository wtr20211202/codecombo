import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, mockRelayAddressContext, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理行内 QR 快捷（P-20261003-282）E2E：
 *   1. 行内 QR 钮 → 弹层出现 → NQrCode canvas 渲染（尺寸非零）
 *   2. 码内容 = 该行访客短链（链接输入框同源断言——qr-relay 同惯例，canvas 像素不解码）
 *   3. 弹层复制按钮走 copyText 通道，剪贴板即访客短链
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性。
 * P-20261020-2 起短链走统一地址计划：这里在页面层把网络候选固定为空、
 * 分享基址/外部地址清空，锁定「回环无候选 → 旧格式 host:sharePort」形态
 * （真实网卡清单随机器漂移，不 mock 会让期望值随 CI 环境变化）。
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

async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await mockRelayAddressContext(page, { addresses: [], externalAccessUrl: '', sharePublicBaseUrl: '' })
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request, page }) => {
  await cleanupShares(request)
  // 页面层路由在用例结束时可能仍有在途请求；忽略回调错误防 teardown 竞态标 flaky
  await page.unrouteAll({ behavior: 'ignoreErrors' })
})

test('行内 QR 钮：弹层渲染二维码 canvas（尺寸非零）且编码该行访客短链', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const create = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET, passphrase: PASSPHRASE } })
  expect(create.ok()).toBeTruthy()
  const token = ((await create.json()) as { data?: { token: string } }).data?.token || ''

  await openManager(page)
  // 回环 + 无候选（页面层 mock）= 旧格式回退：管理器全局徽标红态，
  // 把「此链接仅本机可达」在扫码前就告知（P-20261020-2）
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

  // 码内容断言走同源 input（地址计划同源）：本用例在页面层 mock 了「回环
  // 无候选 + 无分享基址/外部地址」，因此回退旧格式 host:sharePort（P-20261020-2）；
  // 端口动态取，hostname 从 page.url() 派生——隔离实例可能跑在 127.0.0.1
  // 而非 localhost；口令绝不进入码内容（P-20261020-6）
  const status = await request.get(`${BASE}/api/share/status`, { headers })
  const port = ((await status.json()) as { data?: { port?: number } }).data?.port
  const value = await modal.locator('[data-testid="sm-qr-url"] input').inputValue()
  const parsed = new URL(value)
  expect(parsed.port).toBe(String(port))
  expect(parsed.pathname).toBe(`/s/${token}`)
  expect(value).not.toContain(PASSPHRASE)
  // 三色可达性徽标在场（本机回环下按局域网候选显示红/黄/绿之一）
  await expect(modal.locator('[data-testid="sm-qr-status"]')).toBeVisible()
})

test('弹层复制按钮：剪贴板即访客短链（copyText 通道）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const create = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: FILE_TARGET, passphrase: PASSPHRASE } })
  expect(create.ok()).toBeTruthy()
  const token = ((await create.json()) as { data?: { token: string } }).data?.token || ''
  const status = await request.get(`${BASE}/api/share/status`, { headers })
  const port = ((await status.json()) as { data?: { port?: number } }).data?.port

  await openManager(page)
  await page.locator('.sm-card tbody tr').first().locator('button[aria-label="二维码"]').click()
  const modal = page.locator('.n-modal.sm-qr-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })

  await page.context().grantPermissions(['clipboard-read'])
  await modal.getByTestId('sm-qr-copy').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  const parsed = new URL(clip)
  expect(parsed.port).toBe(String(port))
  expect(parsed.pathname).toBe(`/s/${token}`)
  // 裸链复制绝不含口令（口令只在「邀请信息」里，且二维码只编码链接）
  expect(clip).not.toContain(PASSPHRASE)
})
