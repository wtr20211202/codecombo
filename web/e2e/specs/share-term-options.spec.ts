import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 终端分享选项弹层 TTL/口令透出（P-20261107-4①⑤）E2E：
 *   1. 直播 TTL：弹层选「1 小时」创建 → 记录 expiresAt ≈ now+1h（ttlMinutes 落库）
 *      → 结果卡有效期行不出现（直播固定窗口不提供）；未选默认档 → 记录 ≈ 30 分钟
 *      （存量语义零变化）
 *   2. 直播口令：弹层输入口令创建 → 记录 hasPassphrase → 访客面 stream 未过门
 *      401 passphrase_required → /gate 凭口令 303 签发门会话 → 错口令 401
 *   3. 直播幂等命中：再创建（无口令）同链且门保持既有（摘门只经管理面显式动作）
 *   4. 快照 TTL/口令：弹层选「1 天」+ 口令创建 → 记录 expiresAt ≈ now+1d
 *      （显式选择经既有 /expiry 端点创建后立即生效）+ hasPassphrase → 访客
 *      /raw 未过门 401；未选 TTL 的快照维持默认 30 天（存量语义）
 * 子服务端口经 /api/share/status 动态获取
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const TERM_PASS = 'term-e2e-pass-1'

interface ShareRow {
  token: string
  kind: string
  expiresAt?: string
  hasPassphrase?: boolean
  /** 锚定的终端会话（shareResponse 投影，terminal 形态恒带） */
  terminalId?: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态；直播撤销同时断流） */
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

async function listShares(request: APIRequestContext, headers: Record<string, string>): Promise<ShareRow[]> {
  const res = await request.get(`${BASE}/api/share`, { headers })
  return (((await res.json()) as { data?: ShareRow[] }).data) || []
}

/** 打开终端面板 → 新建终端 → tab 右键打开选项弹层 */
async function openTermOptionsDialog(page: import('@playwright/test').Page, itemTestId: string): Promise<void> {
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)
  const tab = page.locator('.term-tab').last()
  await tab.click({ button: 'right' })
  await page.locator(`[data-testid="${itemTestId}"]`).click()
  await expect(page.locator('[data-testid="share-term-options"]')).toBeVisible({ timeout: 5000 })
}

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

test.describe('share-term-options', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  test.afterEach(async ({ request }) => {
    await cleanupShares(request)
  })

  test('直播 TTL/口令：弹层选档与口令 → 记录生效 → 访客面过门 → 幂等保持门', async ({ page, request }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    await fixedLocale(page)

    await openTermOptionsDialog(page, 'terminal-live-share')
    // TTL 档位下拉：选「1 小时」；口令输入
    await page.getByTestId('share-term-ttl-select').locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '1 小时' }).click()
    await page.locator('[data-testid="share-term-passphrase"] input').fill(TERM_PASS)
    await page.locator('[data-testid="share-term-confirm"]').click()

    // 结果卡弹出（有效期行不出现：直播固定窗口不提供）
    const dialog = page.locator('.share-result-modal')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.getByTestId('share-ttl-row')).toHaveCount(0)
    await dialog.locator('.result-footer').getByRole('button', { name: '关闭' }).click()

    // 记录面：expiresAt ≈ now+1h（ttlMinutes 落库）+ 口令门
    const rows = await listShares(request, headers)
    const live = rows.find(s => s.kind === 'terminal')
    expect(live?.token).toBeTruthy()
    const remain = new Date(live!.expiresAt!).getTime() - Date.now()
    expect(remain).toBeGreaterThan(HOUR - 5 * 60_000)
    expect(remain).toBeLessThan(HOUR + 5 * 60_000)
    expect(live!.hasPassphrase).toBe(true)

    // 访客面：未过门 → 401 passphrase_required；/gate 凭口令 → 303 签门；错口令 → 401
    const stream = await request.get(`${shareBase}/s/${live!.token}/stream`)
    expect(stream.status()).toBe(401)
    expect((await stream.text())).toContain('passphrase_required')
    const okGate = await request.post(`${shareBase}/s/${live!.token}/gate`, {
      data: { passphrase: TERM_PASS }, maxRedirects: 0,
    })
    expect(okGate.status()).toBe(303)
    const badGate = await request.post(`${shareBase}/s/${live!.token}/gate`, {
      data: { passphrase: 'wrong-pass' },
    })
    expect(badGate.status()).toBe(401)

    // 幂等命中（agent/再分享无口令路径）：同链、门保持既有
    const sessionId = live!.terminalId
    expect(sessionId).toBeTruthy()
    const again = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } })
    expect(again.ok()).toBeTruthy()
    const againRow = ((await again.json()) as { data?: ShareRow }).data
    expect(againRow?.token).toBe(live!.token)
    expect(againRow?.hasPassphrase).toBe(true)
  })

  test('直播默认档：未选 TTL → 记录 ≈ 30 分钟（存量语义零变化）', async ({ page, request }) => {
    test.setTimeout(150_000)
    const headers = await unlockHeaders(request)
    await fixedLocale(page)

    await openTermOptionsDialog(page, 'terminal-live-share')
    await page.locator('[data-testid="share-term-confirm"]').click()
    const dialog = page.locator('.share-result-modal')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.locator('.result-footer').getByRole('button', { name: '关闭' }).click()

    const rows = await listShares(request, headers)
    const live = rows.find(s => s.kind === 'terminal')
    expect(live?.token).toBeTruthy()
    const remain = new Date(live!.expiresAt!).getTime() - Date.now()
    expect(remain).toBeGreaterThan(29 * 60_000)
    expect(remain).toBeLessThan(31 * 60_000)
  })

  test('快照 TTL/口令：弹层选「1 天」+ 口令 → 创建后立即生效；未选维持 30 天', async ({ page, request }) => {
    test.setTimeout(180_000)
    const headers = await unlockHeaders(request)
    const shareBase = await getShareBase(request, headers)
    await fixedLocale(page)

    // 新建终端的 shell 提示符即快照内容（空输出 400——share-terminal-frozen
    // UI 用例同款前提）
    await openTermOptionsDialog(page, 'terminal-frozen-share')
    // ShareTtlPicker：选「1 天」+ 口令
    await page.getByTestId('share-term-ttl-select').locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '1 天' }).click()
    await page.locator('[data-testid="share-term-passphrase"] input').fill(TERM_PASS)
    await page.locator('[data-testid="share-term-confirm"]').click()
    const dialog = page.locator('.share-result-modal')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await dialog.locator('.result-footer').getByRole('button', { name: '关闭' }).click()

    // 记录面：显式 TTL 经既有 /expiry 端点创建后立即生效（≈ now+1d）+ 口令门
    const rows = await listShares(request, headers)
    const snap = rows.find(s => s.kind === 'terminal-frozen')
    expect(snap?.token).toBeTruthy()
    const remain = new Date(snap!.expiresAt!).getTime() - Date.now()
    expect(remain).toBeGreaterThan(DAY - 5 * 60_000)
    expect(remain).toBeLessThan(DAY + 5 * 60_000)
    expect(snap!.hasPassphrase).toBe(true)

    // 访客 /raw 同门：未过门 401、凭口令 303
    const raw = await request.get(`${shareBase}/s/${snap!.token}/raw`)
    expect(raw.status()).toBe(401)
    const gate = await request.post(`${shareBase}/s/${snap!.token}/gate`, {
      data: { passphrase: TERM_PASS }, maxRedirects: 0,
    })
    expect(gate.status()).toBe(303)

    // 对照：未选 TTL 的快照维持默认 30 天（存量语义）
    await openTermOptionsDialog(page, 'terminal-frozen-share')
    await page.locator('[data-testid="share-term-confirm"]').click()
    await expect(page.locator('.share-result-modal')).toBeVisible({ timeout: 15_000 })
    const rows2 = await listShares(request, headers)
    const plain = rows2.filter(s => s.kind === 'terminal-frozen').find(s => s.token !== snap!.token)
    expect(plain?.token).toBeTruthy()
    const remain2 = new Date(plain!.expiresAt!).getTime() - Date.now()
    expect(remain2).toBeGreaterThan(29 * DAY)
    expect(remain2).toBeLessThan(31 * DAY)
    expect(plain!.hasPassphrase).toBeFalsy()
  })
})
