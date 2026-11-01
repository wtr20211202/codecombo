import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 入站事件 Hook E2E（P-20261003-23）：外部事件（CI/监控/脚本）→ 通知中心，
 * 可选 panel: 动作直达工作台面板；独立 sch_ 凭据与 Agent Token 分权限域。
 * 覆盖：
 *   - 生命周期：未签发 → 入站 401；签发 → header/URL 双载体可用；轮换旧值
 *     立即失效；销毁 → 入站整体关闭（401）
 *   - 载荷：title/body/category/action 白名单，action 分拆为 panel + payload；
 *     category=error → type=error；未知 action → 400
 *   - 限流：每凭据 60 条/分钟，第 61 条 429
 *   - 设置页 UI：签发 → 明文一次可见 → 销毁（页签内闭环）
 *   - URL 动作域白名单（P-20261003-164）：空白名单拒绝；设置页配置允许域后
 *     域内放行（action=url 入账）+ 点击通知新窗直达；域外仍拒绝（后缀相似
 *     域不隐式放行）；用例末尾恢复空白名单不污染其他用例
 */

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function revokeIfAny(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.delete(`${API_BASE}/api/hook-token`, { headers })
}

async function rotateToken(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/hook-token/rotate`, { headers })
  expect(res.ok()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token?: string } }).data?.token || ''
  expect(token.startsWith('sch_'), `expect sch_ token, got ${token}`).toBeTruthy()
  return token
}

async function clearNotifications(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  await request.post(`${API_BASE}/api/notifications/clear`, { headers })
}

async function openNotificationCenter(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
}

test.beforeAll(async ({ request }) => {
  await revokeIfAny(request)
  await clearNotifications(request)
})

test.afterAll(async ({ request }) => {
  await revokeIfAny(request)
  await clearNotifications(request)
})

test('凭据生命周期与入站门禁：401/双载体/轮换/销毁', async ({ request }) => {
  // 未签发：入站整体关闭（用户拍板的主动销毁语义）
  const headers = await unlockHeaders(request)
  const meta0 = await request.get(`${API_BASE}/api/hook-token`, { headers })
  expect(((await meta0.json()) as { data?: { exists?: boolean } }).data?.exists).toBeFalsy()
  for (const carrier of [{}, { 'X-Hook-Token': 'sch_' + '0'.repeat(32) }]) {
    const res = await request.post(`${API_BASE}/api/hooks`, {
      headers: carrier,
      data: { title: 'x' },
    })
    expect(res.status(), '无有效凭据必须 401').toBe(401)
  }

  const token = await rotateToken(request)

  // header 载体：完整载荷 + panel 动作
  const viaHeader = await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': token, 'Content-Type': 'application/json' },
    data: {
      title: 'E2E hook CI failed',
      body: 'job=build\nreason=compile error',
      category: 'error',
      action: 'panel:git',
    },
  })
  expect(viaHeader.status()).toBe(200)

  // 通知入账：category=error → type=error，action 分拆为 panel/git
  const list = await request.get(`${API_BASE}/api/notifications`, { headers })
  const items = ((await list.json()) as { data?: { title: string; type: string; category: string; action?: string; actionPayload?: string }[] }).data || []
  const hit = items.find(n => n.title === 'E2E hook CI failed')
  expect(hit, 'hook 事件应入账通知中心').toBeTruthy()
  expect(hit?.category).toBe('error')
  expect(hit?.type).toBe('error')
  expect(hit?.action).toBe('panel')
  expect(hit?.actionPayload).toBe('git')

  // URL 载体兼容：token 在路径段（访问日志由 RedactLogLine 打码，单测覆盖）
  const viaURL = await request.post(`${API_BASE}/api/hooks/${token}`, {
    data: { title: 'E2E hook via url' },
  })
  expect(viaURL.status()).toBe(200)

  // action 白名单：非 panel: 前缀 / 未枚举面板 → 400
  for (const action of ['url:https://example.com', 'panel:dashboard']) {
    const res = await request.post(`${API_BASE}/api/hooks`, {
      headers: { 'X-Hook-Token': token, 'Content-Type': 'application/json' },
      data: { title: 'bad action', action },
    })
    expect(res.status(), `action=${action} 必须 400`).toBe(400)
  }

  // 轮换：旧值立即失效，新值可用
  const rotated = await rotateToken(request)
  expect(rotated).not.toBe(token)
  expect((await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': token, 'Content-Type': 'application/json' },
    data: { title: 'old token' },
  })).status(), '旧凭据轮换后必须 401').toBe(401)
  expect((await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': rotated, 'Content-Type': 'application/json' },
    data: { title: 'new token' },
  })).status()).toBe(200)

  // 销毁：入站立即关闭，元信息回到未签发
  expect((await request.delete(`${API_BASE}/api/hook-token`, { headers })).ok()).toBeTruthy()
  expect((await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': rotated, 'Content-Type': 'application/json' },
    data: { title: 'after revoke' },
  })).status()).toBe(401)
  const meta1 = await request.get(`${API_BASE}/api/hook-token`, { headers })
  expect(((await meta1.json()) as { data?: { exists?: boolean } }).data?.exists).toBeFalsy()
})

test('每凭据限流 60 条/分钟：第 61 条 429', async ({ request }) => {
  test.setTimeout(60000)
  await revokeIfAny(request)
  const token = await rotateToken(request)
  const headers = { 'X-Hook-Token': token, 'Content-Type': 'application/json' }
  for (let i = 1; i <= 60; i++) {
    const res = await request.post(`${API_BASE}/api/hooks`, { headers, data: { title: `E2E hook tick ${i}` } })
    expect(res.status(), `第 ${i} 条应在配额内`).toBe(200)
  }
  const limited = await request.post(`${API_BASE}/api/hooks`, { headers, data: { title: 'E2E hook overflow' } })
  expect(limited.status(), '第 61 条必须 429').toBe(429)
})

test('通知行动作 panel:git：点行直达 Git 面板（入站→通知→动作闭环）', async ({ page, request }) => {
  await revokeIfAny(request)
  const token = await rotateToken(request)
  const title = 'E2E hook panel action'
  const posted = await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': token, 'Content-Type': 'application/json' },
    data: { title, action: 'panel:git' },
  })
  expect(posted.status()).toBe(200)

  await openNotificationCenter(page)
  const row = page.locator('.nc-item').filter({ hasText: title }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  // 行可点（action 存在）→ pendingAction 分发 panel:git → 底部 Git 面板打开
  await row.click()
  await expect(page.locator('.bottom-panel .git-panel')).toBeVisible({ timeout: 8000 })
})

test('设置页：签发后明文一次可见，销毁后回到未签发态', async ({ page, request }) => {
  await revokeIfAny(request)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-security"]').click()
  await page.locator('[data-testid="settings-pane-security"] .n-tabs-tab', { hasText: '入站 Hook' }).click()

  const prefix = page.locator('[data-testid="hook-token-prefix"]')
  await expect(prefix).toContainText('sch_***', { timeout: 3000 })
  await expect(page.locator('[data-testid="hook-token-revoke"]')).toBeDisabled()

  // 签发：明文仅本屏可见（sch_ + 32 hex）
  await page.locator('[data-testid="hook-token-rotate"]').click()
  const plain = page.locator('[data-testid="hook-token-plain"]')
  await expect(plain).toBeVisible({ timeout: 5000 })
  await expect(plain.locator('.token-plain')).toContainText(/^sch_[0-9a-f]{32}$/)
  await expect(prefix).toContainText(/sch_[0-9a-f]{4}\*\*\*/)

  // 销毁：确认后回到未签发态（入站关闭）
  await page.locator('[data-testid="hook-token-revoke"]').click()
  await page.locator('.n-dialog', { hasText: '销毁入站 Hook 凭据' }).getByRole('button', { name: '确认' }).click()
  await expect(prefix).toContainText('sch_***', { timeout: 5000 })
  await expect(page.locator('[data-testid="hook-token-plain"]')).toHaveCount(0)

  // 服务端口径与 UI 同步：入站 401
  expect((await request.post(`${API_BASE}/api/hooks`, {
    headers: { 'X-Hook-Token': 'sch_' + '0'.repeat(32), 'Content-Type': 'application/json' },
    data: { title: 'x' },
  })).status()).toBe(401)
})

test('URL 动作域白名单：空白名单拒绝 / 允许域内放行+点击新窗直达 / 域外拒绝', async ({ page, request }) => {
  test.setTimeout(60000)
  await revokeIfAny(request)
  const token = await rotateToken(request)
  const hookHeaders = { 'X-Hook-Token': token, 'Content-Type': 'application/json' }
  const settingsHeaders = await unlockHeaders(request)

  // ⓪ 自净化：清掉前次运行/retry 残留的允许域（用例对「空白名单」前置态
  // 有假设；恢复点必须先于一切断言，跨 retry 残留才不可能污染本轮）
  await request.put(`${API_BASE}/api/settings`, { headers: settingsHeaders, data: { hookUrlAllowHosts: [] } })

  // ① 默认空清单：url 动作整体关闭（P-23 现状语义保持，仅 panel:）
  const off = await request.post(`${API_BASE}/api/hooks`, {
    headers: hookHeaders,
    data: { title: 'E2E hook url off', action: 'url:https://ci.example.com/build/1' },
  })
  expect(off.status(), '空白名单必须拒绝 url 动作').toBe(400)

  // ② 设置页 UI：入站 Hook 页签配置允许域（UI 保存链，输入框回显归一清单）
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-security"]').click()
  await page.locator('[data-testid="settings-pane-security"] .n-tabs-tab', { hasText: '入站 Hook' }).click()
  // data-testid 落在 .n-input 包裹层（agent-cron-prompt-vars 同款），真实
  // input 在内层——fill/toHaveValue 都要定位到 input 元素
  const allowInput = page.locator('[data-testid="hook-url-allow-input"] input')
  await expect(allowInput).toBeVisible({ timeout: 5000 })

  try {
    await allowInput.fill('ci.example.com')
    await page.locator('[data-testid="hook-url-allow-save"]').click()
    await expect(page.locator('.n-message').filter({ hasText: 'URL 动作允许域已保存' })).toBeVisible({ timeout: 5000 })
    await expect(allowInput).toHaveValue('ci.example.com', { timeout: 5000 })

    // 关设置弹层（settings-modal 的关闭钮是 .settings-close——lock-notify-mute
    // 同款；.n-base-close 在本弹层不存在）
    await page.locator('.n-modal.settings-modal .settings-close').click()

    // ③ 允许域内：放行入账（action=url + payload=完整链接）
    const okRes = await request.post(`${API_BASE}/api/hooks`, {
      headers: hookHeaders,
      data: {
        title: 'E2E hook url allowed',
        body: 'build #1 failed',
        category: 'error',
        action: 'url:https://ci.example.com/build/1',
      },
    })
    expect(okRes.status(), '允许域内 url 动作应放行').toBe(200)
    const list = await request.get(`${API_BASE}/api/notifications`, { headers: settingsHeaders })
    const items = ((await list.json()) as { data?: { title: string; action?: string; actionPayload?: string }[] }).data || []
    const hit = items.find(n => n.title === 'E2E hook url allowed')
    expect(hit, 'url 动作事件应入账').toBeTruthy()
    expect(hit?.action).toBe('url')
    expect(hit?.actionPayload).toBe('https://ci.example.com/build/1')

    // ④ 域外仍拒绝：后缀相似域不隐式放行（精确主机匹配），错误提示含 allowlist
    const blocked = await request.post(`${API_BASE}/api/hooks`, {
      headers: hookHeaders,
      data: { title: 'E2E hook url blocked', action: 'url:https://evil-ci.example.com/x' },
    })
    expect(blocked.status(), '域外主机必须拒绝').toBe(400)
    expect(((await blocked.json()) as { error?: string }).error || '').toContain('allowlist')

    // ⑤ 通知行点击 → 新窗直达（消费链 handleClick action=url → window.open
    // noopener，P-20261007-15 既有形态）。目标域是示例域名（无真实站点），
    // context 级 route 拦截 fulfill——否则 DNS 失败后 popup URL 沦为
    // chrome-error://，断言不到目标形态
    await page.context().route(
      (u: URL) => u.hostname === 'ci.example.com',
      route => route.fulfill({ status: 200, contentType: 'text/plain', body: 'hook e2e target' }),
    )
    const title = 'E2E hook url allowed'
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
    const row = page.locator('.nc-item').filter({ hasText: title }).first()
    await expect(row).toBeVisible({ timeout: 5000 })
    const popupPromise = page.context().waitForEvent('page')
    await row.click()
    const popup = await popupPromise
    await expect.poll(() => popup.url(), { timeout: 8000 }).toContain('ci.example.com/build/1')
  } finally {
    // ⑥ 恢复空白名单（url 动作整体关闭），不污染同实例的其他用例
    await request.put(`${API_BASE}/api/settings`, { headers: settingsHeaders, data: { hookUrlAllowHosts: [] } })
  }
})
