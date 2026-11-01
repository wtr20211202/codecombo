import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 端口注册表（P-20261003-293）E2E：
 *   1. agent 上报链（ops-notify preview.port + X-Session-ID）→ 端口进注册表 →
 *      GET /api/terminals/ports 可见 → 命令面板「端口占用一览」浮层展示
 *      端口/会话/来源 → 点选条目走 activate-terminal 链路直达占用方终端
 *   2. 异会话登记同端口 → 冲突通知入通知中心（点名先占会话 ActionPayload），
 *      登记面归属不变（仍指向先占者）
 *   3. 会话关闭 → 登记摘除（「会话关闭即摘除」生命周期）
 * 前置（spec 内自备）：临时项目 + 两个 UI 建的终端 tab（跳转断言需要 tab 活跃
 * 态）；上报走 agent 上报原语（真实登记链路），不起真实 dev server——注册表是
 * 观测面非 bind 面。端口取值仅入表不监听，任取高位段防与其他面混淆
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_NAME = 'e2e-tports'
const PORT_A = 18123
const PORT_C = 18456

let unlockToken = ''

async function api(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** agent 上报原语（ops 手册 preview.port 约定：X-Session-ID 头携带 CC_TERMINAL_ID） */
function reportPort(sessionId: string, port: number, label = 'e2e dev') {
  return api('POST', '/api/ops-notify', { type: 'preview.port', payload: { port, label } }, { 'X-Session-ID': sessionId })
}

interface SessionRow { id: string; name: string; projectId: string; createdAt: string }

async function projectSessions(): Promise<SessionRow[]> {
  const list = await api('GET', '/api/terminals')
  return ((list.json?.data || []) as SessionRow[])
    .filter(s => s.projectId === projId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

let projId = ''

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-tports')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projId = ((proj.json as { data?: { id?: string } })?.data?.id) || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-tports'), { recursive: true, force: true }) } catch { /* shell 占用忽略 */ }
  // 只摘本 spec 产生的冲突通知（不动通知中心其余条目——同实例并行 worker 共享面）
  const notifs = await api('GET', '/api/notifications')
  for (const n of ((notifs.json?.data || []) as { id: string; titleKey?: string }[])) {
    if (n.titleKey === 'terminal.portConflict.notify.title') {
      await api('POST', `/api/notifications/dismiss/${n.id}`)
    }
  }
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 等 xterm 屏幕文本稳定（连续 500ms 不变且已出现提示符）：新建 pane 的 fit
 *  重绘 churn 期间 ConPTY 反复 resize 重绘横幅，实测早期键入会被 resize 冲掉 */
async function waitXtermSettled(xterm: ReturnType<Page['locator']>) {
  let prev = ''
  for (let i = 0; i < 24; i++) {
    const cur = await xterm.textContent().catch(() => '')
    if (cur && cur === prev && /[>$#] /.test(cur)) return
    prev = cur
    await sleep(500)
  }
}

/** 点入 xterm 并确保焦点落在该 pane 的隐藏输入 textarea 后再键入 */
async function typeViaXterm(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  const textarea = xterm.locator('.xterm-helper-textarea')
  for (let i = 0; i < 5; i++) {
    await xterm.click()
    try {
      await expect(textarea).toBeFocused({ timeout: 500 })
      break
    } catch { /* 焦点未落到目标 pane（重绘夺焦），重点 */ }
    await page.waitForTimeout(300)
  }
  await expect(textarea).toBeFocused()
  await page.keyboard.type(text)
}

/** 进项目页 + 双终端会话就位（输出检索 spec 同款基线）：返回会话列表 */
async function setupTwoTerminals(page: Page): Promise<SessionRow[]> {
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')

  const panel = page.locator('.bottom-panel')
  // 项目切换的异步布局应用可能在点击后把面板收起（持久化布局 showBottomPanel=
  // false 迟到覆盖，分片负载下恢复请求常晚于单次点击，run9 实测两用例同败）——
  // rail 点击幂等重验（terminal-history-repeat 同款守卫）
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })

  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  // 等上轮用例的会话在服务端摘干净（tab × → CloseTerminal 是同步的，但列表
  // 广播到对账有窄时序窗）——否则新建会话与垂死会话混入 rows，A/B 映射错位
  for (let i = 0; i < 10; i++) {
    if ((await projectSessions()).length === 0) break
    await sleep(500)
  }

  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  for (const i of [0, 1]) {
    await newBtn.click()
    const xterm = page.locator('.xterm:visible').last()
    await expect(xterm).toBeVisible({ timeout: 20000 })
    await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
    await waitXtermSettled(xterm)
    await typeViaXterm(page, xterm, `echo E2ETPORTS-TAB-${i}\r`)
    await expect(xterm).toContainText(`E2ETPORTS-TAB-${i}`, { timeout: 15000 })
  }

  // 等会话列表（terminals.changed 广播 → store 对账）出现两个本项目会话
  let rows: SessionRow[] = []
  for (let i = 0; i < 10; i++) {
    rows = await projectSessions()
    if (rows.length >= 2) break
    await sleep(500)
  }
  expect(rows.length).toBeGreaterThanOrEqual(2)
  return rows
}

/** 命令面板命令模式 → 打开「端口占用一览」浮层 */
async function openPortsOverview(page: Page) {
  await page.locator('.header-search-trigger').click()
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>端口占用一览')
  await expect(page.locator('.palette-item').first()).toContainText('端口占用一览', { timeout: 5000 })
  await page.keyboard.press('Enter')
  const overlay = page.locator('[data-testid="terminal-ports"]')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-mask')).toHaveCount(0)
  return overlay
}

test('上报登记 → 浮层展示端口/会话/来源 → 点选直达占用方', async ({ page }) => {
  test.setTimeout(240000)
  const sessions = await setupTwoTerminals(page)
  const [sessionA] = sessions

  // agent 上报链：preview.port + X-Session-ID（真实登记原语）
  const rep = await reportPort(sessionA.id, PORT_A)
  expect(rep.status).toBe(200)

  // 服务端契约：登记面可见、归属正确（先断 API 再走 UI，快失败定位）
  const ports = await api('GET', '/api/terminals/ports')
  expect(ports.status).toBe(200)
  const mine = ((ports.json?.data || []) as { port: number; sessionId: string; sessionName: string; source: string }[])
    .find(e => e.port === PORT_A)
  expect(mine, 'reported port must be registered').toBeTruthy()
  expect(mine!.sessionId).toBe(sessionA.id)
  expect(mine!.sessionName).toBe(sessionA.name)
  expect(mine!.source).toBe('reported')

  // UI：命令面板「端口占用一览」→ 浮层行展示端口 + 会话名 + 来源徽标
  //（按端口文本 + 会话名双重过滤：并行面其他 spec 的会话若探到端口也有登记）
  const overlay = await openPortsOverview(page)
  const row = overlay.locator('.tports-item')
    .filter({ hasText: `:${PORT_A}` })
    .filter({ hasText: sessionA.name })
    .first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText(sessionA.name)
  await expect(row).toContainText('agent 上报')

  // 基线活跃 tab = 后建（B）；点选 A 的条目 → 浮层关闭 + 活跃 tab 切到 A
  const tabs = page.locator('.term-tablist .term-tab')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  await row.click()
  await expect(overlay).toHaveCount(0)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true', { timeout: 10000 })
})

test('异会话登记同端口 → 冲突通知点名先占方，登记归属不变', async ({ page }) => {
  test.setTimeout(240000)
  const sessions = await setupTwoTerminals(page)
  const [sessionA, sessionB] = sessions

  const first = await reportPort(sessionA.id, PORT_C)
  expect(first.status).toBe(200)
  const conflict = await reportPort(sessionB.id, PORT_C)
  expect(conflict.status).toBe(200)

  // 登记面归属不变：端口仍指向先占会话 A（第二个服务通常起不来，先到先得）
  const ports = await api('GET', '/api/terminals/ports')
  const mine = ((ports.json?.data || []) as { port: number; sessionId: string }[])
    .find(e => e.port === PORT_C)
  expect(mine, 'reported port must be registered').toBeTruthy()
  expect(mine!.sessionId).toBe(sessionA.id)

  // 冲突通知入账：点名「A 先占、B 后报」，Action 直达先占方
  let hit: { titleKey?: string; actionPayload?: string } | undefined
  for (let i = 0; i < 10; i++) {
    const notifs = await api('GET', '/api/notifications')
    hit = ((notifs.json?.data || []) as { titleKey?: string; actionPayload?: string }[])
      .find(n => n.titleKey === 'terminal.portConflict.notify.title')
    if (hit) break
    await sleep(500)
  }
  expect(hit, 'conflict notification must be recorded').toBeTruthy()
  expect(hit!.actionPayload).toBe(sessionA.id)
})

test('会话关闭 → 端口登记摘除', async ({ page }) => {
  test.setTimeout(120000)
  // API 建临时会话（跳转用例的 tab 基线不受影响——不进 UI 断言面）
  const created = await api('POST', '/api/terminals', { projectId: projId, name: 'e2e-tports-ephemeral' })
  expect(created.status).toBe(200)
  const id = ((created.json as { data?: { id?: string } })?.data?.id) || ''
  expect(id).not.toBe('')

  const rep = await reportPort(id, PORT_C + 1)
  expect(rep.status).toBe(200)
  let registered = false
  for (let i = 0; i < 10; i++) {
    const ports = await api('GET', '/api/terminals/ports')
    registered = ((ports.json?.data || []) as { port: number }[]).some(e => e.port === PORT_C + 1)
    if (registered) break
    await sleep(500)
  }
  expect(registered, 'port of live session must be listed').toBeTruthy()

  await api('DELETE', `/api/terminals/${id}`)
  for (let i = 0; i < 10; i++) {
    const ports = await api('GET', '/api/terminals/ports')
    if (!((ports.json?.data || []) as { port: number }[]).some(e => e.port === PORT_C + 1)) return
    await sleep(500)
  }
  // CloseTerminal 同步摘除，轮询兜底仅为时序缓冲
  const ports = await api('GET', '/api/terminals/ports')
  expect(((ports.json?.data || []) as { port: number }[]).some(e => e.port === PORT_C + 1)).toBeFalsy()
})
