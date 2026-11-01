import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令历史会话归属（P-20261004-35）E2E：
 *   1. 多会话命令归属隔离：同项目两条会话各自播种命令历史（terminalId 归属，
 *      与上报点 CC_TERMINAL_ID 同源）+ 一条无归属旧形态条目——历史面板
 *      「按会话过滤」下拉按会话隔离条目，「未归属」组只收旧形态条目，
 *      切回「全部」恢复混流全量（零迁移向后兼容）
 *   2. 会话收工卡：tab 右键「收工摘要」——命令数/失败数/总时长读数与该会话
 *      种子一致，最近 task.progress 摘要（ops-notify 真实链路落库）在列
 * 前置（spec 内自备）：临时空项目 + UI 造 shell 会话（服务端生成 id 即归属
 * 锚点，经 GET /terminals 对账 diff 取得）+ /api/projects/:id/terminal-history
 * API 直播种（同 terminal-history-search 配方，绕开 bash OSC 133 平台缺口）。
 * 播种条目 durationMs 各异：服务端对 2s 窗口内同指纹上报幂等去重
 * （server/store/terminal_history.go duplicateWindow）
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-term-attrib'

let unlockToken = ''
let projectId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** GET /terminals 的 shell 会话 id 集合（项目内）——UI 建会话前后 diff 定位新会话 */
async function projectSessionIds(): Promise<Set<string>> {
  const list = await api('GET', '/api/terminals')
  const sessions = (list.json?.data || []) as { id: string; kind: string; projectId: string }[]
  return new Set(sessions.filter(s => s.kind === 'shell' && s.projectId === projectId).map(s => s.id))
}

interface SeedSession { id: string; name: string }

/** UI 新建一个终端会话并对账回读 id/name（服务端生成名即 tab 展示名） */
async function createSessionViaUi(page: Page, before: Set<string>): Promise<SeedSession> {
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  await newBtn.click()
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  let session: SeedSession | null = null
  await expect.poll(async () => {
    const list = await api('GET', '/api/terminals')
    const sessions = (list.json?.data || []) as { id: string; name: string; kind: string; projectId: string }[]
    const fresh = sessions.find(s => s.kind === 'shell' && s.projectId === projectId && !before.has(s.id))
    if (fresh) session = { id: fresh.id, name: fresh.name }
    return session ? 1 : 0
  }, { timeout: 10000 }).toBe(1)
  return session!
}

async function seedHistory(terminalId: string | undefined, command: string, exitCode: number, durationMs: number) {
  const rec = await api('POST', `/api/projects/${projectId}/terminal-history`,
    terminalId ? { command, exitCode, durationMs, terminalId } : { command, exitCode, durationMs })
  expect(rec.status).toBe(200)
}

/** 打开项目页 + 底部终端面板（面板开合状态跨用例持久，rail 点击幂等重验） */
async function openProjectTerminalPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
}

async function openHistoryPanel(page: Page) {
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const panel = page.locator('.history-panel')
  await expect(panel).toBeVisible()
  return panel
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-term-attrib')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
  await api('DELETE', `/api/projects/${projectId}/terminal-history`)
})

test.afterAll(async () => {
  // 会话收尾（PTY 资源）+ 项目与临时目录清理（历史文档随项目域留存不影响他用例）
  const list = await api('GET', '/api/terminals')
  for (const s of ((list.json?.data || []) as { id: string; kind: string; projectId: string }[])) {
    if (s.kind === 'shell' && s.projectId === projectId) await api('DELETE', `/api/terminals/${s.id}`)
  }
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-term-attrib'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('历史面板按会话过滤：归属条目按会话隔离、未归属旧条目独立成组、全部恢复混流', async ({ page }) => {
  test.setTimeout(180000)
  await openProjectTerminalPanel(page)

  // 两条会话（UI 造，服务端生成 id 即归属锚点）+ 各自播种归属历史 + 一条旧形态
  const before = await projectSessionIds()
  const sessA = await createSessionViaUi(page, before)
  const sessB = await createSessionViaUi(page, await projectSessionIds())
  await seedHistory(sessA.id, 'echo attrib-a-1', 0, 111)
  await seedHistory(sessA.id, 'echo attrib-a-2', 3, 222)
  await seedHistory(sessB.id, 'echo attrib-b-1', 0, 333)
  await seedHistory(sessB.id, 'echo attrib-b-2', 0, 444)
  await seedHistory(undefined, 'echo attrib-legacy', 0, 55)

  const panel = await openHistoryPanel(page)

  // 全部视图：5 条混流（含旧形态未归属条目）
  const items = panel.locator('.history-item')
  await expect(items.filter({ hasText: 'echo attrib-a-1' }).first()).toBeVisible({ timeout: 10000 })
  await expect(items).toHaveCount(5)

  // 会话过滤下拉：选会话 A 只出 A 的 2 条（含失败 1 条）。
  // n-select 选项菜单 teleport 到 body 级 portal，不从 .history-panel 内找
  //（agent-git-status-summary 等既有 spec 同款 page 级定位）
  await panel.locator('[data-testid="history-session-filter"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: sessA.name }).click()
  await expect(items.filter({ hasText: 'echo attrib-a-1' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'echo attrib-a-2' })).toHaveCount(1)
  await expect(items.filter({ hasText: 'echo attrib-b-1' })).toHaveCount(0)
  await expect(items.filter({ hasText: 'echo attrib-legacy' })).toHaveCount(0)

  // 「未归属」组：只收旧形态条目（升级兼容面）
  await panel.locator('[data-testid="history-session-filter"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: '未归属' }).click()
  await expect(items).toHaveCount(1)
  await expect(items.filter({ hasText: 'echo attrib-legacy' })).toHaveCount(1)

  // 切回「全部会话」：混流恢复
  await panel.locator('[data-testid="history-session-filter"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: '全部会话' }).click()
  await expect(items).toHaveCount(5)
})

test('收工摘要卡：命令数/失败数/总时长按会话聚合 + 最近 task.progress 摘要在列', async ({ page }) => {
  test.setTimeout(180000)
  await openProjectTerminalPanel(page)

  const before = await projectSessionIds()
  const sess = await createSessionViaUi(page, before)
  await seedHistory(sess.id, 'echo wrapup-ok-1', 0, 100)
  await seedHistory(sess.id, 'echo wrapup-fail', 2, 200)
  await seedHistory(sess.id, 'echo wrapup-ok-2', 0, 300)
  // 最近任务进度（真实链路：ops-notify → 落库流，收工卡按 sessionId 拉取）
  const notify = await api('POST', '/api/ops-notify', {
    type: 'task.progress',
    payload: { task: 'e2e-wrapup-task', status: 'done', step: '收尾核验', sessionId: sess.id },
  })
  expect(notify.status).toBe(200)

  // tab 右键 → 收工摘要
  const tab = page.locator('.term-tab').filter({ hasText: sess.name })
  await expect(tab).toBeVisible({ timeout: 10000 })
  await tab.click({ button: 'right' })
  await page.locator('[data-testid="terminal-wrap-up"]').click()
  const card = page.locator('[data-testid="terminal-wrap-up-card"]')
  await expect(card).toBeVisible()

  // 四读数与会话种子一致：3 命令 / 1 失败 / 600ms 总时长 / 最近活动非空
  const stats = card.locator('[data-testid="wrap-up-stats"]')
  await expect(stats.locator('.wuc-stat').filter({ hasText: '命令数' }).locator('.wuc-stat-value')).toHaveText('3')
  await expect(stats.locator('.wuc-stat').filter({ hasText: '失败' }).locator('.wuc-stat-value')).toHaveText('1')
  await expect(stats.locator('.wuc-stat').filter({ hasText: '总时长' }).locator('.wuc-stat-value')).toHaveText('600ms')
  await expect(stats.locator('.wuc-stat').filter({ hasText: '最近活动' }).locator('.wuc-stat-value')).not.toHaveText('—')

  // 最近 task.progress 摘要：任务名 + 已完成态在列
  const progress = card.locator('[data-testid="wrap-up-progress"]')
  await expect(progress.locator('.wuc-progress-task').filter({ hasText: 'e2e-wrapup-task' })).toBeVisible({ timeout: 10000 })
  await expect(progress.locator('.n-tag').filter({ hasText: '已完成' })).toBeVisible()
  await expect(progress.locator('.wuc-progress-step').filter({ hasText: '收尾核验' })).toBeVisible()
})
