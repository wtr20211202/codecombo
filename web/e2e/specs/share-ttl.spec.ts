import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, rightClickTreeBackground } from '../../tests/helpers'

/**
 * 分享有效期 E2E（P-20261003-29 opt-in TTL + P-20261020-5 创建即选/默认档/管理器改期）：
 *   1. API 链路：创建 → 设 1 天期（expiresAt 回传）→ 幂等重建保留有效期 →
 *      恢复永久（null 清窗）→ 设过去时点（模拟到期）→ 访客 410 Gone 明确
 *      文案（非 404 模糊）→ 记录被惰性清除 → snippet 拒绝调整（400）
 *   2. 创建有效期闭环：显式 ttl / settings.shareDefaultTTL 默认档 / 显式永久
 *      覆盖默认档；meta 透出 expiresAt；访客页紧凑状态条出「… 过期」段
 *      （P-20261111-5 与快照声明合并单行，全句降为悬停 title）
 *   3. UI 链路：结果卡有效期行（默认「永久」零变化）→ 选 1 天即刻生效 →
 *      管理列表倒计时标记 → 模拟过期后列表「已过期」标记 → 访客 410 文案 →
 *      记录被清
 *   4. UI 链路（创建即选 + 管理器改期）：默认档预选并随创建生效 → 管理器
 *      「有效期」入口改 1 小时 → 行内倒计时对账 → 访客页出到期弱提示
 * 子服务端口经 /api/share/status 动态获取（默认主端口+2）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const SHARE_TARGET = 'docs/design/polish-rounds.md'
const DAY = 24 * 60 * 60 * 1000

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

/** 新建分享默认有效期复位/设置（P-20261020-5）：settings 是全局态，用例前后
 *  都归位到永久，避免默认档偏差泄入同文件其他用例与后续 spec */
async function setShareDefaultTtl(request: APIRequestContext, value: 'permanent' | '1d' | '7d' | '30d'): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.put(`${BASE}/api/settings`, { headers, data: { shareDefaultTTL: value } })
  if (!res.ok()) throw new Error(`set shareDefaultTTL=${value} failed: ${res.status()}`)
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

/** 管理列表里 token 是否仍存在（惰性清理/兜底清扫的观测口） */
async function listHasToken(request: APIRequestContext, headers: Record<string, string>, token: string): Promise<boolean> {
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  return list.some(s => s.token === token)
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
  await setShareDefaultTtl(request, 'permanent')
})

test('TTL API：1 天期 → 幂等保留 → 恢复永久 → 模拟到期访客 410 文案 → 记录被清', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const shareBase = await getShareBase(request, headers)

  // 创建（默认无有效期 = 永久）→ 访客可开，列表不带 expiresAt
  const r1 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  expect(r1.ok()).toBeTruthy()
  const s1 = ((await r1.json()) as { data?: { token: string; expiresAt?: string } }).data
  expect(s1?.token).toBeTruthy()
  expect(s1?.expiresAt).toBeUndefined()
  expect((await request.get(`${shareBase}/s/${s1!.token}/meta`)).status()).toBe(200)

  // 设 1 天期：响应回传 expiresAt（≈now+24h），访客仍 200
  const r2 = await request.post(`${BASE}/api/share/${s1!.token}/expiry`, {
    headers, data: { expiresAt: new Date(Date.now() + DAY).toISOString() },
  })
  expect(r2.ok()).toBeTruthy()
  const s2 = ((await r2.json()) as { data?: { expiresAt?: string } }).data
  const expiresAt = Date.parse(s2?.expiresAt || '')
  expect(expiresAt).toBeGreaterThan(Date.now() + DAY - 60_000)
  expect(expiresAt).toBeLessThan(Date.now() + DAY + 60_000)
  expect((await request.get(`${shareBase}/s/${s1!.token}/meta`)).status()).toBe(200)

  // 幂等重建：同目标重复分享保留 TTL（倒计时不被重复分享清成永久）
  const again = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET } })
  expect(((await again.json()) as { data?: { token: string; expiresAt?: string } }).data).toMatchObject({
    token: s1!.token,
    expiresAt: s2!.expiresAt,
  })

  // 恢复永久：null 清窗，expiresAt 回到缺省
  const r3 = await request.post(`${BASE}/api/share/${s1!.token}/expiry`, { headers, data: { expiresAt: null } })
  expect(r3.ok()).toBeTruthy()
  expect(((await r3.json()) as { data?: { expiresAt?: string } }).data?.expiresAt).toBeUndefined()

  // snippet 拒绝调整（24h 固定窗口是安全边界）；未知 token 404
  const sn = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: 'ttl-e2e-snippet-body' } })
  const snToken = ((await sn.json()) as { data?: { token: string } }).data!.token!
  expect((await request.post(`${BASE}/api/share/${snToken}/expiry`, {
    headers, data: { expiresAt: new Date(Date.now() + DAY).toISOString() },
  })).status()).toBe(400)
  expect((await request.post(`${BASE}/api/share/zzzzzzzzzzzzzzzz/expiry`, {
    headers, data: { expiresAt: new Date(Date.now() + DAY).toISOString() },
  })).status()).toBe(404)

  // 模拟到期（过去时点即「已过期」）：访客页 410 Gone + 明确「已过期」文案
  // （zh 语义锚点，经 Accept-Language 驱动访客页语言）
  await request.post(`${BASE}/api/share/${s1!.token}/expiry`, {
    headers, data: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
  })
  const page410 = await request.get(`${shareBase}/s/${s1!.token}`, {
    headers: { 'Accept-Language': 'zh-CN' },
  })
  expect(page410.status()).toBe(410)
  expect(await page410.text()).toContain('链接已过期')

  // 记录被惰性清除：管理列表不再有该 token；再次访问回落 404（与不存在同观感）
  expect(await listHasToken(request, headers, s1!.token)).toBe(false)
  expect((await request.get(`${shareBase}/s/${s1!.token}/meta`)).status()).toBe(404)
})

// 创建有效期闭环（P-20261020-5）：创建时可选、默认值可配、meta 透出、访客
// 页可见。三条创建路径互相独立（不同目标），避免幂等命中把前一条的窗口带回
test('创建有效期闭环：ttl 预设 / 默认档 / 显式永久 / meta 与访客提示', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const shareBase = await getShareBase(request, headers)
  const HOUR = 60 * 60 * 1000

  try {
    // 显式 ttl=1h：创建响应即带窗口，meta 同键透出，访客页出到期弱提示
    const r1 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: SHARE_TARGET, ttl: '1h' } })
    expect(r1.ok()).toBeTruthy()
    const s1 = ((await r1.json()) as { data?: { token: string; expiresAt?: string } }).data
    const exp1 = Date.parse(s1?.expiresAt || '')
    expect(exp1).toBeGreaterThan(Date.now() + HOUR - 60_000)
    expect(exp1).toBeLessThan(Date.now() + HOUR + 60_000)

    const meta1 = await request.get(`${shareBase}/s/${s1!.token}/meta`)
    expect(meta1.status()).toBe(200)
    // 管理面 shareResponse 走 time.Time（含亚秒/本地偏移），meta 走 UTC
    // RFC3339 秒级——按秒比对而非字符串形态
    expect(Math.floor(Date.parse(((await meta1.json()) as { expiresAt?: string }).expiresAt || '') / 1000))
      .toBe(Math.floor(exp1 / 1000))
    const page1 = await request.get(`${shareBase}/s/${s1!.token}`, { headers: { 'Accept-Language': 'zh-CN' } })
    expect(page1.status()).toBe(200)
    const page1Body = await page1.text()
    // 紧凑状态条（P-20261111-5）：条节点在，且悬停 title 带完整全句
    // （title= 前缀保证命中服务端直出层而非 boot 字典 JSON）
    expect(page1Body).toContain('id="status-banner"')
    expect(page1Body).toContain('title="此链接将于')

    // 默认档 7d：未显式选择的创建应用 settings.shareDefaultTTL
    await setShareDefaultTtl(request, '7d')
    const r2 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: '' } })
    expect(r2.ok()).toBeTruthy()
    const s2 = ((await r2.json()) as { data?: { token: string; expiresAt?: string } }).data
    const exp2 = Date.parse(s2?.expiresAt || '')
    expect(exp2).toBeGreaterThan(Date.now() + 7 * DAY - 60_000)
    expect(exp2).toBeLessThan(Date.now() + 7 * DAY + 60_000)
    const meta2 = await request.get(`${shareBase}/s/${s2!.token}/meta`)
    expect(Math.floor(Date.parse(((await meta2.json()) as { expiresAt?: string }).expiresAt || '') / 1000))
      .toBe(Math.floor(exp2 / 1000))
    const page2 = await request.get(`${shareBase}/s/${s2!.token}`, { headers: { 'Accept-Language': 'zh-CN' } })
    expect(await page2.text()).toContain('id="status-banner"')

    // 显式 permanent 优先于默认档：清窗后 meta 不再携带 expiresAt（永久零值
    // 不落 0001-01-01 哨兵——访客页也不出到期提示）
    const r3 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: 'docs', ttl: 'permanent' } })
    expect(r3.ok()).toBeTruthy()
    const s3 = ((await r3.json()) as { data?: { token: string; expiresAt?: string } }).data
    expect(s3?.expiresAt).toBeUndefined()
    const meta3 = await request.get(`${shareBase}/s/${s3!.token}/meta`)
    expect(((await meta3.json()) as { expiresAt?: string }).expiresAt).toBeUndefined()
    const page3 = await request.get(`${shareBase}/s/${s3!.token}`, { headers: { 'Accept-Language': 'zh-CN' } })
    // 页面 boot 字典恒含 shareExpiresAt 词条（未渲染也存在于 JS 文案表）——
    // 断言状态条节点缺席而非文本缺席
    expect(await page3.text()).not.toContain('id="status-banner"')
  } finally {
    await setShareDefaultTtl(request, 'permanent')
  }
})

test.describe('TTL UI 链路（zh-CN context：访客 410 页按 Accept-Language 出中文文案）', () => {
  test.use({ locale: 'zh-CN' })

  test('结果卡有效期行默认永久 → 选 1 天生效 → 列表倒计时/已过期标记 → 访客 410 → 记录被清', async ({ page, request }) => {
    test.setTimeout(60_000)
    const headers = await unlockHeaders(request)
    await getProjectId(request, headers) // 确认种子项目在位（UI 走文件树入口）
    const shareBase = await getShareBase(request, headers)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, PROJECT_NAME).first()
    await projectCard.click()
    await page.waitForURL('**/project')

    // 创建：背景右键 → 生成分享链接 → 创建弹层确认（live 默认），结果卡带
    // 有效期行（默认「永久」零变化）
    await rightClickTreeBackground(page)
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
    const createModal = page.locator('.share-create-modal')
    await expect(createModal).toBeVisible()
    await createModal.locator('[data-testid="share-create-confirm"]').click()
    const modal = page.locator('.share-result-modal')
    await expect(modal).toBeVisible()
    const ttlRow = modal.locator('[data-testid="share-ttl-row"]')
    await expect(ttlRow).toBeVisible()
    await expect(ttlRow.locator('.n-base-selection')).toContainText('永久')
    await expect(modal.locator('[data-testid="share-ttl-hint"]')).toContainText('默认永久有效')
    const link = await modal.locator('input').inputValue()
    const token = link.split('/').pop()!

    // 选「1 天」即刻生效：toast + 提示行变「有效期至 …」
    await ttlRow.locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '1 天' }).click()
    await expect(page.locator('.n-message')).toContainText('有效期已更新')
    await expect(modal.locator('[data-testid="share-ttl-hint"]')).toContainText('有效期至')

    // 管理视图：该行挂倒计时标记（背景右键 = 项目根分享；1 天窗口取整到
    // 天粒度 → 「1 天后过期」）
    await modal.getByRole('button', { name: '管理全部分享' }).click()
    await expect(modal).toBeHidden()
    const row = page.locator('tr').filter({ hasText: '（项目根）' })
    await expect(row).toBeVisible()
    await expect(row.locator('[data-testid="sm-countdown"]')).toContainText('1 天后过期')

    // 模拟到期：列表刷新后该行显「已过期」（记录仍在，等清理或访客首踩）
    await request.post(`${BASE}/api/share/${token}/expiry`, {
      headers, data: { expiresAt: new Date(Date.now() - 60_000).toISOString() },
    })
    await page.locator('button:has-text("刷新")').first().click()
    await expect(row.locator('[data-testid="sm-countdown"]')).toContainText('已过期')

    // 访客命中：410 Gone + 明确文案；记录随之被惰性清除（管理列表不再有它）
    await page.goto(`${shareBase}/s/${token}`)
    await expect(page.locator('.nf .code')).toHaveText('410')
    await expect(page.locator('.nf .title')).toContainText('链接已过期')
    expect(await listHasToken(request, headers, token)).toBe(false)
  })

  // 创建即选 + 管理器改期（P-20261020-5）：默认档预选随创建生效 → 管理器行
  // 内「有效期」入口改 1 小时 → 倒计时对账 → 访客页出到期弱提示
  test('创建时默认档预选 → 管理器改期 1 小时 → 访客页出到期提示', async ({ page, request }) => {
    test.setTimeout(60_000)
    try {
      await setShareDefaultTtl(request, '7d')
      const headers = await unlockHeaders(request)
      await getProjectId(request, headers) // 确认种子项目在位（UI 走文件树入口）
      const shareBase = await getShareBase(request, headers)

      await fixedLocale(page)
      await gotoAndUnlock(page, '/')
      const projectCard = projectCardByName(page, PROJECT_NAME).first()
      await projectCard.click()
      await page.waitForURL('**/project')

      // 创建弹层：有效期预选服务端默认档 7 天，未主动改选时提示「默认 …」
      await rightClickTreeBackground(page)
      await expect(page.locator('.n-dropdown-menu')).toBeVisible()
      await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()
      const createModal = page.locator('.share-create-modal')
      await expect(createModal).toBeVisible()
      const createTtl = createModal.locator('[data-testid="share-create-ttl-select"]')
      await expect(createTtl).toContainText('7 天')
      await expect(createModal.locator('[data-testid="share-create-ttl-hint"]')).toContainText('默认 7 天后过期')
      await createModal.locator('[data-testid="share-create-confirm"]').click()

      // 结果卡回填生效值：7 天窗口贴近预设档 → 选择器显示「7 天」而非自定义
      const modal = page.locator('.share-result-modal')
      await expect(modal).toBeVisible()
      await expect(modal.locator('[data-testid="share-ttl-row"]')).toContainText('7 天')
      const token = (await modal.locator('input').inputValue()).split('/').pop()!

      // 管理器行内入口：改 1 小时后倒计时即时对账（刷新由弹层 saved 回调触发）
      await modal.getByRole('button', { name: '管理全部分享' }).click()
      await expect(modal).toBeHidden()
      const row = page.locator('tr').filter({ hasText: '（项目根）' })
      await expect(row).toContainText('7 天后过期')
      await row.getByTestId('sm-more-btn').click()
      await page.locator('.n-dropdown-menu').last().getByText('有效期', { exact: true }).click()
      const ttlModal = page.locator('[data-testid="sm-ttl-modal"]')
      await expect(ttlModal).toBeVisible()
      await ttlModal.locator('[data-testid="sm-ttl-select"] .n-base-selection').click()
      await page.locator('.n-base-select-option').filter({ hasText: '1 小时' }).click()
      await ttlModal.locator('[data-testid="sm-ttl-save"]').click()
      await expect(page.locator('.n-message')).toContainText('有效期已更新')
      await expect(ttlModal).toBeHidden()
      await expect(row.locator('[data-testid="sm-countdown"]')).toContainText(/分钟后过期|小时后过期/)

      // 访客页：非永久分享状态条出「… 过期」段（P-20261111-5 与快照声明合并
      // 单行，服务端双语拼装，zh-CN 上下文中文；全句降为悬停 title）
      await page.goto(`${shareBase}/s/${token}`)
      const bar = page.locator('#status-banner')
      await expect(bar).toBeVisible()
      await expect(bar).toContainText('过期')
      await expect(bar).toHaveAttribute('title', /此链接将于/)
    } finally {
      await setShareDefaultTtl(request, 'permanent')
    }
  })
})
