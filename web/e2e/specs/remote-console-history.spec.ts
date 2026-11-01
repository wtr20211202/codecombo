import { test, expect } from '@playwright/test'
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 远程控制台命令历史汇流（P-20261005-188）实流 E2E：
 *   远程会话（WSL sshd）敲命令 → 输入域采集（onData 收口行缓冲，回车分条）→
 *   落库 source=input + host → 项目历史面板出远程条目（主机徽标 + 「—」）→
 *   本地会话重插被分流（点选=复制 + ▶ 缺席）。
 * 采集链依赖真实 SSH PTY（无 shell integration 正是受测前提，无法播种伪造），
 * WSL sshd 不可达时条件跳过；API 契约与面板消费面由
 * terminal-history-source-host.spec 环境无关覆盖。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-remote-cmd-hist'
const MARK = `e2e-rch-${Math.random().toString(36).slice(2, 8)}`
const CMD = `echo ${MARK}`

function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let wslUp = false
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

/** 清理远程管理持久化状态（服务端 uiState），tab 面貌从空态开始（remote-console 同款） */
async function clearRemoteConsoleState() {
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, { remoteConsole?: unknown }> } | null
  const map = body?.data
  if (!map) return
  const clear: Record<string, { remoteConsole: null }> = {}
  for (const k of Object.keys(map)) {
    if (map[k]?.remoteConsole !== undefined) clear[k] = { remoteConsole: null }
  }
  if (Object.keys(clear).length > 0) {
    await fetch(`${API_BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify(clear) })
  }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const wslHost = await fetchWslHost(API_BASE)
  wslUp = !!wslHost && await tcpReachable(wslHost.port)

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-remote-cmd-hist')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
  await api('DELETE', `/api/projects/${projectId}/terminal-history`)
  await clearRemoteConsoleState()
})

test.afterAll(async () => {
  await clearRemoteConsoleState()
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-remote-cmd-hist'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('远程敲命令 → 历史面板出输入域条目（主机徽标）→ 本地重插被分流', async ({ page }) => {
  test.skip(!wslUp, 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(240000)
  await fixedLocale(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 先落定当前项目（采集上报的项目归属锚点），再进远程管理内嵌视图
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })

  // 卡片 hover 快捷钮开远程终端（P-20261030-3 卡片点击改开编辑弹窗；
  // 真 SSH，无 shell integration——正是输入域受测前提）
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  const xterm = page.locator('.remote-pane-wrap:visible .xterm').first()
  await wslCard.locator('.host-card-term').click()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('#', { timeout: 45000 })

  // 敲命令：回车即采集提交边界（\r 分条上报），回显确认已送达远端
  await xterm.click()
  await page.keyboard.type(`${CMD}\r`)
  await expect(xterm).toContainText(MARK, { timeout: 10000 })
  // fire-and-forget 上报落库留缓冲（echo 可见时 POST 通常已落地）
  await page.waitForTimeout(800)

  // 回项目终端域开命令历史面板：远程条目已汇流入同一项目文档
  const bottomPanel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await bottomPanel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(bottomPanel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const history = page.locator('.history-panel')
  await expect(history).toBeVisible()

  const inputItem = history.locator('[data-testid="history-item"]').filter({ hasText: CMD }).first()
  await expect(inputItem).toBeVisible({ timeout: 15000 })
  // 主机徽标 = WSL（store 解读 hostId → name）+ 退出码/时长位「—」+ 无 ▶ 直插
  await expect(inputItem.locator('[data-testid="history-host-badge"]')).toHaveText('WSL')
  await expect(inputItem.locator('.history-na')).toHaveText('—')
  await expect(inputItem.locator('button.is-run')).toHaveCount(0)

  // 本地会话重插被分流：点选=复制 + 提示语，不写入本地终端输入行
  await inputItem.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 }).toBe(CMD)
  await expect(page.locator('.n-message').filter({ hasText: '远程命令已复制' }).first()).toBeVisible({ timeout: 5000 })
})
