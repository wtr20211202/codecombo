import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 多路径冻结分享（P-20261008-1）E2E：
 *   1. 核心语义：跨目录 3 文件 → 一条冻结单链（paths 排序投影、Path 空、30 天
 *      TTL）→ 访客根列表按 manifest 逐项列全路径 → 逐项 raw → 整包 zip →
 *      集合顺序无关幂等 → 源漂移访客不变 → TTL 到期 410 → 撤销即失效
 *   2. 敏感扫描：副本整扫命中拦下（不给 data、半成品丢弃）→ override 放行
 *   3. 护栏与兼容：>50 项/live/互斥/上跳/缺失目标拒绝；旧单路径 frozen 与
 *      单路径 batch 是两条独立链（命名空间隔离，旧记录零迁移语义）
 *   4. UI：文件树多选 3 文件右键「分享选中」→ 弹层集合清单 + 合计体积预估 →
 *      结果卡 → 管理列表「批量 N 项」徽标 → 访客列表 3 项
 * 夹具：自建临时项目（含 .env 敏感文件 + 三个干净文件跨 notes/src/docs），
 * 路径经 serverPath() 折算（跨拓扑口径）；UI 段探针建在 simple-coding 仓库
 * docs/e2e-sb/ 下（file-tree-batch-download 同款播种/清理惯例）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const FIXTURE_PROJ = 'e2e-share-batch'
const DAY = 24 * 60 * 60 * 1000
// UI 段探针（只建在 docs/ 前缀内，目录保持小体积让三项同屏可见）
const PROBE_ROOT = 'e2e-sb'
const PROBE_PATHS = [`docs/${PROBE_ROOT}/one.txt`, `docs/${PROBE_ROOT}/two.txt`, `docs/${PROBE_ROOT}/sub/three.txt`]

let unlockToken = ''
let FIXTURE_DIR = ''
let fixtureProjectId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

async function cleanupShares(): Promise<void> {
  const { json } = await api('GET', '/api/share')
  const list = ((json?.data || []) as { token: string }[])
  for (const s of list) await api('DELETE', `/api/share/${s.token}`)
}

async function listShares(): Promise<{ token: string; paths?: string[]; frozen?: boolean }[]> {
  const { json } = await api('GET', '/api/share')
  return ((json?.data || []) as { token: string; paths?: string[]; frozen?: boolean }[])
}

async function findProject(name: string): Promise<{ id: string } | undefined> {
  const { json } = await api('GET', '/api/projects')
  return ((json?.data || []) as { id: string; name: string }[]).find(x => x.name === name)
}

async function getShareBase(): Promise<string> {
  const { json } = await api('GET', '/api/share/status')
  const status = json?.data as { running: boolean; port: number; scheme: string }
  if (!status?.running) throw new Error('share service not running')
  return `${status.scheme || 'http'}://localhost:${status.port}`
}

async function seedFile(projectId: string, rel: string, content: string) {
  const token = unlockToken
  const res = await fetch(`${BASE}/api/projects/${projectId}/file/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ path: rel, content }),
  }).catch(() => null)
  // 已存在（历史残留）时先删后建，保证内容可控
  if (!res || !res.ok) {
    await api('POST', `/api/projects/${projectId}/file/delete`, { path: rel }).catch(() => {})
    const retry = await fetch(`${BASE}/api/projects/${projectId}/file/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
      body: JSON.stringify({ path: rel, content }),
    })
    if (!retry.ok) throw new Error(`seed ${rel} failed: HTTP ${retry.status}`)
  }
}

async function deleteProjectFile(projectId: string, rel: string) {
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: rel }).catch(() => {})
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 夹具项目（同名先删，幂等）：.env 敏感文件 + 三个跨目录干净文件
  const stale = await findProject(FIXTURE_PROJ)
  if (stale) await api('DELETE', `/api/projects/${stale.id}`)
  FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-share-batch-'))
  const writeFile = (rel: string, content: string) => {
    const p = path.join(FIXTURE_DIR, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  writeFile('.env', 'API_KEY=batch-secret-3333')
  writeFile('notes/readme.md', '# batch fixture\n')
  writeFile('src/a.ts', 'export const a = 1\n')
  writeFile('docs/b.md', '# b doc\n')
  const proj = await api('POST', '/api/projects', { name: FIXTURE_PROJ, path: serverPath(FIXTURE_DIR) })
  expect([200, 201]).toContain(proj.status)
  fixtureProjectId = (await findProject(FIXTURE_PROJ))?.id || ''

  // UI 探针（simple-coding 仓库 docs/e2e-sb/）：三项内容可辨识
  const seed = await findProject(PROJECT_NAME)
  expect(seed).toBeTruthy()
  await deleteProjectFile(seed!.id, PROBE_PATHS[0])
  await deleteProjectFile(seed!.id, PROBE_PATHS[1])
  await deleteProjectFile(seed!.id, PROBE_PATHS[2])
  await seedFile(seed!.id, PROBE_PATHS[0], 'batch-share-one')
  await seedFile(seed!.id, PROBE_PATHS[1], 'batch-share-two')
  await seedFile(seed!.id, PROBE_PATHS[2], 'batch-share-three')

  await cleanupShares()
})

test.afterAll(async () => {
  await cleanupShares()
  if (fixtureProjectId) await api('DELETE', `/api/projects/${fixtureProjectId}`)
  const seed = await findProject(PROJECT_NAME)
  if (seed) {
    for (const p of PROBE_PATHS) await deleteProjectFile(seed.id, p)
    await deleteProjectFile(seed.id, `docs/${PROBE_ROOT}/sub`)
    await deleteProjectFile(seed.id, `docs/${PROBE_ROOT}`)
  }
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('批量核心语义：跨目录 3 文件单链 → 访客 manifest/逐项/整包 → 定格 → TTL 410 → 撤销', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()
  const paths = ['src/a.ts', 'notes/readme.md', 'docs/b.md']

  // 创建：frozen + Path 空 + paths 规范化排序 + 默认 30 天 TTL
  const r = await api('POST', '/api/share', { projectId, paths, mode: 'frozen' })
  expect(r.status).toBe(200)
  expect(r.json?.data?.frozen).toBe(true)
  expect(r.json?.data?.path).toBe('')
  expect(r.json?.data?.paths).toEqual([...paths].sort())
  expect(r.json?.warnings).toEqual([])
  const token = r.json?.data?.token as string
  expect(token).toBeTruthy()
  const expiresAt = Date.parse(r.json?.data?.expiresAt || '')
  expect(expiresAt).toBeGreaterThan(Date.now() + 30 * DAY - 60_000)
  expect(expiresAt).toBeLessThan(Date.now() + 30 * DAY + 60_000)

  // 访客根列表 = manifest：三项全路径（不是快照里的 notes/src/docs 目录树）
  const listRes = await fetch(`${shareBase}/s/${token}/list`)
  expect(listRes.status).toBe(200)
  const list = (await listRes.json()) as { entries: { name: string; path: string; isDir: boolean }[] }
  expect(list.entries.map(e => e.name).sort()).toEqual([...paths].sort())
  expect(list.entries.map(e => e.path).sort()).toEqual([...paths].sort())

  // 逐项预览：raw 命中各自副本内容
  const rawA = await fetch(`${shareBase}/s/${token}/raw?path=src/a.ts`)
  expect(rawA.status).toBe(200)
  expect(await rawA.text()).toBe('export const a = 1\n')
  const rawB = await fetch(`${shareBase}/s/${token}/raw?path=docs/b.md`)
  expect(await rawB.text()).toBe('# b doc\n')

  // 整体 zip：根下载包含全部三项（条目保留项目内相对路径）
  const dl = await fetch(`${shareBase}/s/${token}/dl/`)
  expect(dl.status).toBe(200)
  expect(dl.headers.get('content-type')).toBe('application/zip')
  const zipBuf = Buffer.from(await dl.arrayBuffer())
  expect(zipBuf.subarray(0, 2).toString('latin1')).toBe('PK')
  for (const p of paths) expect(zipBuf.includes(Buffer.from(p))).toBe(true)

  // 集合顺序无关幂等：反序重建同链（副本不重拷、CreatedAt 不刷新）
  const again = await api('POST', '/api/share', { projectId, paths: [...paths].reverse(), mode: 'frozen' })
  expect(again.status).toBe(200)
  expect(again.json?.data?.token).toBe(token)
  expect(again.json?.data?.createdAt).toBe(r.json?.data?.createdAt)

  // 源漂移：访客内容不变（frozen 的核心承诺）
  const drift = await fetch(`${BASE}/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ path: 'src/a.ts', content: 'DRIFTED' }),
  })
  expect(drift.ok).toBe(true)
  const rawAfter = await fetch(`${shareBase}/s/${token}/raw?path=src/a.ts`)
  expect(await rawAfter.text()).toBe('export const a = 1\n')
  // 复原源文件：后续「兼容」用例会重新冻结当前源内容，不带上本轮漂移
  const restore = await fetch(`${BASE}/api/projects/${projectId}/file`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ path: 'src/a.ts', content: 'export const a = 1\n' }),
  })
  expect(restore.ok).toBe(true)

  // TTL 到期：访客 410。lookup 对过期记录惰性删除（P-20261003-29），后续
  // 请求与撤销端点随即转 404——两种失效态的对外语义都要如实
  const expire = await api('POST', `/api/share/${token}/expiry`, { expiresAt: new Date(Date.now() - 1000).toISOString() })
  expect(expire.status).toBe(200)
  expect((await fetch(`${shareBase}/s/${token}`)).status).toBe(410)
  expect((await fetch(`${shareBase}/s/${token}/raw?path=src/a.ts`)).status).toBe(404)
  expect((await api('DELETE', `/api/share/${token}`)).status).toBe(404)
  expect((await fetch(`${shareBase}/s/${token}`)).status).toBe(404)

  // 恢复现场：TTL 惰性删除只删记录、副本留给周期对账（生产语义），而管理面
  // 占用投影（share-frozen 的严格合计断言）要求无记录的副本不残留——同集合
  // 重建一次（同键覆盖旧副本）再撤销，走正常「撤销即删副本」路径清账
  const revive = await api('POST', '/api/share', { projectId, paths, mode: 'frozen' })
  expect(revive.status).toBe(200)
  expect((await api('DELETE', `/api/share/${revive.json.data.token}`)).status).toBe(200)
})

test('批量敏感扫描：整份副本命中拦截（不给 data）→ override 放行', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()
  const paths = ['.env', 'notes/readme.md']

  // 命中 .env：拦截路径不落库（半成品副本随警告丢弃）
  const blocked = await api('POST', '/api/share', { projectId, paths, mode: 'frozen' })
  expect(blocked.status).toBe(200)
  expect(blocked.json?.data).toBeUndefined()
  expect((blocked.json?.warnings || []) as string[]).toContain('.env')
  expect((await listShares()).filter(s => s.paths?.length).length).toBe(0)

  // override：创建成功，响应仍附 warnings 供展示；访客可读 .env 副本
  const created = await api('POST', '/api/share', { projectId, paths, mode: 'frozen', override: true })
  expect(created.status).toBe(200)
  expect(created.json?.data?.frozen).toBe(true)
  expect((created.json?.warnings || []) as string[]).toContain('.env')
  const token = created.json?.data?.token as string
  const raw = await fetch(`${shareBase}/s/${token}/raw?path=.env`)
  expect(raw.status).toBe(200)
  expect(await raw.text()).toBe('API_KEY=batch-secret-3333')
  await api('DELETE', `/api/share/${token}`)
})

test('批量护栏与兼容：拒绝族全绿 + 单路径 frozen 与单路径 batch 不撞链', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()

  // 50 项上限 / live 批量 / path+paths 互斥 / 上跳 / 缺失目标
  const tooMany = Array.from({ length: 51 }, (_, i) => `f${i}.txt`)
  expect((await api('POST', '/api/share', { projectId, paths: tooMany, mode: 'frozen' })).status).toBe(400)
  expect((await api('POST', '/api/share', { projectId, paths: ['src/a.ts'] })).status).toBe(400)
  expect((await api('POST', '/api/share', { projectId, path: 'src/a.ts', paths: ['src/a.ts'], mode: 'frozen' })).status).toBe(400)
  expect((await api('POST', '/api/share', { projectId, paths: ['../secret'], mode: 'frozen' })).status).toBe(400)
  expect((await api('POST', '/api/share', { projectId, paths: ['src/missing.ts'], mode: 'frozen' })).status).toBe(404)

  // 兼容：旧形态（单 path frozen）与单路径 batch 是两条独立链，各自可读
  const single = await api('POST', '/api/share', { projectId, path: 'src/a.ts', mode: 'frozen' })
  const batch = await api('POST', '/api/share', { projectId, paths: ['src/a.ts'], mode: 'frozen' })
  expect(single.status).toBe(200)
  expect(batch.status).toBe(200)
  expect(batch.json?.data?.paths).toEqual(['src/a.ts'])
  expect(batch.json?.data?.token).not.toBe(single.json?.data?.token)
  expect(await (await fetch(`${shareBase}/s/${single.json.data.token}/raw`)).text()).toBe('export const a = 1\n')
  expect(await (await fetch(`${shareBase}/s/${batch.json.data.token}/raw?path=src/a.ts`)).text()).toBe('export const a = 1\n')
  await api('DELETE', `/api/share/${single.json.data.token}`)
  await api('DELETE', `/api/share/${batch.json.data.token}`)
})

// ── UI 段（多选右键入口） ──

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

// 反复收起/展开直到目标目录可见（展开态在 uiState 恢复 + 虚拟列表下有竞态）
async function expandDir(page: Page, name: string) {
  const dir = itemByName(page, name)
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    const arrow = (await dir.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') return
    await dir.click()
    await page.waitForTimeout(600)
  }
}

test('UI：多选 3 文件右键「分享选中」→ 弹层清单/体积预估 → 结果卡 → 管理徽标 → 访客列表', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await enterProject(page)
  await expandDir(page, 'docs')
  await expandDir(page, PROBE_ROOT)
  await expandDir(page, 'sub')

  // Ctrl+Click 增选三项（selectedPaths 只由 Ctrl/Shift 点击填充）
  const one = itemByName(page, 'one.txt')
  const two = itemByName(page, 'two.txt')
  const three = itemByName(page, 'three.txt')
  await expect(one).toBeVisible({ timeout: 5000 })
  await one.click({ modifiers: ['Control'] })
  await two.click({ modifiers: ['Control'] })
  await three.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-item.selected')).toHaveCount(3)

  // 右键落在多选集合内 → 「分享选中（3 项）」→ 创建弹层（批量仅冻结形态）
  await two.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('分享选中（3 项）', { exact: true }).click()

  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await expect(createModal).toContainText('共 3 项')
  const batchBox = createModal.locator('[data-testid="share-batch-paths"]')
  await expect(batchBox).toBeVisible()
  for (const p of [...PROBE_PATHS].sort()) await expect(batchBox).toContainText(p)
  await expect(createModal.locator('[data-testid="share-batch-mode"]')).toBeVisible()
  // 合计体积预估（files-archive probe）：等到数值落地而非停留在「正在估算」
  await expect(createModal.locator('[data-testid="share-batch-estimate"]'))
    .toHaveText(/约 \d+ 个文件条目，合计/, { timeout: 10_000 })
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  // 结果卡：批量描述 + 短链
  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const link = await modal.locator('input[readonly]').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  const token = link.split('/').pop()!
  await expect(modal).toContainText('这 3 项内容的定格副本')

  // 管理列表：批量徽标 + 项数摘要（名称取排序后首项 basename + 其余计数）
  await modal.getByRole('button', { name: '管理全部分享' }).click()
  await expect(modal).toBeHidden()
  const row = page.locator('tr').filter({ hasText: 'one.txt +2' }).first()
  await expect(row).toBeVisible()
  await expect(row.locator('[data-testid="sm-batch-badge"]')).toHaveText('批量 3 项')

  // 访客面：根列表三项全路径各自可读
  const shareBase = await getShareBase()
  const list = (await (await fetch(`${shareBase}/s/${token}/list`)).json()) as { entries: { name: string }[] }
  expect(list.entries.map(e => e.name).sort()).toEqual([...PROBE_PATHS].sort())
  const raw = await fetch(`${shareBase}/s/${token}/raw?path=${encodeURIComponent(PROBE_PATHS[0])}`)
  expect(await raw.text()).toBe('batch-share-one')

  await api('DELETE', `/api/share/${token}`)
})
