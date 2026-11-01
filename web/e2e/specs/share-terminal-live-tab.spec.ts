import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 直播中主播侧可见性（P-20261005-161）E2E：
 * 1. UI 全链路：tab 右键「直播分享」→ tab 红点即现（创建点即时对账，不等
 *    轮询）→ 右键直播项翻转为「结束直播」→ 一键撤销红点即摘 → 预先打开的
 *    访客页经 SSE end 帧呈现「已结束」（P-306 既有断流链不变）。
 * 2. 带外创建（agent 代开同链 `POST /api/share/terminal`）：30s 惰性轮询
 *    点亮红点；API 撤销后下轮对账摘除——徽标对主播所有创建/撤销路径闭环。
 *
 * 子服务端口经 /api/share/status 动态获取；直播清场走全量分享撤销。
 */

const PROJECT_NAME = 'simple-coding'
const SESSION_NAME_A = 'e2e-live-tab-ui'
const SESSION_NAME_B = 'e2e-live-tab-poll'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性；终端直播撤销同时断流） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

interface SessionRow { id: string; kind?: string; projectId?: string; name?: string }

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: SessionRow[] }).data || []
}

async function getShareBase(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share/status`, { headers })
  const status = ((await res.json()) as { data?: { running: boolean; port: number; scheme: string } }).data
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

/** 某会话当前直播 token（列表过滤 kind=terminal + terminalId 锚定） */
async function liveTokenOf(request: APIRequestContext, sessionId: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string; kind: string; terminalId?: string }[] }).data || []
  return list.find(s => s.kind === 'terminal' && s.terminalId === sessionId)?.token || ''
}

/** 归一化：进项目 + 底部终端面板可见（tab 条挂载即启动直播轮询） */
async function openTerminalPanel(page: import('@playwright/test').Page, request: APIRequestContext): Promise<string> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  const projId = await getProjectId(request, await unlockHeaders(request))
  // 归一化前置：清掉字母序相邻 spec 遗留的本项目 shell 会话
  for (const s of await listSessions(request)) {
    if (s.kind === 'shell' && s.projectId === projId) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers: await unlockHeaders(request) })
    }
  }
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  return projId
}

test.describe('share-terminal-live-tab', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
  })

  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    for (const s of await listSessions(request)) {
      if (s.name === SESSION_NAME_A || s.name === SESSION_NAME_B) {
        await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
      }
    }
  })

  test('UI 全链路：右键直播分享→红点即现→结束直播→红点即摘→访客页已结束', async ({ page, request }) => {
    test.setTimeout(120_000)
    const projId = await openTerminalPanel(page, request)
    const shareBase = await getShareBase(request)

    // 预置 shell 会话（terminals.changed 对账自动追加 tab）
    await request.post(`${API_BASE}/api/terminals`, { headers: await unlockHeaders(request), data: { projectId: projId, name: SESSION_NAME_A } })
    const tab = page.locator('.term-tab').filter({ hasText: SESSION_NAME_A })
    await expect(tab).toBeVisible({ timeout: 10000 })

    // 无直播：tab 无红点、右键菜单直播项为「直播分享」
    await expect(tab.locator('[data-testid="term-tab-live"]')).toHaveCount(0)
    await tab.click({ button: 'right' })
    const liveItem = page.locator('[data-testid="terminal-live-share"]')
    await expect(liveItem).toHaveText('直播分享')
    await liveItem.click()

    // 创建链即挂徽标（bump 即时对账，不等 30s 轮询）；title 携「直播中」
    await expect(tab.locator('[data-testid="term-tab-live"]')).toBeVisible({ timeout: 10000 })
    await expect(tab.locator('[data-testid="term-tab-live"]')).toHaveAttribute('title', /直播中/)

    // 结果卡可关（模态挡住后续右键）；此刻短链已可取
    const sessionId = (await listSessions(request)).find(s => s.name === SESSION_NAME_A)?.id
    if (!sessionId) throw new Error('live session not found')
    const token = await liveTokenOf(request, sessionId)
    expect(token).toBeTruthy()
    await page.locator('.share-result-modal .result-footer').getByRole('button', { name: '关闭' }).click()
    await expect(page.locator('.share-result-modal')).toBeHidden({ timeout: 5000 })

    // 访客页预先打开：直播中（撤销后对比「已结束」）
    const visitor = await page.context().newPage()
    await visitor.goto(`${shareBase}/s/${token}`)
    await expect(visitor.locator('#badge[data-state="live"]')).toBeVisible({ timeout: 20_000 })

    // 右键同位翻转「结束直播」→ 一键撤销 → 红点即摘
    await tab.click({ button: 'right' })
    await expect(liveItem).toHaveText('结束直播')
    await liveItem.click()
    await expect(tab.locator('[data-testid="term-tab-live"]')).toHaveCount(0, { timeout: 10_000 })

    // 访客页：SSE end 帧 → 「已结束」（P-306 既有断流链，撤销即断流不变）
    await expect(visitor.locator('#badge[data-state="ended"]')).toBeVisible({ timeout: 20_000 })
    await expect(visitor.locator('#stateBox')).toContainText('已结束')
    await visitor.close()
  })

  test('带外创建（agent 代开同链）轮询点亮，API 撤销轮询摘除', async ({ page, request }) => {
    test.setTimeout(120_000)
    const projId = await openTerminalPanel(page, request)

    await request.post(`${API_BASE}/api/terminals`, { headers: await unlockHeaders(request), data: { projectId: projId, name: SESSION_NAME_B } })
    const tab = page.locator('.term-tab').filter({ hasText: SESSION_NAME_B })
    await expect(tab).toBeVisible({ timeout: 10000 })
    await expect(tab.locator('[data-testid="term-tab-live"]')).toHaveCount(0)

    // 带外创建：不经前端动作点，唯一感知通道是 30s 惰性轮询（容忍一个整周期）
    const sessionId = (await listSessions(request)).find(s => s.name === SESSION_NAME_B)?.id
    if (!sessionId) throw new Error('poll session not found')
    await request.post(`${API_BASE}/api/share/terminal`, { headers: await unlockHeaders(request), data: { sessionId } })
    await expect(tab.locator('[data-testid="term-tab-live"]')).toBeVisible({ timeout: 45_000 })

    // API 撤销：下轮对账摘除（同样容忍一个整周期）
    const token = await liveTokenOf(request, sessionId)
    expect(token).toBeTruthy()
    await request.delete(`${API_BASE}/api/share/${token}`, { headers: await unlockHeaders(request) })
    await expect(tab.locator('[data-testid="term-tab-live"]')).toHaveCount(0, { timeout: 45_000 })
  })
})
