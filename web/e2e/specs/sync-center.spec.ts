import { test, expect, type APIRequestContext } from '@playwright/test'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 多实例同步中心 E2E（P-20261023-1）：「项目+上下文整体搬到对端」的编排链。
 *
 *   1. API 全链：manifest → plan 四态 → push（后台执行）→ progress 终态 →
 *      账本回账（对端存根 = spec 进程内最小 HTTP 真身，instance-backflow 同款
 *      先例；对端落位/原子换名/覆盖备份的完整校验在 Go 单测 landUnits 链）
 *   2. UI：同步中心面板（活动栏入口）——方向指示器、项目卡片、对端选择、
 *      plan 预览四态、方向词按钮、进度/结果卡、红线灰显；拉取走对端存根
 *      中转的本端真实 zip（打包布局由 /api/sync/units 上游产生，免 node 手拼
 *      zip——落位语义与 Go 单测对齐）
 *
 * 对端存根不落盘 zip 内容：push 用例只记字节数与 X-Sync-Meta；pull 用例
 * 中转的 zip 由本端打包器产出、落位复用真实 landUnits 实现。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-sync-peer'
const PEER_TOKEN = 'sc_e2e_sync_token'
const PROJ_NAME = 'e2e-sync-demo'
const PROJ_BASE = 'e2e-sync-demo-dir'
const STUB_FP = 'stub-peer-fingerprint-e2e'

let unlockToken = ''
let instanceId = ''
let projectId = ''
let projRoot = ''
let destRoot = ''
let prevDestRoot: string | null = null

const peerState = {
  pushedBytes: 0,
  pushedMeta: '' as string,
  pushedMode: '' as string,
}

// 对端 zip 中转缓存：beforeAll 从本端 /api/sync/units 取真实布局 zip
let relayZip: Buffer = Buffer.alloc(0)
let relayMeta = ''

function peerHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    // 探活分类口（server/api/system/instance.go tryCheckInstance 探的是对端
    // /api/settings 而非 /api/meta）：200 + data.version 才判 online——缺了本
    // 分支实例被判 invalid，前端同步中心按无效实例过滤，对端选择器恒空
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '9.9.9-sync-e2e' } }))
    return
  }
  if (req.url?.startsWith('/api/meta')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      version: { version: '9.9.9-sync-e2e', commit: 'e2e', buildTime: '', apiVersion: '1.0.0' },
      capabilities: ['sync'],
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/manifest')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      data: {
        units: [{
          key: `project:${PROJ_BASE}`, kind: 'project', name: PROJ_NAME,
          fingerprint: STUB_FP, size: 99999, files: 42, exists: true,
          path: '/stub/peer/path',
        }],
        diskFree: 1 << 30,
        destRoot: '/stub/dest',
        version: '9.9.9-sync-e2e',
      },
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/units') && req.method === 'GET') {
    // pull 中转：回放 beforeAll 从本端打包的真实 zip（布局 = u0/ 前缀 +
    // X-Sync-Meta 元数据，落位侧按真实 landUnits 语义解析）
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader('X-Sync-Meta', relayMeta)
    res.end(relayZip)
    return
  }
  if (req.url?.startsWith('/api/sync/units') && req.method === 'POST') {
    const chunks: Buffer[] = []
    let len = 0
    req.on('data', (c: Buffer) => { chunks.push(c); len += c.length })
    req.on('end', () => {
      peerState.pushedBytes = len
      peerState.pushedMeta = req.headers['x-sync-meta'] as string || ''
      peerState.pushedMode = new URL(req.url!, 'http://x').searchParams.get('mode') || 'land'
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        data: { units: [{ key: `project:${PROJ_BASE}`, ok: true, projectId: 'stub-project', registered: true }], destRoot: '/stub/dest' },
      }))
    })
    return
  }
  res.statusCode = 404
  res.end('not a sync endpoint')
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  return { 'X-Lock-Token': ((await res.json()) as { token?: string }).token || '' }
}

let peer: http.Server

test.beforeAll(async ({ request }) => {
  unlockToken = (await unlockHeaders(request))['X-Lock-Token']
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  peer = http.createServer(peerHandler)
  await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve))
  const peerPort = (peer.address() as AddressInfo).port

  // 夹具项目：临时目录 + 一个小文件（basename 即跨实例稳定单元键成分）
  projRoot = mkdtempSync(path.join(tmpdir(), 'sc-sync-e2e-'))
  const projDir = path.join(projRoot, PROJ_BASE)
  mkdirSync(projDir)
  writeFileSync(path.join(projDir, 'main.txt'), 'sync-e2e-payload')
  const addRes = await request.post(`${BASE}/api/projects`, {
    headers: auth,
    data: { name: PROJ_NAME, path: serverPath(projDir) },
  })
  expect(addRes.ok(), '注册夹具项目应成功').toBeTruthy()
  projectId = ((await addRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).toBeTruthy()

  // 落位根指到临时目录（拉取落位不散落用户主目录；afterAll 恢复）
  const settingsRes = await request.get(`${BASE}/api/settings`, { headers: auth })
  prevDestRoot = ((await settingsRes.json()) as { data?: { syncDestRoot?: string } }).data?.syncDestRoot ?? null
  destRoot = path.join(projRoot, 'landed')
  const putRes = await request.put(`${BASE}/api/settings`, {
    headers: auth,
    data: { syncDestRoot: serverPath(destRoot) },
  })
  expect(putRes.ok(), '设置落位根应成功').toBeTruthy()

  // 注册对端实例
  const instRes = await request.post(`${BASE}/api/instances`, {
    headers: auth,
    data: { name: PEER_NAME, url: `http://127.0.0.1:${peerPort}`, token: PEER_TOKEN },
  })
  expect(instRes.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await instRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(instanceId).toBeTruthy()

  // pull 中转缓存：本端真实打包（GET /api/sync/units 走自产 packer）
  const zipRes = await request.get(`${BASE}/api/sync/units?keys=${encodeURIComponent(`project:${PROJ_BASE}`)}`, { headers: auth })
  expect(zipRes.ok(), '本端打包 zip 应成功').toBeTruthy()
  relayZip = Buffer.from(await zipRes.body())
  relayMeta = zipRes.headers()['x-sync-meta'] || ''
  expect(relayZip.length, 'zip 非空').toBeGreaterThan(0)
  expect(relayMeta).toContain(`project:${PROJ_BASE}`)
})

test.afterAll(async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  if (instanceId) await request.delete(`${BASE}/api/instances/${instanceId}`, { headers: auth }).catch(() => {})
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers: auth }).catch(() => {})
  // 拉取落位注册出的镜像项目按路径清理（destRoot/landed/<PROJ_BASE>）
  const list = await request.get(`${BASE}/api/projects`, { headers: auth }).catch(() => null)
  if (list && list.ok()) {
    const projects = ((await list.json()) as { data?: { id: string; path: string }[] }).data || []
    for (const p of projects) {
      const norm = p.path.replace(/\\/g, '/').replace(/\/+$/, '')
      if (norm.endsWith(`/${PROJ_BASE}`) && norm.includes('/landed')) {
        await request.delete(`${BASE}/api/projects/${p.id}`, { headers: auth }).catch(() => {})
      }
    }
  }
  if (prevDestRoot === null) {
    await request.put(`${BASE}/api/settings`, { headers: auth, data: { syncDestRoot: '' } }).catch(() => {})
  } else {
    await request.put(`${BASE}/api/settings`, { headers: auth, data: { syncDestRoot: prevDestRoot } }).catch(() => {})
  }
  if (projRoot) rmSync(projRoot, { recursive: true, force: true })
  peer?.close()
})

async function fetchOutcome(request: APIRequestContext): Promise<string> {
  // progress 快照终态读取（expect.poll 重试消费——POST 受理与 beginJob 间有
  // 毫秒级窗口，idle 快照不构成终态证据）
  const res = await request.get(`${BASE}/api/sync/progress`, { headers: { 'X-Lock-Token': unlockToken } })
  const snap = ((await res.json()) as { data?: { outcome?: string } | null }).data
  return snap?.outcome || 'idle'
}

test('API 全链：manifest → plan 四态 → push 后台执行 → 账本回账', async ({ request }) => {
  const auth = { 'X-Lock-Token': unlockToken }

  // manifest：夹具项目以单元形态在场
  const mRes = await request.get(`${BASE}/api/sync/manifest`, { headers: auth })
  expect(mRes.ok()).toBeTruthy()
  const manifest = (await mRes.json()) as { data?: { units: { key: string; files: number }[]; destRoot: string } }
  const unit = manifest.data?.units.find(u => u.key === `project:${PROJ_BASE}`)
  expect(unit, 'manifest 应含夹具项目单元').toBeTruthy()
  expect(unit!.files).toBe(1)

  // plan：对端单侧存在（指纹不同）→ 无基线 new 档，建议动作随方向
  const pRes = await request.post(`${BASE}/api/sync/plan`, {
    headers: { 'Content-Type': 'application/json', ...auth },
    data: { instanceId, projectKeys: [`project:${PROJ_BASE}`] },
  })
  expect(pRes.ok()).toBeTruthy()
  const plan = (await pRes.json()) as { data?: { rows: { key: string; state: string; selected: boolean; peerOnline: boolean }[]; peerOnline: boolean; peerVersion?: string } }
  expect(plan.data?.peerOnline).toBe(true)
  const row = plan.data?.rows.find(r => r.key === `project:${PROJ_BASE}`)
  expect(row, 'plan 应含项目行').toBeTruthy()
  expect(row!.state).toBe('new')
  expect(row!.selected).toBe(true)

  // push（后台执行）→ 终态 done + 对端收到 zip 与元数据
  const execRes = await request.post(`${BASE}/api/sync/push`, {
    headers: { 'Content-Type': 'application/json', ...auth },
    data: { instanceIds: [instanceId], units: [`project:${PROJ_BASE}`], resolutions: {} },
  })
  expect(execRes.ok(), `push 应受理: ${await execRes.text()}`).toBeTruthy()

  await expect.poll(() => fetchOutcome(request), { timeout: 30000 }).toBe('done')
  await expect.poll(() => peerState.pushedBytes, { timeout: 10000 }).toBeGreaterThan(0)
  expect(peerState.pushedMeta).toContain(`project:${PROJ_BASE}`)

  // 账本回账：push 后双端基线在场
  const lRes = await request.get(`${BASE}/api/sync/ledger`, { headers: auth })
  const ledger = (await lRes.json()) as { data?: { peerId: string; unitKey: string; localFp: string; peerFp: string }[] }
  const entry = (ledger.data || []).find(e => e.peerId === instanceId && e.unitKey === `project:${PROJ_BASE}`)
  expect(entry, 'push 应回账').toBeTruthy()
  expect(entry!.localFp).toBe(entry!.peerFp)
})

test('UI：同步中心面板（方向指示器/项目卡片/plan 预览/拉取进度与结果卡/红线灰显）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')

  // 活动栏入口（order 67 尾部追加；奇数次点击保证最终打开——侧栏 toggle 语义）
  const panel = page.locator('[data-testid="sync-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await panel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="多实例同步"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态重试 */ })
  }
  await expect(panel).toBeVisible()

  // 方向指示器：推送默认 + 两个方向词按钮
  const direction = panel.locator('[data-testid="sync-direction"]')
  await expect(direction).toBeVisible()
  await expect(panel.locator('[data-testid="sync-dir-push"]')).toHaveClass(/is-active/)

  // 项目卡片（夹具项目在场且默认勾选）
  const projects = panel.locator('[data-testid="sync-projects"]')
  await expect(projects.locator('label', { hasText: PROJ_NAME })).toBeVisible()

  // 选对端 → plan 预览出现（无基线 new 档默认勾选）
  await panel.locator('[data-testid="sync-peers"] label', { hasText: PEER_NAME }).click()
  const planRows = panel.locator('[data-testid="sync-plan"] .sync-plan-row')
  await expect(planRows.first()).toBeVisible({ timeout: 15000 })
  // push 用例已回账：stub 指纹≠基线对端位 → 四态判定 peer-newer（对端新）
  await expect(planRows.first().locator('[data-state="peer-newer"]')).toBeVisible()

  // 红线灰显（永不同步清单说明）
  await expect(panel.locator('[data-testid="sync-redline"]')).toBeVisible()

  // 方向切「拉取」→ 按钮文案带方向词（从对端拉取到本机）
  await panel.locator('[data-testid="sync-dir-pull"]').click()
  const execute = panel.locator('[data-testid="sync-execute"]')
  await expect(execute).toContainText('拉取')

  // 等后台空闲（前一个 API 用例已收口；防御性再等）后执行拉取
  await expect.poll(() => fetchOutcome(page.request), { timeout: 30000 }).not.toBe('running')
  await execute.click()
  const progress = panel.locator('[data-testid="sync-progress"]')
  await expect(progress).toBeVisible({ timeout: 15000 })

  // 结果卡（成功/跳过/冲突/失败计数 + 字节汇总）；拉取落位进临时 destRoot
  const result = panel.locator('[data-testid="sync-result"]')
  await expect(result).toBeVisible({ timeout: 30000 })
  await expect(result).toContainText('成功')
})
