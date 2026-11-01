import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 分享访客页溯源水印（P-20261005-193）E2E：
 *   1. API 核心链路（file/snippet → 普通分享页）：缺省创建（不带字段）= 开
 *      ——boot 载荷携 wm 且文案 = 分享名+短链尾号+日期（尾号只给 4 位）；
 *      显式 watermark:false = 关——同链幂等重建覆写开关、boot 无 wm 载荷，
 *      记录投影 data.watermark 双向对账
 *   2. 直播页同（浏览器 DOM 断言）：缺省创建对角双标在场（.sc-wm 两标同
 *      文案）；同会话带 false 重建（幂等命中改开关）刷新后水印层消失
 *   3. UI：创建弹层水印勾选框缺省勾中，取消勾选创建 → 记录 watermark=false
 * 探针走种子项目（探针文件用后删）；分享/终端用后清场
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const PROBE = 'e2e-wm-probe.txt'
// 水印文案尾部日期段（服务端本地时区，测试同机；跨零点用正则不锚死具体日）
const WM_TAIL_RE = (head: string) => new RegExp(`^${head} · \\d{4}-\\d{2}-\\d{2}$`)

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
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

/** 开一个普通 shell 终端（直播源，share-terminal-live 同款） */
async function createTerminal(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<string> {
  const res = await request.post(`${BASE}/api/terminals`, { headers, data: { projectId, name: 'e2e-wm-live-src' } })
  expect(res.ok()).toBeTruthy()
  const data = ((await res.json()) as { data?: { id?: string } }).data
  if (!data?.id) throw new Error('terminal id missing')
  return data.id
}

/** 等待文件树出现目标行（uiState 侧栏恢复竞态，share-frozen 同款） */
async function waitForTreeRow(page: Page, name: string) {
  const row = page.locator('.tree-item').filter({ hasText: name }).first()
  const railFiles = page.locator('[data-testid="rail-files"]')
  const deadline = Date.now() + 15000
  for (;;) {
    if (await row.isVisible().catch(() => false)) return
    if (Date.now() > deadline) break
    const expanded = await railFiles.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') await railFiles.click().catch(() => { /* 未挂载重试 */ })
    await page.waitForTimeout(400)
  }
  await expect(row).toBeVisible()
}

test.describe('share-watermark', () => {
  let liveSessionId = ''

  test.beforeEach(async ({ request }) => {
    await cleanupShares(request, await unlockHeaders(request))
  })

  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    if (liveSessionId) {
      await request.delete(`${BASE}/api/terminals/${liveSessionId}`, { headers })
      liveSessionId = ''
    }
    // 探针文件清场（种子项目仓库不得残留；不存在时删除 404 无害）
    const projectId = await getProjectId(request, headers).catch(() => '')
    if (projectId) {
      await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: PROBE } })
    }
  })

  test('普通分享页：缺省开水印在场（名+尾号+日期）；显式关同链覆写无水印', async ({ request }) => {
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)

    // 探针文件（先删后建幂等，防残留 409）
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: PROBE } })
    const mk = await request.post(`${BASE}/api/projects/${projectId}/file/create`, { headers, data: { path: PROBE, content: 'wm-e2e-v1' } })
    expect([200, 201]).toContain(mk.status())

    // 缺省创建（不带 watermark 字段）= 开；记录投影 watermark=true
    const r = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: PROBE } })
    expect(r.ok()).toBeTruthy()
    const share = ((await r.json()) as { data?: { token: string; watermark: boolean } }).data!
    expect(share.watermark).toBe(true)
    const tail = share.token.slice(-4)

    // 访客页 boot 载荷携 wm，文案 = 分享名 + 尾号（…末4位）+ 日期
    const page1 = await request.get(`${shareBase}/s/${share.token}`)
    expect(page1.status()).toBe(200)
    const m = (await page1.text()).match(/"wm":"([^"]+)"/)
    expect(m).toBeTruthy()
    expect(m![1]).toMatch(WM_TAIL_RE(`${PROBE.replace('.', '\\.')} · …${tail}`))

    // 显式关：同目标幂等重建同链、请求值覆写开关，boot 无 wm 载荷
    const r2 = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: PROBE, watermark: false } })
    const share2 = ((await r2.json()) as { data?: { token: string; watermark: boolean } }).data!
    expect(share2.token).toBe(share.token)
    expect(share2.watermark).toBe(false)
    const html2 = await (await request.get(`${shareBase}/s/${share.token}`)).text()
    expect(html2).not.toContain('"wm":')

    // snippet 同链路（API 缺省开；无 UI 开关的形态走缺省基线）
    const sn = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: 'wm-e2e snippet body', name: 'wm-e2e-snippet' } })
    const snData = ((await sn.json()) as { data?: { token: string; watermark: boolean } }).data!
    expect(snData.watermark).toBe(true)
    const snHtml = await (await request.get(`${shareBase}/s/${snData.token}`)).text()
    const sm = snHtml.match(/"wm":"([^"]+)"/)
    expect(sm).toBeTruthy()
    expect(sm![1]).toMatch(WM_TAIL_RE(`wm-e2e-snippet · …${snData.token.slice(-4)}`))
  })

  test('直播页同：缺省开对角双标在场；同会话显式关重建（幂等改开关）水印消失', async ({ page, request }) => {
    const headers = await unlockHeaders(request)
    const projectId = await getProjectId(request, headers)
    const shareBase = await getShareBase(request, headers)

    liveSessionId = await createTerminal(request, headers, projectId)
    const r = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: liveSessionId } })
    expect(r.ok()).toBeTruthy()
    const share = ((await r.json()) as { data?: { token: string; watermark: boolean; name: string } }).data!
    expect(share.watermark).toBe(true)
    const wmRe = WM_TAIL_RE(`${(share.name || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} · …${share.token.slice(-4)}`)

    // 访客页：对角双标（.sc-wm 两 span）在场且文案同源
    await page.goto(`${shareBase}/s/${share.token}`)
    await expect(page.locator('.sc-wm span')).toHaveCount(2)
    await expect(page.locator('.sc-wm .wm-a')).toHaveText(wmRe)
    await expect(page.locator('.sc-wm .wm-b')).toHaveText(wmRe)

    // 同会话带 false 重建：幂等命中同链改开关，刷新后水印层消失
    const r2 = await request.post(`${BASE}/api/share/terminal`, { headers, data: { sessionId: liveSessionId, watermark: false } })
    const share2 = ((await r2.json()) as { data?: { token: string; watermark: boolean } }).data!
    expect(share2.token).toBe(share.token)
    expect(share2.watermark).toBe(false)
    await page.reload()
    await expect(page.locator('.sc-wm')).toHaveCount(0)
  })

  test('UI：创建弹层水印默认勾选，取消勾选创建 → 记录 watermark=false', async ({ page, request }) => {
    test.setTimeout(60_000)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, PROJECT_NAME).first()
    await projectCard.click()
    await page.waitForURL('**/project')
    await waitForTreeRow(page, 'docs')

    // 右键 docs → 生成分享链接 → 创建弹层
    const docsRow = page.locator('.tree-item').filter({ hasText: 'docs' }).first()
    await expect(docsRow).toBeVisible()
    await docsRow.click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()

    // 水印勾选框缺省勾中（缺省开基线；naive-ui n-checkbox 无真实 input，
    // 勾选态走 n-checkbox--checked 类——agent-git-status-summary 同口径）
    const createModal = page.locator('.share-create-modal')
    await expect(createModal).toBeVisible()
    const wmCheck = createModal.locator('[data-testid="share-create-watermark"]')
    await expect(wmCheck).toBeVisible()
    await expect(wmCheck).toHaveClass(/n-checkbox--checked/)
    await wmCheck.click()
    await expect(wmCheck).not.toHaveClass(/n-checkbox--checked/)
    await createModal.locator('[data-testid="share-create-confirm"]').click()

    // 结果卡短链 → 记录态 + 访客页双向对账（关 = 记录 false + boot 无 wm）
    const modal = page.locator('.share-result-modal')
    await expect(modal).toBeVisible()
    const link = await modal.locator('input[readonly]').inputValue()
    const token = link.split('/').pop()!
    const headers = await unlockHeaders(request)
    const listRes = await request.get(`${BASE}/api/share`, { headers })
    const list = ((await listRes.json()) as { data?: { token: string; watermark: boolean }[] }).data || []
    expect(list.find(s => s.token === token)?.watermark).toBe(false)
    const shareBase = await getShareBase(request, headers)
    const html = await (await request.get(`${shareBase}/s/${token}`)).text()
    expect(html).not.toContain('"wm":')
    await request.delete(`${BASE}/api/share/${token}`, { headers })
  })
})
