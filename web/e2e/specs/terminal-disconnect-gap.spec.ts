import { test, expect, type Page, type WebSocketRoute } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 重连输出断档可视化 E2E（P-20261005-233 环形缓冲淘汰的诚实呈现）：
 *
 * 断线期间服务端环形缓冲持续滚动——长断线+高频输出时断线期间输出可能被淘汰，
 * 重连重放拉回的只是现存缓冲，用户看到的输出有缺口但无感知。本 spec 覆盖：
 *   1. 缺口标注：小缓冲（settings 钳到 1000 行 = 80KB）+ 断线窗口期经
 *      broadcast-write 从服务端侧灌入 ~152KB 输出（翻倍于缓冲，断线前的
 *      已见内容必然整体淘汰）→ 重连重放后导出文本含缺口标记行
 *      「⟨ 断线期间部分输出未保留 ⟩」，且断线前标记行已被淘汰不在重放中；
 *   2. 无缺口零误报：同样的断线-重连但窗口期零输出（无淘汰）→ 断线前标记
 *      行完整恢复、缺口标记行零出现（精确判定不误报）。
 *
 * 断连模拟：routeWebSocket 截胡 /ws/terminal/:id——直通期留存 WebSocketRoute
 * 句柄，断连期以句柄 close() 关闭既有 socket（route 只拦新建连接，既有连接
 * 的关闭只能走句柄）；离线窗口内自动重连的新连接即被 close，恢复后点
 * 「立即重连」（退避倒计时免等）放行直通，服务端重放 + G 帧（OSC 133;G）。
 * 灌输出走 POST /api/terminals/broadcast-write（服务端直写 PTY，不依赖断线
 * 期的前端输入通道）；request fixture 独立于页面路由，页面离线不影响 API。
 * 设置项 terminalScrollbackLines 全局持久——beforeAll 读原值、afterAll 恢复，
 * 且必须在创建会话之前写入（缓冲容量在会话创建时定格）。
 */

const HEAD_MARKER = 'sc-gap-head-marker-1111'
const PRE_MARKER = 'sc-gap-pre-marker-2222'
const FLOOD_LAST = 'gapflood-line-4000'
// 缺口标记行（zh-CN 断言：playwright.config locale 固定 zh-CN）
const GAP_MARKER_TEXT = '⟨ 断线期间部分输出未保留 ⟩'
const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-gap')
// 缓冲 2000 行 × 80B 估算 = 160KB 服务端环形缓冲；标记行位于重放头部，要在
// 导出（xterm buffer，scrollback 同为 2000 行）中断言到它，幸存重放的 xterm
// 行数必须 < 2000——长行（~150 字符，pane ~130 列折行后 ≈ bytes/cols 行密度）
// 下幸存 160KB ≈ 1300 行 < 2000 ✓。断线窗口灌 ~600KB（3.75×缓冲）：断线前
// 已见内容必然整体淘汰，重放起点（earliestAvailableAt）落在断线窗口内
const FLOOD_LINES = 4000
const FLOOD_PAD = '-pad-' + '0123456789'.repeat(14) // ~145 字符行体

test.setTimeout(180_000)

let unlockToken = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
}

async function getJson<T>(request: import('@playwright/test').APIRequestContext, url: string): Promise<T> {
  const res = await request.get(`${API_BASE}${url}`, { headers: await unlockHeaders() })
  return ((await res.json()) as { data?: T }).data as T
}

// 清理前置 spec 遗留的终端会话与 docked tab（terminal-scrollback-replay 同款）
async function cleanupLeftoverTerminals(page: Page, request: import('@playwright/test').APIRequestContext) {
  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) return
  const tlist = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((tlist?.data || []) as { id: string; projectId?: string }[])) {
    if (s.projectId === proj.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

async function openTerminalAndRun(page: Page, command: string) {
  const screen = page.locator('.xterm-screen:visible').last()
  await expect(screen).toBeVisible({ timeout: 30000 })
  await screen.click()
  await page.keyboard.type(command)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1200)
}

// 导出客户端 xterm 缓冲为文本（「导出为文本」读 term.buffer——重放链的接收端）
async function exportScrollback(page: Page, name: string): Promise<string> {
  await page.locator('.term-tabbar button[title="更多操作"]').click()
  const exportOpt = page.locator('.n-dropdown-option').filter({ hasText: '导出为文本' }).first()
  await expect(exportOpt).toBeVisible({ timeout: 3000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    exportOpt.click(),
  ])
  fs.mkdirSync(DL_DIR, { recursive: true })
  const file = path.join(DL_DIR, `${name}.txt`)
  await download.saveAs(file)
  return fs.readFileSync(file, 'utf8')
}

// 终端 WS 截胡门：offline=false 直通（留存句柄供断连期关闭既有 socket——
// route 只拦新建连接，既有连接的关闭只能走句柄）；offline=true 新建连接即关
//（自动重连全部落空）。必须在会话首连之前安装（route 不追溯既有连接）
interface TerminalWsGate {
  goOffline: () => Promise<void>
  goOnline: () => void
}
async function installTerminalWsGate(page: Page): Promise<TerminalWsGate> {
  let offline = false
  let established: WebSocketRoute | null = null
  await page.routeWebSocket(/\/ws\/terminal\/[^/]+$/, ws => {
    if (offline) {
      void ws.close()
      return
    }
    established = ws
    void ws.connectToServer()
  })
  return {
    goOffline: async () => {
      offline = true
      await established?.close()
    },
    goOnline: () => {
      offline = false
    },
  }
}

// 恢复在线并触发重连：优先点「立即重连」（退避倒计时免等）；若自动重连预算
// 已耗尽（浮层切换为「重试」）点重试——两条路同走 session.retry（isReconnect
// 语义）；按钮已消失说明自动重连已抢跑成功，无需动作
async function reconnectNow(page: Page) {
  for (const label of ['立即重连', '重试']) {
    const btn = page.locator('.term-pane-error').filter({ hasText: label }).locator('button')
    if (await btn.isVisible().catch(() => false)) {
      await btn.click()
      return
    }
  }
}

interface ProjCtx {
  page: Page
  request: import('@playwright/test').APIRequestContext
  projectId: string
  sessionId: string
}

// 打开项目 → 终端面板 → 新建会话 → 写入断线前标记行（已见内容的事实源）
async function setupSessionWithMarkers(page: Page, request: import('@playwright/test').APIRequestContext): Promise<ProjCtx> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await cleanupLeftoverTerminals(page, request)

  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(3500)
  await page.locator('.term-tab').last().click()
  await page.waitForTimeout(600)

  await openTerminalAndRun(page, `echo ${HEAD_MARKER}`)
  await openTerminalAndRun(page, `echo ${PRE_MARKER}`)

  const proj = (await getJson<Array<{ id: string; name: string }>>(request, '/api/projects')).find(x => x.name === 'simple-coding')
  expect(proj, 'simple-coding 项目应已播种').toBeTruthy()
  const sessions = await getJson<Array<{ id: string; projectId?: string }>>(request, '/api/terminals')
  const session = sessions.find(s => s.projectId === proj!.id)
  expect(session, '新建终端会话应在册').toBeTruthy()
  // 断线前的已见内容已落服务端缓冲（G 帧比对锚点的前提：断开前确实收过输出）
  const headers = await unlockHeaders()
  await expect
    .poll(async () => {
      const res = await request.get(`${API_BASE}/api/terminals/${session!.id}/scrollback`, { headers })
      return res.text()
    }, { timeout: 20000, intervals: [1000] })
    .toContain(PRE_MARKER)
  return { page, request, projectId: proj!.id, sessionId: session!.id }
}

// 断线（句柄关既有 socket）→ 等断开浮层出现 → 离线窗口内执行 duringOffline
//（灌输出等，此刻前端已冻结比对锚点且收不到字节）→ 恢复放行 → 立即重连 →
// 等重放落定后导出（replaySettled 命中即认为重放已到；由用例给出各自特征）
async function disconnectReconnectAndExport(
  ctx: ProjCtx,
  gate: TerminalWsGate,
  replaySettled: (text: string) => boolean,
  duringOffline?: () => Promise<void>,
): Promise<string> {
  await gate.goOffline()
  // 断开浮层出现 = 前端已感知断线（比对锚点冻结于此前的最后一条消息）
  await expect(ctx.page.locator('.term-pane-error').first()).toBeVisible({ timeout: 20000 })
  await ctx.page.waitForTimeout(1500)
  if (duringOffline) await duringOffline()
  gate.goOnline()
  await reconnectNow(ctx.page)

  // 轮询导出至重放落定（重放仍在前送时再等再导）
  let replayed = ''
  for (let i = 0; i < 15; i++) {
    replayed = await exportScrollback(ctx.page, `gap-${ctx.sessionId}`)
    if (replaySettled(replayed)) break
    await ctx.page.waitForTimeout(2000)
  }
  return replayed
}

test.describe('重连输出断档可视化', () => {
  let originalLines: number | null = null

  test.beforeAll(async ({ request }) => {
    const headers = await unlockHeaders()
    const settings = await (await request.get(`${API_BASE}/api/settings`, { headers })).json() as { data?: { terminalScrollbackLines?: number } }
    originalLines = settings.data?.terminalScrollbackLines ?? null
    // 小缓冲 = 160KB 服务端环形缓冲：断线窗口灌 ~600KB 即可整体淘汰断线前内容，
    // 且幸存重放的 xterm 行数（~1300 < 2000）装得下重放头部的标记行
    //（容量在会话创建时定格，故必须在创建会话前写入）
    await request.put(`${API_BASE}/api/settings`, {
      headers,
      data: { terminalScrollbackLines: 2000 },
    })
  })

  test.afterAll(async ({ request }) => {
    const headers = await unlockHeaders()
    if (originalLines !== null) {
      await request.put(`${API_BASE}/api/settings`, {
        headers,
        data: { terminalScrollbackLines: originalLines },
      })
    }
  })

  test('断线窗口缓冲淘汰 → 重连重放含缺口标记行，断线前内容诚实缺失', async ({ page, request }) => {
    // 截胡门必须在会话首连之前安装（route 不追溯既有连接）
    const gate = await installTerminalWsGate(page)
    const ctx = await setupSessionWithMarkers(page, request)
    const headers = await unlockHeaders()

    // 灌输出在离线窗口内执行（broadcast-write 服务端直写 PTY，不依赖前端通道；
    // request fixture 独立于页面路由）：~660KB ≈ 4×160KB 缓冲，断线前已见内容
    // 必然整体淘汰，重放起点（earliestAvailableAt）落在断线窗口内晚于比对锚点
    const duringOffline = async () => {
      const flood = `cmd /c "for /l %i in (1,1,${FLOOD_LINES}) do @echo gapflood-line-%i${FLOOD_PAD}"\r`
      await request.post(`${API_BASE}/api/terminals/broadcast-write`, {
        headers,
        data: { ids: [ctx.sessionId], data: flood },
      })
      await expect
        .poll(async () => {
          const res = await request.get(`${API_BASE}/api/terminals/${ctx.sessionId}/scrollback`, { headers })
          return res.text()
        }, { timeout: 60000, intervals: [1500] })
        .toContain(FLOOD_LAST)
      const duringOfflineText = await (await request.get(`${API_BASE}/api/terminals/${ctx.sessionId}/scrollback`, { headers })).text()
      expect(duringOfflineText, '断线窗口结束后断线前标记行应已被淘汰（缺口前提）').not.toContain(PRE_MARKER)
    }

    const replayed = await disconnectReconnectAndExport(ctx, gate, (t) => t.includes(FLOOD_LAST), duringOffline)

    // 缺口标记行随重放写入输出流（导出/复制随之带走——留档完整性自明）
    expect(replayed, '重连后导出应含断档标记行').toContain(GAP_MARKER_TEXT)
    expect(replayed, '重放应恢复断线窗口内的幸存输出（灌入末行）').toContain(FLOOD_LAST)
    expect(replayed, '断线前已见内容被淘汰，重放中应诚实缺失').not.toContain(PRE_MARKER)

    await request.delete(`${API_BASE}/api/terminals/${ctx.sessionId}`, { headers })
  })

  test('断线窗口零输出（无淘汰）→ 重连重放零缺口标记（不误报）', async ({ page, request }) => {
    const gate = await installTerminalWsGate(page)
    const ctx = await setupSessionWithMarkers(page, request)
    const headers = await unlockHeaders()

    const replayed = await disconnectReconnectAndExport(ctx, gate, (t) => t.includes(PRE_MARKER))

    // 短断线无淘汰：earliestAvailableAt 早于断开前最后输出 → 零标记（精确判定）
    expect(replayed, '断线前标记行应完整恢复').toContain(PRE_MARKER)
    expect(replayed, '无淘汰不得出现缺口标记行').not.toContain(GAP_MARKER_TEXT)

    await request.delete(`${API_BASE}/api/terminals/${ctx.sessionId}`, { headers })
  })
})
