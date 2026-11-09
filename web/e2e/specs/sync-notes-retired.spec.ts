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
 * 笔记同步单元退役 E2E（P-20261108-3 单库化 sync 定案）：笔记改为项目无关的笔记库、
 * **不再随实例同步**；mixed-version 下旧对端仍会产出/推送 notes 与 notes-multi 单元
 * （旧落位链直写项目作用域键 = 新 UI 看不见的静默半态），本 spec 钉「显式对账红点」：
 *   1. plan：旧对端 manifest 携带的笔记单元成行标 retired（action=skip、不勾选）
 *   2. 执行：点名退役单元的拉取不发起传输，单元逐个记失败（error 文案），整批 failed
 *   3. 落位：旧对端推来的笔记单元（真实 zip 包）落地侧拒收回告，不写入任何笔记
 *   4. UI：同步中心 plan 预览中退役行红字「已退役」、勾选禁用
 * 对端存根 = spec 进程内最小 HTTP 真身（sync-center.spec 同款先例）。
 */

const BASE = API_BASE
const PEER_NAME = 'e2e-sync-retired-peer'
const PEER_TOKEN = 'sc_e2e_sync_retired_token'
const PROJ_NAME = 'e2e-sync-retired'
const PROJ_BASE = 'e2e-sync-retired-dir'

let unlockToken = ''
let instanceId = ''
let projectId = ''
let projRoot = ''
let peerUnitGets = 0

function peerHandler(req: http.IncomingMessage, res: http.ServerResponse) {
  if (req.url?.startsWith('/api/settings')) {
    // 探活分类口（实例在线判定探的是对端 /api/settings）：200 + data.version 才判 online
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ data: { version: '0.9.0-old-peer' } }))
    return
  }
  if (req.url?.startsWith('/api/meta')) {
    // 旧对端：仍声明已退役的 notes/notes-multi 能力项
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      version: { version: '0.9.0-old-peer', commit: 'e2e', buildTime: '', apiVersion: '1.0.0' },
      capabilities: ['sync', 'notes', 'notes-multi'],
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/manifest')) {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({
      data: {
        units: [
          { key: `project:${PROJ_BASE}`, kind: 'project', name: PROJ_NAME, fingerprint: 'old-peer-fp', size: 10, files: 1, exists: true, path: '/stub/peer/path' },
          { key: `notes:${PROJ_BASE}`, kind: 'notes', projectKey: `project:${PROJ_BASE}`, name: `${PROJ_NAME} notes`, fingerprint: 'n1', size: 120, files: 1, exists: true },
          { key: `notes-multi:${PROJ_BASE}`, kind: 'notes-multi', projectKey: `project:${PROJ_BASE}`, name: `${PROJ_NAME} notes library`, fingerprint: 'm1', size: 480, files: 1, exists: true },
        ],
        diskFree: 1 << 30,
        destRoot: '/stub/dest',
        version: '0.9.0-old-peer',
      },
    }))
    return
  }
  if (req.url?.startsWith('/api/sync/units')) {
    // 退役单元的拉取不应走到对端（执行侧先行记失败）——计数供断言
    peerUnitGets++
    res.statusCode = 500
    res.end('retired units must not be fetched')
    return
  }
  res.statusCode = 404
  res.end('not a sync endpoint')
}

/** 最小 stored（不压缩）zip 构造器：旧对端笔记单元包的真实二进制形态（本地文件头 +
 *  中央目录 + 目录尾三段，CRC32 查表自算——不引第三方依赖） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function storedZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8)
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0x21, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(e.data.length, 18)
    lh.writeUInt32LE(e.data.length, 22)
    lh.writeUInt16LE(name.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, name, e.data)
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(0, 10)
    ch.writeUInt16LE(0, 12)
    ch.writeUInt16LE(0x21, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(e.data.length, 20)
    ch.writeUInt32LE(e.data.length, 24)
    ch.writeUInt16LE(name.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt16LE(0, 34)
    ch.writeUInt16LE(0, 36)
    ch.writeUInt32LE(0, 38)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, cd, end])
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

  projRoot = mkdtempSync(path.join(tmpdir(), 'sc-sync-retired-'))
  const projDir = path.join(projRoot, PROJ_BASE)
  mkdirSync(projDir)
  writeFileSync(path.join(projDir, 'main.txt'), 'sync-retired')
  const addRes = await request.post(`${BASE}/api/projects`, {
    headers: auth,
    data: { name: PROJ_NAME, path: serverPath(projDir) },
  })
  expect(addRes.ok(), '注册夹具项目应成功').toBeTruthy()
  projectId = ((await addRes.json()) as { data?: { id?: string } }).data?.id || ''

  const instRes = await request.post(`${BASE}/api/instances`, {
    headers: auth,
    data: { name: PEER_NAME, url: `http://127.0.0.1:${peerPort}`, token: PEER_TOKEN },
  })
  expect(instRes.ok(), '注册对端实例应成功').toBeTruthy()
  instanceId = ((await instRes.json()) as { data?: { id?: string } }).data?.id || ''
})

test.afterAll(async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }
  if (instanceId) await request.delete(`${BASE}/api/instances/${instanceId}`, { headers: auth }).catch(() => {})
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers: auth }).catch(() => {})
  if (projRoot) rmSync(projRoot, { recursive: true, force: true })
  peer?.close()
})

async function progress(request: APIRequestContext): Promise<{ outcome?: string; units?: { key: string; state: string; error?: string }[] } | null> {
  const res = await request.get(`${BASE}/api/sync/progress`, { headers: { 'X-Lock-Token': unlockToken } })
  return ((await res.json()) as { data?: { outcome?: string; units?: { key: string; state: string; error?: string }[] } | null }).data ?? null
}

test('API：plan 标 retired 不可勾选 → 点名拉取逐个记失败不发起传输 → 旧包落位拒收', async ({ request }) => {
  const auth = { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken }

  // 1. plan：旧对端 manifest 的笔记单元成行标 retired（知情不执行，不静默隐藏）
  const pRes = await request.post(`${BASE}/api/sync/plan`, {
    headers: auth,
    data: { instanceId, projectKeys: [`project:${PROJ_BASE}`], contexts: ['crons'] },
  })
  expect(pRes.ok()).toBeTruthy()
  const plan = (await pRes.json()) as { data?: { rows: { key: string; state: string; action: string; selected: boolean }[] } }
  for (const kind of ['notes', 'notes-multi']) {
    const row = plan.data?.rows.find(r => r.key === `${kind}:${PROJ_BASE}`)
    expect(row, `plan 应显式含退役行 ${kind}`).toBeTruthy()
    expect(row!.state).toBe('retired')
    expect(row!.action).toBe('skip')
    expect(row!.selected).toBe(false)
  }

  // 2. 点名退役单元的拉取：不发起传输，逐个记失败（单元行 error 文案 + 整批 failed）
  await expect.poll(async () => (await progress(request))?.outcome ?? 'idle', { timeout: 30000 }).not.toBe('running')
  const execRes = await request.post(`${BASE}/api/sync/pull`, {
    headers: auth,
    data: { instanceIds: [instanceId], units: [`notes:${PROJ_BASE}`, `notes-multi:${PROJ_BASE}`], resolutions: {} },
  })
  expect(execRes.ok(), `pull 应受理: ${await execRes.text()}`).toBeTruthy()
  await expect.poll(async () => (await progress(request))?.outcome ?? 'idle', { timeout: 30000 }).toBe('failed')
  const snap = await progress(request)
  expect(snap?.units?.length).toBe(2)
  for (const u of snap?.units ?? []) {
    expect(u.state).toBe('failed')
    expect(u.error ?? '').toContain('retired')
  }
  expect(peerUnitGets, '退役单元不应向对端发起拉取').toBe(0)

  // 3. 旧对端推来的笔记单元（真实 zip 包，旧 packNotesUnit 形态）：落位侧拒收回告
  const zip = storedZip([{ name: 'u0/notes.json', data: Buffer.from(JSON.stringify({ content: '# old peer note', updatedAt: new Date().toISOString() })) }])
  const meta = { units: [{ key: `notes:${PROJ_BASE}`, kind: 'notes', name: PROJ_NAME, dirName: PROJ_BASE }] }
  const landRes = await request.post(`${BASE}/api/sync/units?mode=land`, {
    headers: { 'Content-Type': 'application/zip', 'X-Lock-Token': unlockToken, 'X-Sync-Meta': JSON.stringify(meta) },
    data: zip,
  })
  expect(landRes.ok(), `落位请求应受理（单元级拒收）: ${landRes.status()}`).toBeTruthy()
  const land = (await landRes.json()) as { data?: { units: { key: string; ok?: boolean; error?: string }[] } }
  expect(land.data?.units?.[0]?.ok ?? false).toBe(false)
  expect(land.data?.units?.[0]?.error ?? '').toContain('retired')
  // 拒收即零写入：笔记库没有因回流多出旧对端内容
  const notes = await request.get(`${BASE}/api/notes`, { headers: { 'X-Lock-Token': unlockToken } })
  expect(JSON.stringify(await notes.json())).not.toContain('old peer note')
})

test('UI：同步中心 plan 预览退役行红字「已退役」、勾选禁用', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')

  const panel = page.locator('[data-testid="sync-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await panel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="多实例同步"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态重试 */ })
  }
  await expect(panel).toBeVisible()

  // 上下文 chips：笔记两 chip 随退役下线；默认集回落轻量的定时任务单元（原默认「笔记」）
  await expect(panel.locator('[data-testid="sync-ctx-notes"]')).toHaveCount(0)
  await expect(panel.locator('[data-testid="sync-ctx-notes-multi"]')).toHaveCount(0)
  await expect(panel.locator('[data-testid="sync-ctx-crons"]')).toBeVisible()

  // 项目集可能被 uiState 的「上次同步」记忆覆盖成别的项目（配置记忆回放）——显式勾上本项目
  const projBox = panel.locator(`[data-testid="sync-projects"] input[type="checkbox"][aria-label="${PROJ_NAME}"]`)
  await expect(projBox).toBeVisible({ timeout: 10000 })
  if (!(await projBox.isChecked())) await projBox.check()

  await panel.locator('[data-testid="sync-peers"] label', { hasText: PEER_NAME }).click()
  const retired = panel.locator('[data-testid="sync-plan-retired"]')
  await expect(retired).toHaveCount(2, { timeout: 15000 })
  for (let i = 0; i < 2; i++) {
    const row = retired.nth(i)
    await expect(row.locator('[data-state="retired"]')).toHaveText('已退役')
    await expect(row.locator('input[type="checkbox"]')).toBeDisabled()
    await expect(row.locator('input[type="checkbox"]')).not.toBeChecked()
  }
})
