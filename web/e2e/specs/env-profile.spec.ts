import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目环境画像（P-20261007-14）E2E：
 *   1. API 契约面：agent 上报 preview.port（真实登记链路）→ GET
 *      /api/projects/:id/env-profile 的 devPorts 出端口+label+source+lastSeen；
 *      global 哨兵规则可见；部署目标只出摘要（名称/协议/认证形态）——响应体
 *      全文无主机地址/凭据明文（fleet「只出摘要」脱敏纪律的对账断言）
 *   2. UI 画像页：活动栏「环境」入口 → 画像面板三区——端口行（端口/label/
 *      上报徽标）、哨兵条目可见、面板全文无地址明文
 * 前置（spec 内自备）：临时项目 + API 建的终端会话（上报需要存活会话承接
 * X-Session-ID，RegisterDevPort 拒绝幽灵 id）；端口取值仅入表不监听，高位段
 * 防与其他面混淆
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_NAME = 'e2e-envprofile'
const PORT_A = 18601
const HOST_NAME = 'e2e-env-target'
const HOST_ADDR = '192.168.250.7'
const HOST_SECRET = 'e2e-env-secret-pw'
const SENTINEL_NAME = 'e2e-env-sentinel'
// UI 用例独立夹具名：哨兵/主机存储无同名去重（两次 POST = 两条规则），共享名字
// 会让面板出现两条同名行——strict locator 失败且重试再叠一条。API 用例与 UI
// 用例各用一套名字，互不撞行
const UI_SENTINEL_NAME = 'e2e-env-sentinel-ui'
const UI_HOST_NAME = 'e2e-env-target-ui'
const UI_HOST_ADDR = '192.168.250.8'
const UI_HOST_SECRET = 'e2e-env-secret-pw-ui'
const SESSION_NAME = 'e2e-envprofile-session'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** agent 上报原语（ops 手册 preview.port 约定：X-Session-ID 头携带会话 id） */
function reportPort(sessionId: string, port: number, label: string) {
  return fetch(API_BASE + '/api/ops-notify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken, 'X-Session-ID': sessionId },
    body: JSON.stringify({ type: 'preview.port', payload: { port, label } }),
  })
}

/**
 * 清理本 spec 夹具（按名字精确圈定——同实例其他用例共享哨兵/主机/终端面）：
 * - 哨兵/主机：无同名去重，残留会叠行；重试前置清理保证幂等
 * - 终端会话：失败重试残留会话占着已登记端口（RegisterDevPort 按先占归属，
 *   新会话上报同端口会撞冲突而画像仍显示旧会话名），清掉才能确定性重播
 */
async function cleanupFixtures(): Promise<void> {
  const sentinelNames = [SENTINEL_NAME, UI_SENTINEL_NAME]
  const sentinels = await api('GET', '/api/sentinels')
  for (const s of ((sentinels.json?.data || []) as { id: string; name: string }[])) {
    if (sentinelNames.includes(s.name)) await api('DELETE', `/api/sentinels/${s.id}`)
  }
  const hostNames = [HOST_NAME, UI_HOST_NAME]
  const hosts = await api('GET', '/api/remotehosts')
  for (const h of ((hosts.json?.data || []) as { id: string; name: string }[])) {
    if (hostNames.includes(h.name)) await api('DELETE', `/api/remotehosts/${h.id}`)
  }
  const terms = await api('GET', '/api/terminals')
  for (const t of ((terms.json?.data || []) as { id: string; name: string }[])) {
    if (t.name === SESSION_NAME) await api('DELETE', `/api/terminals/${t.id}`)
  }
}

interface EnvProfile {
  projectId: string
  devPorts: { port: number; label: string; source: string; firstSeen: string; lastSeen: string; sessionId?: string; sessionName?: string }[]
  sentinels?: { id: string; name: string; level: string; scope: string }[]
  deployTargets?: { id: string; name: string; protocol: string; authType: string }[]
}

async function fetchProfile(projectId: string): Promise<EnvProfile> {
  const res = await api('GET', `/api/projects/${projectId}/env-profile`)
  expect(res.status).toBe(200)
  return (res.json as { data?: EnvProfile })?.data as EnvProfile
}

/** 等上报登记进画像 devPorts（上报→注册表是同步的，轮询为时序缓冲） */
async function waitPortInProfile(projectId: string, port: number): Promise<EnvProfile> {
  for (let i = 0; i < 10; i++) {
    const profile = await fetchProfile(projectId)
    if (profile.devPorts.some(p => p.port === port)) return profile
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  return fetchProfile(projectId)
}

let projId = ''

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  // 崩溃轮残留夹具清理（本 spec 专名圈定）；项目在建/旧项目已随删除级联
  await cleanupFixtures()

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-envprofile')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projId = ((proj.json as { data?: { id?: string } })?.data?.id) || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  // 夹具按名单精确清理（同实例多 worker 共享哨兵/主机/终端面）
  await cleanupFixtures()
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-envprofile'), { recursive: true, force: true }) } catch { /* shell 占用忽略 */ }
})

test('上报端口 → 画像 API 聚合三源：端口+lastSeen 在场、哨兵可见、目标摘要无地址明文', async () => {
  test.setTimeout(120000)
  // 前置三件：存活会话（承接上报归属）+ 全局哨兵 + 部署目标主机
  const created = await api('POST', '/api/terminals', { projectId: projId, name: SESSION_NAME })
  expect(created.status).toBe(200)
  const sessionId = ((created.json as { data?: { id?: string } })?.data?.id) || ''
  expect(sessionId).not.toBe('')

  const sentinel = await api('POST', '/api/sentinels', { name: SENTINEL_NAME, pattern: 'E2ENVPATTERN', scope: 'global', level: 'warning' })
  expect([200, 201]).toContain(sentinel.status)
  const host = await api('POST', '/api/remotehosts', {
    name: HOST_NAME, host: HOST_ADDR, port: 22, user: 'e2e-deploy',
    authType: 'password', password: HOST_SECRET, protocol: 'sftp',
  })
  expect([200, 201]).toContain(host.status)

  // agent 上报链（真实登记原语）→ 画像聚合
  const rep = await reportPort(sessionId, PORT_A, 'e2e vite')
  expect(rep.status).toBe(200)
  const profile = await waitPortInProfile(projId, PORT_A)

  // devPorts：端口 + label + source + lastSeen（观测时效字段非空）
  const port = profile.devPorts.find(p => p.port === PORT_A)
  expect(port, 'reported port must appear in profile').toBeTruthy()
  expect(port!.label).toBe('e2e vite')
  expect(port!.source).toBe('reported')
  expect(port!.lastSeen, 'lastSeen must be stamped').not.toBe('')
  expect(port!.sessionName).toBe(SESSION_NAME)

  // sentinels：global 规则对本项目可见
  expect(profile.sentinels?.some(s => s.name === SENTINEL_NAME && s.scope === 'global')).toBe(true)

  // deployTargets：只出摘要（名称/协议/认证形态）；响应体全文无地址/口令明文
  const target = profile.deployTargets?.find(h => h.name === HOST_NAME)
  expect(target, 'deploy target summary must be listed').toBeTruthy()
  expect(target!.protocol).toBe('sftp')
  expect(target!.authType).toBe('password')
  const raw = JSON.stringify(profile)
  expect(raw).not.toContain(HOST_ADDR)
  expect(raw).not.toContain(HOST_SECRET)

  // 会话随项目删除级联收尾（afterAll 删项目即摘除；此处显式关闭缩小竞态窗）
  await api('DELETE', `/api/terminals/${sessionId}`)
})

test('画像页 UI：活动栏「环境」入口 → 端口行/哨兵条目可见、全文无地址明文', async ({ page }) => {
  test.setTimeout(180000)
  // 重试幂等：先清掉上一轮（含失败尝试）残留的同名夹具，再建本次 UI 夹具
  await cleanupFixtures()
  // 前置：会话 + 上报 + global 哨兵 + 主机（API 造数，UI 只断画像面板呈现）
  const created = await api('POST', '/api/terminals', { projectId: projId, name: SESSION_NAME })
  expect(created.status).toBe(200)
  const sessionId = ((created.json as { data?: { id?: string } })?.data?.id) || ''
  expect(sessionId).not.toBe('')
  const sentinel = await api('POST', '/api/sentinels', { name: UI_SENTINEL_NAME, pattern: 'E2ENVPATTERN', scope: 'global', level: 'warning' })
  expect([200, 201]).toContain(sentinel.status)
  const host = await api('POST', '/api/remotehosts', {
    name: UI_HOST_NAME, host: UI_HOST_ADDR, port: 22, user: 'e2e-deploy',
    authType: 'password', password: UI_HOST_SECRET, protocol: 'sftp',
  })
  expect([200, 201]).toContain(host.status)
  const rep = await reportPort(sessionId, PORT_A, 'e2e vite')
  expect(rep.status).toBe(200)
  await waitPortInProfile(projId, PORT_A)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')

  // 活动栏「环境」入口（面板注册表 rail-top 新面板；项目切换的异步布局应用
  // 可能覆盖点击，rail 点击幂等重验——terminal 域同款守卫）
  const panel = page.locator('[data-testid="env-profile-panel"]')
  for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
    await page.locator('.rail-btn[title="环境画像"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
  }
  await expect(panel).toBeVisible({ timeout: 5000 })

  // 端口行：端口 + label + 上报徽标 + lastSeen 相对时效
  const portRow = panel.locator('[data-testid="env-profile-ports"] li').filter({ hasText: `:${PORT_A}` })
  await expect(portRow).toBeVisible({ timeout: 10000 })
  await expect(portRow).toContainText('e2e vite')
  // 来源徽标：envProfile.sourceReported 的 zh-CN 文案（面板徽标是短词「上报」，
  // 与端口浮层「agent 上报」的长文案不同——断言以本面板 locale 为准）
  await expect(portRow).toContainText('上报')

  // 哨兵条目可见（global 规则在本项目画像内）
  const sentinelRow = panel.locator('[data-testid="env-profile-sentinels"] li').filter({ hasText: UI_SENTINEL_NAME })
  await expect(sentinelRow).toBeVisible({ timeout: 5000 })

  // 部署目标摘要可见，且面板全文无地址/口令明文（脱敏纪律的 UI 侧对账）
  const targetRow = panel.locator('[data-testid="env-profile-targets"] li').filter({ hasText: UI_HOST_NAME })
  await expect(targetRow).toBeVisible({ timeout: 5000 })
  const panelText = await panel.textContent()
  expect(panelText).not.toContain(UI_HOST_ADDR)
  expect(panelText).not.toContain(UI_HOST_SECRET)

  await api('DELETE', `/api/terminals/${sessionId}`)
})
