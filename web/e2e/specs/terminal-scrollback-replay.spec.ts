import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端 scrollback 重连重放 E2E（P-20261007-3 分帧发送的产品级回归）：
 *   1. 小缓冲（<256KB 单帧路径）重连全量恢复：会话产出数千行后 page.reload()
 *      触发全新 WS attach，前端 xterm 重建后导出文本含首尾命令标记与大输出
 *      首末行（全量，不缺头不缺尾）；
 *   2. 大缓冲（>256KB 分帧路径）重连：服务端按 128KB 分帧流式重放（对 5s 单帧
 *      deadline 恒超时的 16MB 级缓冲，分帧后不再断连）——客户端收齐全部分帧
 *      （无写超时断连），缓冲尾窗（最近数 MB 内的近期历史）完整恢复，重连后
 *      活命令照常记账；
 *   3. 命令记账不重复（R 哨兵回归）：重放边界哨兵（OSC 133;R）在全部重放块
 *      之后发送——重连后新命令恰好入账一条；重连前已入账的历史命令不被重放的
 *      D 帧二次上报（哨兵失效时前端会把重放段当活命令重复记账）。
 * 已知边界（非本提案范围，单帧旧实现同形态实证为前端存量限制）：>200KB 级
 * 重放客户端 xterm 缓冲只保留尾部约 160KB 文本（roll 中前缀被弃，起始行随
 * 时序漂移）——旧单帧实现在 400KB 场景丢头形态完全一致；16MB 级缓冲旧实现
 * 直接 5s 写超时断连（一帧都到不了），分帧后「连接不断 + 近期历史在」即本
 * 提案的产品语义，全量逐字节恢复由服务端单测（TestReplayLargeChunkedAndSentinelAfter
 * 逐字节对账）与 WS 探针（帧拼接 == /api/terminals/:id/scrollback）背书。
 * 命令记账断言走 GET /api/projects/:id/terminal-history?q=（前端 D 帧上报链的
 * 服务端事实源；服务端 2s 指纹幂等只吸收紧邻重复，跨重连的二次上报会真实落账，
 * 对哨兵回归有区分度）。
 */

const DL_DIR = path.join(os.tmpdir(), 'sc-e2e-terminal-replay')
const HEAD_MARKER = 'sc-replay-head-marker-7777'
const TAIL_MARKER = 'sc-replay-tail-marker-8888'
const POST_MARKER = 'sc-replay-post-marker-9999'
// 大输出 ≈ 12000 行 × ~33B ≈ 400KB：高于 256KB 单帧分界（走分帧路径），低于
// 服务端默认 20000 行 × 80B = 1.6MB 环形缓冲（服务端不丢）
const BIG_LINES = 12000
// 小输出 ≈ 3000 行 ≈ 100KB：低于 256KB 分界（单帧路径），也低于客户端存量
// 保留窗（前端存量限制见头注），全量恢复可断言
const SMALL_LINES = 3000

test.setTimeout(240_000)

let unlockToken = ''

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
}

async function getJson<T>(request: import('@playwright/test').APIRequestContext, url: string): Promise<T> {
  const res = await request.get(`${API_BASE}${url}`, { headers: await unlockHeaders() })
  return ((await res.json()) as { data?: T }).data as T
}

// 清理前置 spec 遗留的终端会话与 docked tab（terminal-restart.spec 同款——
// 旧 tab 的 xterm-screen 拦截点击，全量串行串扰根因）
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

interface ProjCtx {
  page: Page
  request: import('@playwright/test').APIRequestContext
  projectId: string
  sessionId: string
}

// 打开项目 → 终端面板 → 新建会话 → 跑产出命令（cmd for /l 纯速出），
// 轮询服务端缓冲直到尾标记落齐（命令执行完毕的事实源）
async function setupSessionWithOutput(page: Page, request: import('@playwright/test').APIRequestContext, lines: number): Promise<ProjCtx> {
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
  // 命令历史按项目持久且跨 spec 运行/重试累积——产出命令入账前清空，
  // 使「恰好一条 / 不重复」为本次运行语义
  const proj = (await getJson<Array<{ id: string; name: string }>>(request, '/api/projects')).find(x => x.name === 'simple-coding')
  expect(proj, 'simple-coding 项目应已播种').toBeTruthy()
  await request.delete(`${API_BASE}/api/projects/${proj!.id}/terminal-history`, { headers: await unlockHeaders() })

  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(3500)
  await page.locator('.term-tab').last().click()
  await page.waitForTimeout(600)

  await openTerminalAndRun(page, `echo ${HEAD_MARKER}`)
  await openTerminalAndRun(page, `cmd /c "for /l %i in (1,1,${lines}) do @echo replay-line-%i-pad-0123456789"`)
  await openTerminalAndRun(page, `echo ${TAIL_MARKER}`)

  const sessions = await getJson<Array<{ id: string; projectId?: string }>>(request, '/api/terminals')
  const session = sessions.find(s => s.projectId === proj!.id)
  expect(session, '新建终端会话应在册').toBeTruthy()
  const headers = await unlockHeaders()
  await expect
    .poll(async () => {
      const res = await request.get(`${API_BASE}/api/terminals/${session!.id}/scrollback`, { headers })
      return res.text()
    }, { timeout: 60000, intervals: [1500] })
    .toContain(TAIL_MARKER)
  return { page, request, projectId: proj!.id, sessionId: session!.id }
}

// reload = 全新 WS attach：onMounted reconnectSessions 重建 tab 与连接，
// 服务端把缓冲重放（≤256KB 单帧 / 更大分帧）+ R 哨兵
async function reloadAndWaitReplay(ctx: ProjCtx): Promise<string> {
  const { page } = ctx
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  for (let i = 0; i < 5; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    if (await page.locator('[data-testid="rail-terminal"]').isVisible().catch(() => false)) {
      await page.locator('[data-testid="rail-terminal"]').click()
    }
    await page.waitForTimeout(1000)
  }
  await expect(page.locator('.xterm-screen:visible').last()).toBeVisible({ timeout: 30000 })
  await page.waitForTimeout(3000) // 重放+渲染沉降

  // 轮询导出至尾标记可见（重放仍在前送时再等再导）
  let replayed = ''
  for (let i = 0; i < 10; i++) {
    replayed = await exportScrollback(ctx.page, `replay-${ctx.sessionId}`)
    if (replayed.includes(TAIL_MARKER)) break
    await page.waitForTimeout(2000)
  }
  return replayed
}

test('大缓冲（>256KB 分帧路径）重连：连接不断 + 尾窗恢复 + 记账不重复', async ({ page, request }) => {
  const ctx = await setupSessionWithOutput(page, request, BIG_LINES)
  const replayed = await reloadAndWaitReplay(ctx)

  // 分帧路径：连接存活且尾窗完整——大输出末段、尾命令标记俱在
  // （头侧被前端存量保留窗截断，见文件头注「已知边界」；头命令的入账正确性
  // 由下方 history 断言覆盖）
  expect(replayed, '重连后应恢复大输出末行').toContain(`replay-line-${BIG_LINES}-pad`)
  expect(replayed, '重连后应恢复重连前尾命令标记').toContain(TAIL_MARKER)
  // 尾窗断言：导出文本应覆盖大输出后段的连续行（分帧重放连续性抽查）
  const probeLines = [BIG_LINES, BIG_LINES - 1, BIG_LINES - 10, BIG_LINES - 100]
  for (const n of probeLines) {
    expect(replayed, `大输出第 ${n} 行应在尾窗内恢复`).toContain(`replay-line-${n}-pad`)
  }

  // 重连后的活命令：R 哨兵之后到达的 D 才入账——恰好一条
  await openTerminalAndRun(page, `echo ${POST_MARKER}`)
  const historyUrl = (q: string) => `/api/projects/${ctx.projectId}/terminal-history?q=${encodeURIComponent(q)}`
  await expect
    .poll(async () => (await getJson<Array<{ command: string }>>(request, historyUrl(POST_MARKER))).length, {
      timeout: 20000,
      intervals: [1500],
    })
    .toBeGreaterThanOrEqual(1)
  const postEntries = await getJson<Array<{ command: string }>>(request, historyUrl(POST_MARKER))
  expect(postEntries, '重连后活命令应恰好入账一条').toHaveLength(1)

  // R 哨兵回归：重连前已入账命令不因重放二次上报（哨兵失效则此处 ≥2）
  await expect
    .poll(async () => (await getJson<Array<{ command: string }>>(request, historyUrl(HEAD_MARKER))).length, {
      timeout: 10000,
      intervals: [1500],
    })
    .toBe(1)

  // 清场：不留会话给后续 spec
  await request.delete(`${API_BASE}/api/terminals/${ctx.sessionId}`, { headers: await unlockHeaders() })
})

test('小缓冲（≤256KB 单帧路径）重连全量恢复', async ({ page, request }) => {
  const ctx = await setupSessionWithOutput(page, request, SMALL_LINES)
  const replayed = await reloadAndWaitReplay(ctx)

  // 单帧路径全量：首末行 + 前后命令标记俱在（不缺头不缺尾）
  expect(replayed, '重连后应恢复大输出首行').toContain('replay-line-1-pad')
  expect(replayed, '重连后应恢复大输出末行').toContain(`replay-line-${SMALL_LINES}-pad`)
  expect(replayed, '重连后应恢复重连前头命令标记').toContain(HEAD_MARKER)
  expect(replayed, '重连后应恢复重连前尾命令标记').toContain(TAIL_MARKER)

  // 清场
  await request.delete(`${API_BASE}/api/terminals/${ctx.sessionId}`, { headers: await unlockHeaders() })
})
