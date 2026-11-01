import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令历史来源与主机键（P-20261005-188）E2E：
 *   1. API 契约：POST source=input + host 落盘、GET 原样读回、无 source/host
 *      键的旧形态条目零值缺省（osc/本地，升级兼容面）；全局检索透传 source/host
 *   2. 面板消费：输入域条目带主机徽标 + 退出码/时长位「—」 + 无「插入并执行」
 *      ▶（本地会话分流），点选分流为复制（剪贴板 + 提示语）；osc 条目行为不变
 * 采集面（真实远程敲命令 → 出条目）由 remote-console-history.spec 在 WSL
 * sshd 可达环境覆盖，本 spec 用 API 播种、环境无关必跑。
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-term-src-host'
const HOST_NAME = `e2e-rhist-host-${Math.random().toString(36).slice(2, 6)}`
const CMD_INPUT = 'kubectl get pods e2e-rhist'
const CMD_INPUT_2 = 'docker compose up -d e2e-rhist'
const CMD_LEGACY = 'git status e2e-rhist-legacy'
const CMD_OSC = 'go test ./... e2e-rhist-osc'

let unlockToken = ''
let projectId = ''
let hostId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function seedHistory(entry: Record<string, unknown>) {
  const rec = await api('POST', `/api/projects/${projectId}/terminal-history`, entry)
  expect(rec.status).toBe(200)
}

/** 打开项目页 + 底部终端面板 + 命令历史面板（terminal-history-attribution 同款） */
async function openHistoryPanel(page: Page) {
  await fixedLocale(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = page.locator('.bottom-panel')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="终端"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.locator('.term-toolbar button[title*="命令历史"]').click()
  const history = page.locator('.history-panel')
  await expect(history).toBeVisible()
  return history
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
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-term-src-host')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
  await api('DELETE', `/api/projects/${projectId}/terminal-history`)

  // 播种一台真实主机记录：面板主机徽标按 name 渲染（store 解读 hostId → name）
  const seeded = await api('POST', '/api/remotehosts', {
    name: HOST_NAME, host: '127.0.0.1', port: 22, user: 'e2e',
    authType: 'password', protocol: 'ssh', password: 'rhist-e2e-secret',
  })
  expect([200, 201]).toContain(seeded.status)
  const hosts = await api('GET', '/api/remotehosts')
  hostId = ((hosts.json?.data || []) as { id: string; name: string }[]).find(h => h.name === HOST_NAME)!.id

  await seedHistory({ command: CMD_INPUT, exitCode: 0, durationMs: 0, source: 'input', host: hostId, terminalId: 'rterm-1' })
  await seedHistory({ command: CMD_INPUT_2, exitCode: 0, durationMs: 0, source: 'input', host: hostId })
  await seedHistory({ command: CMD_LEGACY, exitCode: 0, durationMs: 50 })
  await seedHistory({ command: CMD_OSC, exitCode: 1, durationMs: 200 })
})

test.afterAll(async () => {
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  if (hostId) await api('DELETE', `/api/remotehosts/${hostId}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-term-src-host'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('API 契约：source/host 落盘读回透传，旧形态条目零值缺省（osc/本地）', async () => {
  const res = await api('GET', `/api/projects/${projectId}/terminal-history`)
  expect(res.status).toBe(200)
  const entries = (res.json?.data || []) as Array<Record<string, unknown> & { command: string }>
  expect(entries).toHaveLength(4)

  const byCmd = new Map(entries.map(e => [e.command, e]))
  // 输入域条目：source/host 原样往返
  const input = byCmd.get(CMD_INPUT)!
  expect(input.source).toBe('input')
  expect(input.host).toBe(hostId)
  // 输入域条目 exitCode/durationMs 恒 0（无数据，非「成功」语义）
  expect(input.exitCode).toBe(0)
  expect(input.durationMs).toBe(0)
  const input2 = byCmd.get(CMD_INPUT_2)!
  expect(input2.source).toBe('input')
  expect(input2.host).toBe(hostId)

  // 旧形态条目（升级兼容面）：响应 JSON 无 source/host 键（零值 omitempty 不落键）
  const legacy = byCmd.get(CMD_LEGACY)!
  expect('source' in legacy).toBe(false)
  expect('host' in legacy).toBe(false)
  const osc = byCmd.get(CMD_OSC)!
  expect('source' in osc).toBe(false)
  expect(osc.exitCode).toBe(1) // osc 条目退出码语义不受影响

  // 全局检索透传 source/host + 项目名
  const search = await api('GET', `/api/terminal-history/search?q=${encodeURIComponent('e2e-rhist')}`)
  expect(search.status).toBe(200)
  const hits = (search.json?.data || []) as Array<{ command: string; source?: string; host?: string; projectName: string }>
  const inputHit = hits.find(h => h.command === CMD_INPUT)
  expect(inputHit).toBeTruthy()
  expect(inputHit!.source).toBe('input')
  expect(inputHit!.host).toBe(hostId)
  expect(inputHit!.projectName).toBe(PROJ)
  const legacyHit = hits.find(h => h.command === CMD_LEGACY)
  expect(legacyHit).toBeTruthy()
  expect('source' in legacyHit!).toBe(false)
})

test('面板消费：远程条目主机徽标 + 「—」 + 无直插（点选分流为复制），osc 条目不变', async ({ page }) => {
  test.setTimeout(180000)
  const history = await openHistoryPanel(page)
  const items = history.locator('[data-testid="history-item"]')

  // 远程输入域条目：主机徽标（store 解读为 name）+ 「—」占位 + 无 ▶ 直插钮
  const inputItem = items.filter({ hasText: CMD_INPUT }).first()
  await expect(inputItem).toBeVisible({ timeout: 10000 })
  const badge = inputItem.locator('[data-testid="history-host-badge"]')
  await expect(badge).toHaveText(HOST_NAME)
  await expect(inputItem.locator('.history-na')).toHaveText('—')
  await expect(inputItem.locator('button.is-run')).toHaveCount(0)

  // 点选分流为复制：剪贴板落命令原文 + 提示语点明缘由（不写入终端输入行）
  await inputItem.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 }).toBe(CMD_INPUT)
  await expect(page.locator('.n-message').filter({ hasText: '远程命令已复制' }).first()).toBeVisible({ timeout: 5000 })

  // osc 条目行为不变：退出码徽章 + ▶ 在场 + 无主机徽标
  const oscItem = items.filter({ hasText: CMD_OSC }).first()
  await expect(oscItem).toBeVisible({ timeout: 5000 })
  await expect(oscItem.locator('.history-exit.is-fail')).toBeVisible()
  await expect(oscItem.locator('button.is-run')).toHaveCount(1)
  await expect(oscItem.locator('[data-testid="history-host-badge"]')).toHaveCount(0)
})
