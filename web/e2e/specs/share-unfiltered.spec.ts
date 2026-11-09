import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 分享访客页布局与敏感过滤开关（P-20261106-9）E2E：
 *   1. 冻结快照 unfiltered：API 开关 → 记录 unfiltered + 24h 强制 TTL（SetExpiry
 *      「恢复永久」仍被钳）→ raw 原文 → 与遮蔽快照恒不同链（遮蔽链 raw ***）→
 *      访客页横幅位标「未过滤」（遮蔽链横幅零变化）→ 管理列表投影 unfiltered
 *   2. 直播 unfiltered：创建时定死（幂等命中不覆写）→ 撤销后未过滤重开得新链
 *      （已分发遮蔽链永不接原样输出）→ 访客页 xterm 原样 / 遮蔽链 xterm ***
 *   3. 访客页自适应布局：大屏列宽随视口按比例放宽（不再居中一小块，也不铺满）；
 *      主机终端更宽时继续放宽到视口边距内（页面无横向滚动）
 *   4. UI：tab 右键「直播分享」→ 选项弹层关遮蔽（就地警示）→ 出域确认 → 结果卡
 *      「未过滤」标注 → 管理列表「未过滤」徽标
 * 子服务端口经 /api/share/status 动态获取
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
// 夹具令牌值段 <16 位：低于发版敏感扫描（release-scan token 形态）阈值，无需登记白名单
const SECRET = 'sca_e2eUnfSecret1'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性；直播撤销同时断流） */
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

async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string, name: string): Promise<string> {
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

/** 写一行带敏感令牌的输出并等其进入 scrollback（快照/直播播种都取 scrollback） */
async function echoSecret(request: APIRequestContext, headers: Record<string, string>, sessionId: string, tag: string): Promise<void> {
  const wr = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers, data: { ids: [sessionId], data: `echo ${tag}_${SECRET}_TAIL\r` },
  })
  expect(wr.ok()).toBeTruthy()
  for (let i = 0; i < 40; i++) {
    const res = await request.get(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (res.ok() && (await res.text()).includes(`${tag}_${SECRET}_TAIL`)) return
    await new Promise(r => setTimeout(r, 500))
  }
  throw new Error(`marker ${tag} not in scrollback in time`)
}

interface ShareRow { token: string; kind: string; unfiltered?: boolean; expiresAt?: string }

async function shareData(res: Awaited<ReturnType<APIRequestContext['post']>>): Promise<ShareRow> {
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: ShareRow }).data
  if (!data?.token) throw new Error('share data missing')
  return data
}

/** 访客页列容器（.card）实际宽度 */
async function cardWidth(page: Page): Promise<number> {
  return page.locator('.card').evaluate(el => el.getBoundingClientRect().width)
}

test.describe('share-unfiltered', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  let sessionIds: string[] = []
  test.afterEach(async ({ request }) => {
    await cleanupShares(request)
    const headers = await unlockHeaders(request)
    for (const id of sessionIds) {
      await request.delete(`${BASE}/api/terminals/${id}`, { headers })
    }
    sessionIds = []
  })

  test('冻结快照：未过滤原文 + 24h 强制 TTL + 与遮蔽快照不同链 + 访客页横幅标注', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-unf-frozen')
    sessionIds.push(sessionId)
    await echoSecret(request, headers, sessionId, 'UNF')

    // 未过滤快照：记录标记 + TTL 强制 ≤24h（非 30 天默认）
    const raw = await shareData(await request.post(`${BASE}/api/share/terminal-frozen`, {
      headers, data: { sessionId, unfiltered: true },
    }))
    expect(raw.kind).toBe('terminal-frozen')
    expect(raw.unfiltered).toBe(true)
    const remain = new Date(raw.expiresAt!).getTime() - Date.now()
    expect(remain).toBeLessThanOrEqual(24 * 3600_000 + 60_000)
    expect(remain).toBeGreaterThan(23 * 3600_000)
    const rawText = await (await request.get(`${shareBase}/s/${raw.token}/raw`)).text()
    expect(rawText).toContain(`UNF_${SECRET}_TAIL`)

    // 遮蔽快照（缺省）：不同链、raw 净本 ***、记录无 unfiltered 投影
    const masked = await shareData(await request.post(`${BASE}/api/share/terminal-frozen`, {
      headers, data: { sessionId },
    }))
    expect(masked.token).not.toBe(raw.token)
    expect(masked.unfiltered).toBeUndefined()
    const maskedText = await (await request.get(`${shareBase}/s/${masked.token}/raw`)).text()
    expect(maskedText).toContain('UNF_***_TAIL')
    expect(maskedText).not.toContain(SECRET)

    // SetExpiry「恢复永久」：未过滤记录仍钳在 24h 内（强制短 TTL 不可绕过）
    const exp = await shareData(await request.post(`${BASE}/api/share/${raw.token}/expiry`, {
      headers, data: { expiresAt: null },
    }))
    expect(exp.expiresAt).toBeTruthy()
    expect(new Date(exp.expiresAt!).getTime() - Date.now()).toBeLessThanOrEqual(24 * 3600_000 + 60_000)

    // 管理列表投影：未过滤行带 unfiltered，遮蔽行不带
    const list = ((await (await request.get(`${BASE}/api/share`, { headers })).json()) as { data?: ShareRow[] }).data || []
    expect(list.find(s => s.token === raw.token)?.unfiltered).toBe(true)
    expect(list.find(s => s.token === masked.token)?.unfiltered).toBeUndefined()

    // 访客页：未过滤横幅位换危险标注；遮蔽页横幅零变化
    await page.goto(`${shareBase}/s/${raw.token}`)
    await expect(page.locator('#maskBanner')).toHaveClass(/unfiltered/)
    await expect(page.locator('#maskBanner')).toContainText(/未过滤|Unfiltered/)
    await page.goto(`${shareBase}/s/${masked.token}`)
    await expect(page.locator('#maskBanner')).not.toHaveClass(/unfiltered/)
    await expect(page.locator('#maskBanner')).not.toContainText(/未过滤|Unfiltered/)
  })

  test('直播：创建时定死 → 撤销后未过滤重开得新链 → 访客 xterm 原样 / 遮蔽链 ***', async ({ page, request }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    const sessionId = await createTerminal(request, headers, projectId, 'e2e-unf-live')
    sessionIds.push(sessionId)
    await echoSecret(request, headers, sessionId, 'LIVE')

    // 遮蔽直播（缺省）→ 访客 xterm 遮蔽形态
    const masked = await shareData(await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId } }))
    expect(masked.unfiltered).toBeUndefined()
    await page.goto(`${shareBase}/s/${masked.token}`)
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('.xterm-rows')).toContainText('LIVE_***_TAIL', { timeout: 15_000 })
    await expect(page.locator('.xterm-rows')).not.toContainText(SECRET)

    // 同会话请求未过滤：幂等命中既有遮蔽直播，模式不覆写（创建时定死）
    const again = await shareData(await request.post(`${BASE}/api/share/terminal`, {
      headers, data: { sessionId, unfiltered: true },
    }))
    expect(again.token).toBe(masked.token)
    expect(again.unfiltered).toBeUndefined()

    // 撤销后以未过滤重开：新链（遮蔽链保持死亡），访客 xterm 原样输出 + 横幅标注
    expect((await request.delete(`${BASE}/api/share/${masked.token}`, { headers })).ok()).toBeTruthy()
    const raw = await shareData(await request.post(`${BASE}/api/share/terminal`, {
      headers, data: { sessionId, unfiltered: true },
    }))
    expect(raw.unfiltered).toBe(true)
    expect(raw.token).not.toBe(masked.token)
    expect((await request.get(`${shareBase}/s/${masked.token}`)).status()).toBe(404)
    await page.goto(`${shareBase}/s/${raw.token}`)
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('#maskBanner')).toHaveClass(/unfiltered/)
    await expect(page.locator('.xterm-rows')).toContainText(`LIVE_${SECRET}_TAIL`, { timeout: 15_000 })
  })

  test('访客页自适应：大屏随视口放宽不再居中一小块且不铺满；主机更宽时继续放宽', async ({ page, request }) => {
    test.setTimeout(90_000)
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)
    await page.setViewportSize({ width: 1920, height: 1080 })

    // 缺省尺寸终端：列宽 = 流式下限 82vw（1920 下约 1574）——明显大于旧版 1136
    // 内容区（不再是中间一小块），又留两侧呼吸边（不强制铺满）
    const narrow = await createTerminal(request, headers, projectId, 'e2e-unf-narrow')
    sessionIds.push(narrow)
    const narrowShare = await shareData(await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: narrow } }))
    await page.goto(`${shareBase}/s/${narrowShare.token}`)
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    const w = await cardWidth(page)
    expect(w).toBeGreaterThan(1400)
    expect(w).toBeLessThan(1700)

    // 宽主机终端（先 resize 再开直播：hello 帧尺寸取接线时刻）：超过流式下限后
    // 继续放宽到视口边距内——访客栅格不窄于主机，不折行错乱
    const wide = await createTerminal(request, headers, projectId, 'e2e-unf-wide')
    sessionIds.push(wide)
    const rs = await request.put(`${BASE}/api/terminals/${wide}/resize`, { headers, data: { rows: 40, cols: 300 } })
    expect(rs.ok()).toBeTruthy()
    const wideShare = await shareData(await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: wide } }))
    await page.goto(`${shareBase}/s/${wideShare.token}`)
    await expect(page.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => cardWidth(page), { timeout: 10_000 }).toBeGreaterThan(1800)
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false)
  })

  test('UI：选项弹层关遮蔽 → 出域确认 → 结果卡未过滤标注 → 管理列表未过滤徽标', async ({ page }) => {
    test.setTimeout(120_000)
    await fixedLocale(page)
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
    await page.locator('[data-testid="terminal-live-share"]').click()

    // 选项弹层：遮蔽缺省开、无警示；关闭遮蔽 → 就地警示 + 确认按钮换危险态
    const options = page.locator('[data-testid="share-term-options"]')
    await expect(options).toBeVisible({ timeout: 5000 })
    await expect(page.locator('[data-testid="share-term-unfiltered-warn"]')).toHaveCount(0)
    await page.locator('[data-testid="share-term-mask"]').click()
    await expect(page.locator('[data-testid="share-term-unfiltered-warn"]')).toBeVisible()
    await page.locator('[data-testid="share-term-confirm"]').click()

    // 出域警示确认（取消即零副作用；这里确认继续）
    const egress = page.locator('.n-dialog').filter({ hasText: '确认关闭敏感值遮蔽' })
    await expect(egress).toBeVisible({ timeout: 5000 })
    await egress.getByRole('button', { name: '我知道风险，继续创建' }).click()

    // 结果卡：未过滤标注在场
    const dialog = page.locator('.share-result-modal')
    await expect(dialog).toBeVisible({ timeout: 15_000 })
    await expect(dialog.locator('[data-testid="share-result-unfiltered"]')).toBeVisible()

    // 管理列表：未过滤徽标
    await dialog.getByRole('button', { name: '管理全部分享' }).click()
    await expect(page.locator('.share-manager')).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-testid="sm-unfiltered-badge"]').first()).toBeVisible({ timeout: 20_000 })
  })
})
