import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, waitForAppReady, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 重连补拉注册表覆盖面 E2E——内建五域补齐锁定（P-20261003-235）
 *
 * 动机：重连补拉的覆盖对象此前无端到端锁定，后续改动可能静默漏掉某类补拉。
 * 既有两 spec 已锁两域：ws-reconnect-refetch.spec（project 域，项目 WS 触发链）
 * + ops-reconnect-refetch.spec（approvals 域，ops 通道触发链）；本文件补齐其余
 * 三个内建域的「断连→重连→注册表全表遍历→该域 refetch 恢复」用例：
 *   - asks 域：ops 通道断连窗口期的 input.request 广播不可回放，重连后
 *     seedPending 补账 → 全局提问卡自动入堆（首页，零交互）
 *   - notification 域：通知 WS 断连窗口期落库的通知通知广播落空，重连后
 *     loadHistory 按 id 合并 → 通知中心自动入列（项目页，零交互）
 *   - terminals 域：ops 通道断连窗口期新建的会话 terminals.changed 快照广播
 *     丢失，重连后 refresh 重拉列表 → 管理页自动入列（项目页，零交互）
 *
 * 断连模拟沿用既有范式：routeWebSocket 截胡目标 WS（连接即 close），恢复时
 * 放行直通 + window 'online' 事件触发 useWebSocketBase/useOpsChannel 的
 * handleRecovery 立即重连。只截一个通道、全部 HTTP API 不受影响；断言聚焦
 * 最小面——断连窗口期经 API 造的数据在重连后自动出现（期间零交互、该数据
 * 无其他到达路径：各域 store 均无轮询兜底，列表唯一更新源就是注册表补拉）。
 *
 * 域增删的更新义务见单测 reconnectRefetch.coverage.test.ts：新增补拉域须
 * 在本族 spec（含本文件）补对应恢复用例。
 */

const OPS_WS_PATTERN = /\/ws\/ops-channel$/
const NOTIF_WS_PATTERN = /\/ws\/notifications$/

const PROJ = 'e2e-reconnect-coverage'
const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-reconnect-coverage')
/** 终端会话 cwd 夹具（服务端真实 PTY 的工作目录） */
const TERM_CWD = path.join(os.tmpdir(), 'sc-e2e-reconnect-coverage-term')
/** 各域造数锚点前缀（also 清理对账键） */
const ASK_PREFIX = 'reconnect-cov-ask'
const NOTIFY_PREFIX = 'reconnect-cov-notify'
const SESSION_PREFIX = 'reconnect-cov-session-'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// afterAll 不能用 test 级 request fixture（ops-reconnect-refetch 同款收尾）：
// 用裸 fetch 复刻解锁头
async function unlockHeadersFetch(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 提问（卡片全局常驻，残留污染后续用例的 .ask-card 计数；
 *  全局清与 ops-reconnect-refetch 的 cleanupApprovals 同先例——misc 批内无
 *  其他 spec 依赖 pending 提问） */
async function cleanupAsks(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-ask`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-ask/${a.id}/answer`, {
      headers, data: { answer: 'e2e cleanup' },
    }).catch(() => {})
  }
}

/** 只清理本 spec 前缀的通知/会话（比全局清空侵入小；重跑残留自愈） */
async function cleanupMyFootprint(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const notes = await (await request.get(`${API_BASE}/api/notifications`, { headers })).json()
  for (const n of ((notes?.data || []) as { id: string; title: string }[])) {
    if (n.title.startsWith(NOTIFY_PREFIX)) {
      await request.post(`${API_BASE}/api/notifications/dismiss/${n.id}`, { headers }).catch(() => {})
    }
  }
  const terms = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((terms?.data || []) as { id: string; name: string }[])) {
    if (s.name.startsWith(SESSION_PREFIX)) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => {})
    }
  }
}

/** 进入首页并装好目标 WS 截胡（offline 期）。返回恢复函数：放行新连接直通 */
async function enterOfflineHome(page: Page, pattern: RegExp): Promise<() => void> {
  let offline = true
  await page.routeWebSocket(pattern, ws => {
    if (offline) {
      void ws.close()
      return
    }
    void ws.connectToServer()
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await waitForAppReady(page)
  return () => { offline = false }
}

/** 进入指定项目页并装好目标 WS 截胡（offline 期）。返回恢复函数 */
async function enterOfflineProject(page: Page, pattern: RegExp): Promise<() => void> {
  const goOnline = await enterOfflineHome(page, pattern)
  await projectCardByName(page, PROJ).first().click()
  await page.waitForURL('**/project')
  return goOnline
}

/** 恢复路由 + 'online' 事件触发立即重连（handleRecovery 恢复触发器） */
async function reconnect(page: Page, goOnline: () => void) {
  goOnline()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

test.beforeAll(async () => {
  const headers = await unlockHeadersFetch()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(TERM_CWD, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  fs.mkdirSync(TERM_CWD, { recursive: true })
  execFileSync('git', ['init', '-b', 'master'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'reconnect coverage\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 基线提交'])
  const reg = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(reg.status)
})

test.afterAll(async () => {
  const headers = await unlockHeadersFetch()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(TERM_CWD, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupAsks(request)
  await cleanupMyFootprint(request)
})

test.afterAll(async () => {
  // request fixture 在 afterAll 不可用：复刻解锁头做足迹清理
  const headers = await unlockHeadersFetch()
  const notes = await (await fetch(`${API_BASE}/api/notifications`, { headers })).json()
  for (const n of ((notes?.data || []) as { id: string; title: string }[])) {
    if (n.title.startsWith(NOTIFY_PREFIX)) {
      await fetch(`${API_BASE}/api/notifications/dismiss/${n.id}`, { method: 'POST', headers }).catch(() => {})
    }
  }
  const terms = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()
  for (const s of ((terms?.data || []) as { id: string; name: string }[])) {
    if (s.name.startsWith(SESSION_PREFIX)) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
})

test('asks 域：断连窗口期的 input.request 在通道重连后自动入卡堆（零交互）', async ({ page, request }) => {
  test.setTimeout(60000)
  const goOnline = await enterOfflineHome(page, OPS_WS_PATTERN)
  const card = page.locator('.ask-card')
  await expect(card).toHaveCount(0)

  // 断连窗口期造 pending 提问：input.request 广播落空（ops WS 已断，不可回放），
  // 且此时无任何重连发生——卡片出现的唯一路径是重连后的注册表补拉
  const question = `${ASK_PREFIX} 请选择发布目标 ${Date.now()}`
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/ops-ask`, {
    headers, data: { question },
  })
  expect(res.ok()).toBeTruthy()
  await page.waitForTimeout(1500)
  await expect(card).toHaveCount(0)

  // 恢复路由 → 立即重连 → 注册表全表遍历 → asks.seedPending 补账 → 卡片自动入堆
  await reconnect(page, goOnline)
  await expect(card.filter({ hasText: question })).toHaveCount(1, { timeout: 15000 })
})

test('notification 域：断连窗口期落库的通知在通知 WS 重连后自动入列表（零交互）', async ({ page, request }) => {
  test.setTimeout(90000)
  const goOnline = await enterOfflineProject(page, NOTIF_WS_PATTERN)
  // 打开通知中心（断连窗口期之前的揭示动作，非补拉路径的一部分）：
  // 面板行列表是 store items 的直接投影，适合做零交互到达断言
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  const myRows = page.locator('.nc-item:not(.nc-sub)').filter({ hasText: NOTIFY_PREFIX })
  await expect(myRows).toHaveCount(0)

  // 断连窗口期落库通知：notification.new 广播落空（通知 WS 已断，不可回放）
  const title = `${NOTIFY_PREFIX} 部署完成 ${Date.now()}`
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/notifications`, {
    headers, data: { type: 'info', category: 'system', title, body: 'reconnect coverage e2e' },
  })
  expect(res.ok()).toBeTruthy()
  await page.waitForTimeout(1500)
  await expect(myRows).toHaveCount(0)

  // 恢复路由 → 通知 WS onOpen → 注册表全表遍历 → loadHistory 按 id 合并 → 自动入列
  await reconnect(page, goOnline)
  await expect(myRows.filter({ hasText: title })).toHaveCount(1, { timeout: 15000 })
})

test('terminals 域：断连窗口期新建的会话在通道重连后自动入管理页列表（零交互）', async ({ page, request }) => {
  test.setTimeout(90000)
  const goOnline = await enterOfflineProject(page, OPS_WS_PATTERN)
  // 打开终端会话管理页（断连窗口期之前，非补拉路径的一部分）
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await expect(railBtn).toHaveCount(1)
  await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  // 首拉落定再取基线：无会话时总数标签不渲染（v-if），空态兜底可见
  const countEl = view.locator('.atv-count')
  await expect(page.locator('.ats-empty').or(countEl)).toBeVisible({ timeout: 10000 })
  const before = (await countEl.isVisible())
    ? parseInt((await countEl.textContent()) || '0', 10)
    : 0

  // 断连窗口期 API 造会话（kind=agent runtime=shell 纯终端，真实 PTY 无智能体
  // 启动开销；terminals.changed 快照广播随断连丢失）
  const name = `${SESSION_PREFIX}${Date.now()}`
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers, data: { kind: 'agent', runtime: 'shell', name, dir: serverPath(TERM_CWD) },
  })
  expect(res.ok()).toBeTruthy()
  await page.waitForTimeout(1500)
  await expect(view.getByText(name)).toHaveCount(0)
  // 总数标签同步缺席/不变（基线 0 时标签本就不渲染）
  if (before === 0) {
    await expect(countEl).toHaveCount(0)
  } else {
    await expect(countEl).toHaveText(`${before} 个会话`)
  }

  // 恢复路由 → ops 通道重连 → 注册表全表遍历 → terminals.refresh 重拉列表对账
  await reconnect(page, goOnline)
  await expect(countEl).toHaveText(`${before + 1} 个会话`, { timeout: 15000 })
  await expect(view.getByText(name).first()).toBeVisible()
})
