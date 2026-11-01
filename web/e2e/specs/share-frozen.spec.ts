import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 分享冻结快照模式（P-20261003-320）E2E：
 *   1. 核心语义 API 链路：frozen 创建（data.frozen + 默认 30 天 TTL）→ 访客
 *      raw 读到副本 → 项目内继续改 → 访客内容不变 → 撤销 → 访客立即失效
 *   2. 敏感扫描：frozen 对副本扫描——命中拦截（不给 data）+ override 放行
 *      （创建成功、warnings 附带）
 *   3. rotate 组合：轮换换 token、副本不动（旧链 404、新链 raw 内容一致）
 *   4. 原地刷新（P-20261005-177）：同 token 重拷当前内容（已分发链接不断）
 *      → TTL 重置；扫描命中拦下旧副本保留 → override 放行换新
 *   5. UI 链路：文件树右键 → 创建弹层模式选择（冻结说明）→ 结果卡 →
 *      管理列表「冻结」徽标 + 倒计时；frozen 行「刷新快照」钮全链
 * 夹具：自建临时项目（含 .env 敏感文件 + 干净目录），路径经 serverPath() 折算
 * （跨拓扑口径）；核心语义用种子项目 + 探针文件（share.spec 同款做法）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJECT_NAME = 'simple-coding'
const FIXTURE_PROJ = 'e2e-share-frozen'
const DAY = 24 * 60 * 60 * 1000

let unlockToken = ''
let FIXTURE_DIR = ''

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

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  // 夹具项目（同名先删，幂等）：.env 敏感文件 + 干净目录 notes/readme.md
  const stale = await findProject(FIXTURE_PROJ)
  if (stale) await api('DELETE', `/api/projects/${stale.id}`)
  FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-share-frozen-'))
  const writeFile = (rel: string, content: string) => {
    const p = path.join(FIXTURE_DIR, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
  }
  writeFile('.env', 'API_KEY=secret-frozen-2222')
  writeFile('notes/readme.md', '# frozen fixture v1\n')
  const proj = await api('POST', '/api/projects', { name: FIXTURE_PROJ, path: serverPath(FIXTURE_DIR) })
  expect([200, 201]).toContain(proj.status)
  await cleanupShares()
})

test.afterAll(async () => {
  await cleanupShares()
  const mine = await findProject(FIXTURE_PROJ)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('冻结核心语义：创建即复制 → 项目内继续改访客不变 → 撤销即失效', async () => {
  const proj = await findProject(PROJECT_NAME)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()
  const PROBE = 'e2e-frozen-probe.txt'

  // 探针文件（先删后建幂等，防残留 409）；创建成功为 201
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  const create = await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'frozen-e2e-v1' })
  expect([200, 201]).toContain(create.status)

  // 冻结创建：data.frozen + 默认 30 天 TTL（±1 分钟容差）
  const r = await api('POST', '/api/share', { projectId, path: PROBE, mode: 'frozen' })
  expect(r.status).toBe(200)
  expect(r.json?.data?.frozen).toBe(true)
  expect(r.json?.warnings).toEqual([])
  const token = r.json?.data?.token as string
  expect(token).toBeTruthy()
  const expiresAt = Date.parse(r.json?.data?.expiresAt || '')
  expect(expiresAt).toBeGreaterThan(Date.now() + 30 * DAY - 60_000)
  expect(expiresAt).toBeLessThan(Date.now() + 30 * DAY + 60_000)

  // 访客 raw 读到副本内容
  const raw1 = await fetch(`${shareBase}/s/${token}/raw`)
  expect(raw1.status).toBe(200)
  expect(await raw1.text()).toBe('frozen-e2e-v1')

  // 幂等：重复冻结分享返回同链（副本不刷新语义的服务端口径）
  const again = await api('POST', '/api/share', { projectId, path: PROBE, mode: 'frozen' })
  expect(again.json?.data?.token).toBe(token)

  // 项目内继续改：访客内容不变（冻结的核心承诺）
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  const modify = await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'DRIFTED-v2' })
  expect([200, 201]).toContain(modify.status)
  const raw2 = await fetch(`${shareBase}/s/${token}/raw`)
  expect(raw2.status).toBe(200)
  expect(await raw2.text()).toBe('frozen-e2e-v1')

  // live 对照：同目标活视图随项目漂移（frozen/live 独立记录并存）
  const live = await api('POST', '/api/share', { projectId, path: PROBE })
  expect(live.json?.data?.token).toBeTruthy()
  expect(live.json?.data?.token).not.toBe(token)
  const liveRaw = await fetch(`${shareBase}/s/${live.json.data.token}/raw`)
  expect(await liveRaw.text()).toBe('DRIFTED-v2')

  // 撤销冻结链：访客立即失效，live 链不受影响
  const del = await api('DELETE', `/api/share/${token}`)
  expect(del.status).toBe(200)
  expect((await fetch(`${shareBase}/s/${token}/raw`)).status).toBe(404)
  expect((await fetch(`${shareBase}/s/${live.json.data.token}/raw`)).status).toBe(200)

  // 清理探针文件（种子项目仓库不得残留）
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  const list = await api('GET', '/api/share')
  expect(((list.json?.data || []) as unknown[]).length).toBe(1)
  await api('DELETE', `/api/share/${live.json.data.token}`)
})

test('冻结敏感扫描：命中拦截（不给 data）→ override 放行（warnings 附带）', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id

  // 命中 .env：拦截路径不落库
  const blocked = await api('POST', '/api/share', { projectId, path: '', mode: 'frozen' })
  expect(blocked.status).toBe(200)
  expect(blocked.json?.data).toBeUndefined()
  expect(blocked.json?.warnings).toEqual(['.env'])
  const emptyList = await api('GET', '/api/share')
  expect(((emptyList.json?.data || []) as unknown[]).length).toBe(0)

  // override：创建成功（frozen 标记），响应仍附 warnings 供展示
  const created = await api('POST', '/api/share', { projectId, path: '', mode: 'frozen', override: true })
  expect(created.status).toBe(200)
  expect(created.json?.data?.frozen).toBe(true)
  expect(created.json?.warnings).toEqual(['.env'])
  await api('DELETE', `/api/share/${created.json.data.token}`)

  // 非法 mode：400
  expect((await api('POST', '/api/share', { projectId, path: 'notes', mode: 'weird' })).status).toBe(400)
})

test('冻结 + 轮换：rotate 换 token、副本不动（新链读同一份冻结内容）', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()

  const r = await api('POST', '/api/share', { projectId, path: 'notes/readme.md', mode: 'frozen' })
  expect(r.status).toBe(200)
  const oldToken = r.json?.data?.token as string
  expect(oldToken).toBeTruthy()

  // 轮换：新 token ≠ 旧 token；旧链失效、新链 raw 内容一致（副本原地不动）
  const rot = await api('POST', `/api/share/${oldToken}/rotate`)
  expect(rot.status).toBe(200)
  const newToken = rot.json?.data?.token as string
  expect(newToken).toBeTruthy()
  expect(newToken).not.toBe(oldToken)
  expect((await fetch(`${shareBase}/s/${oldToken}/raw`)).status).toBe(404)
  const raw = await fetch(`${shareBase}/s/${newToken}/raw`)
  expect(raw.status).toBe(200)
  expect(await raw.text()).toBe('# frozen fixture v1\n')
  await api('DELETE', `/api/share/${newToken}`)
})

test('原地刷新：同 token 换内容 → TTL 重置 → 已分发链接不断（P-20261005-177）', async () => {
  const proj = await findProject(PROJECT_NAME)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()
  const PROBE = 'e2e-refresh-probe.txt'

  // 播种冻结链 + 显式把有效期收短到 2 天（TTL 重置的可观测口径：刷新后回 ~30 天）
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'refresh-e2e-v1' })
  const r = await api('POST', '/api/share', { projectId, path: PROBE, mode: 'frozen' })
  expect(r.status).toBe(200)
  const token = r.json?.data?.token as string
  expect(token).toBeTruthy()
  const shorten = await api('POST', `/api/share/${token}/expiry`, { expiresAt: new Date(Date.now() + 2 * DAY).toISOString() })
  expect(shorten.status).toBe(200)

  // 项目内改动 → 原地刷新（空 body）：同 token、新内容
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'refresh-e2e-v2' })
  const ref = await api('POST', `/api/share/${token}/refresh`)
  expect(ref.status).toBe(200)
  expect(ref.json?.data?.token).toBe(token)
  expect(ref.json?.warnings).toEqual([])

  // 同 token 访客看到新内容（保 token 换内容的核心承诺）
  const raw = await fetch(`${shareBase}/s/${token}/raw`)
  expect(raw.status).toBe(200)
  expect(await raw.text()).toBe('refresh-e2e-v2')

  // TTL 重置：回到 ~30 天（±1 分钟容差）
  const expiresAt = Date.parse(ref.json?.data?.expiresAt || '')
  expect(expiresAt).toBeGreaterThan(Date.now() + 30 * DAY - 60_000)

  await api('DELETE', `/api/share/${token}`)
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
})

test('刷新敏感扫描：命中拦下旧副本保留 → override 放行换新内容', async () => {
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()

  // 干净 notes 目录播种冻结链
  const r = await api('POST', '/api/share', { projectId, path: 'notes', mode: 'frozen' })
  expect(r.status).toBe(200)
  const token = r.json?.data?.token as string
  expect(token).toBeTruthy()

  // 源里漂移 + 混入敏感文件后刷新：命中拦下（不给 data）
  fs.writeFileSync(path.join(FIXTURE_DIR, 'notes', 'readme.md'), '# refreshed v2\n')
  fs.writeFileSync(path.join(FIXTURE_DIR, 'notes', '.env'), 'K=refresh-e2e')
  const blocked = await api('POST', `/api/share/${token}/refresh`)
  expect(blocked.status).toBe(200)
  expect(blocked.json?.data).toBeUndefined()
  expect(blocked.json?.warnings).toEqual(['.env'])

  // 未确认刷新不换内容：访客仍读旧定格副本（暂存已丢弃、旧副本原样）
  const raw = await fetch(`${shareBase}/s/${token}/raw?path=readme.md`)
  expect(raw.status).toBe(200)
  expect(await raw.text()).toBe('# frozen fixture v1\n')

  // override 二次请求：新副本顶上（token 仍不变）
  const ok = await api('POST', `/api/share/${token}/refresh`, { override: true })
  expect(ok.status).toBe(200)
  expect(ok.json?.data?.token).toBe(token)
  const raw2 = await fetch(`${shareBase}/s/${token}/raw?path=readme.md`)
  expect(raw2.status).toBe(200)
  expect(await raw2.text()).toBe('# refreshed v2\n')
  await api('DELETE', `/api/share/${token}`)
})

test('占用可见（P-20261005-176）：建两份 frozen → 头部行合计正确 → 单份体积列 → 撤销回落', async ({ page }) => {
  test.setTimeout(60_000)
  await cleanupShares()
  const proj = await findProject(FIXTURE_PROJ)
  expect(proj).toBeTruthy()
  const projectId = proj!.id

  // 造一份已知更大的目标（200KB 填充），与既有 19B 的 readme.md 各冻一份
  const BIG = 'notes/big.md'
  await api('POST', `/api/projects/${projectId}/file/create`, { path: BIG, content: 'x'.repeat(200 * 1024) })
  for (const target of ['notes/readme.md', BIG]) {
    const r = await api('POST', '/api/share', { projectId, path: target, mode: 'frozen' })
    expect(r.status).toBe(200)
  }

  // API 投影：capBytes = 总量护栏常量；totalBytes = 两份快照目录之和；
  // 每条 frozen 行带 frozenBytes = 该份快照字节量（大头行更大）
  const { json } = await api('GET', '/api/share')
  const usage = json?.frozenUsage as { totalBytes: number; capBytes: number } | undefined
  expect(usage).toBeTruthy()
  expect(usage!.capBytes).toBe(1024 ** 3)
  const rows = (json?.data || []) as { token: string; frozen?: boolean; frozenBytes?: number; path?: string }[]
  const frozenRows = rows.filter((r) => r.frozen)
  expect(frozenRows).toHaveLength(2)
  for (const r of frozenRows) expect(r.frozenBytes).toBeGreaterThan(0)
  const big = frozenRows.find((r) => r.path === BIG)!
  const small = frozenRows.find((r) => r.path === 'notes/readme.md')!
  expect(big.frozenBytes!).toBeGreaterThan(small.frozenBytes!)
  expect(usage!.totalBytes).toBe(big.frozenBytes! + small.frozenBytes!)

  // UI：管理列表头部占用行（合计 + 上限）+ 单份体积列
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, FIXTURE_PROJ).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
  const usageTag = page.locator('[data-testid="sm-frozen-usage"]')
  await expect(usageTag).toContainText('冻结快照')
  await expect(usageTag).toContainText('/ 上限 1.0 GB')
  const bigRow = page.locator('tr').filter({ hasText: 'big.md' }).first()
  await expect(bigRow.locator('[data-testid="sm-frozen-bytes"]')).toHaveText(/^[\d.]+ (B|KB|MB|GB)$/)

  // 撤销即删副本 → 数字回落：合计归零、头部行随空库隐去、体积列清空
  for (const r of frozenRows) {
    const del = await api('DELETE', `/api/share/${r.token}`)
    expect(del.status).toBe(200)
  }
  await page.locator('.share-manager').getByRole('button', { name: '刷新', exact: true }).click()
  await expect(usageTag).toBeHidden()
  await expect(page.locator('[data-testid="sm-frozen-bytes"]')).toHaveCount(0)
  const after = await api('GET', '/api/share')
  expect(after.json?.frozenUsage?.totalBytes).toBe(0)

  // 夹具不残留（项目删除时一并清理，快照副本已随撤销即删）
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: BIG })
})

/** 等待文件树出现目标行（uiState 侧栏恢复竞态，share-sensitive-scan 同款） */
async function waitForTreeRow(page: Page, name: string) {
  const row = page.locator('.tree-item').filter({ hasText: name }).first()
  const railFiles = page.locator('[data-testid="rail-files"]')
  const deadline = Date.now() + 15000
  for (;;) {
    if (await row.isVisible().catch(() => false)) return
    if (Date.now() > deadline) break
    const expanded = await railFiles.getAttribute('aria-expanded').catch(() => null)
    if (expanded !== 'true') await railFiles.click().catch(() => { /* 未挂载重试 */ })
    await page.waitForTimeout(400)
  }
  await expect(row).toBeVisible()
}

test('UI：文件树右键 → 创建弹层选冻结 → 结果卡 → 管理列表冻结徽标', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, PROJECT_NAME).first()
  await projectCard.click()
  await page.waitForURL('**/project')
  await waitForTreeRow(page, 'docs')

  // 右键 docs 目录 → 生成分享链接 → 创建弹层（模式选择）
  const docsRow = page.locator('.tree-item').filter({ hasText: 'docs' }).first()
  await expect(docsRow).toBeVisible()
  await docsRow.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu')).toBeVisible()
  await page.locator('.n-dropdown-menu').getByText('生成分享链接', { exact: true }).click()

  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await expect(createModal).toContainText('docs')
  await expect(createModal).toContainText('实时视图')
  // 切到冻结模式：说明文案就位（内容定格不可变 + 30 天）
  await createModal.locator('[data-testid="share-mode-frozen"]').click()
  await expect(createModal).toContainText('内容定格')
  await createModal.locator('[data-testid="share-create-confirm"]').click()

  // 结果卡：frozen 描述行 + 可复制短链（frozen 带 30 天 TTL，结果卡多出
  // 有效期行——链接输入框以 readonly 精确锚定，避免与日期输入歧义）
  const modal = page.locator('.share-result-modal')
  await expect(modal).toBeVisible()
  const link = await modal.locator('input[readonly]').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
  const token = link.split('/').pop()!
  await expect(modal).toContainText('冻结副本')

  // 管理视图：该行带「冻结」徽标 + 倒计时（默认 30 天）
  await modal.getByRole('button', { name: '管理全部分享' }).click()
  await expect(modal).toBeHidden()
  const row = page.locator('tr').filter({ hasText: 'docs' }).first()
  await expect(row).toBeVisible()
  await expect(row.locator('[data-testid="sm-frozen-badge"]')).toHaveText('冻结')
  await expect(row.locator('[data-testid="sm-countdown"]')).toContainText('天后过期')

  // 访客面：raw 内容与源一致（冻结副本已服务）
  const shareBase = await getShareBase()
  const raw = await fetch(`${shareBase}/s/${token}/raw?path=polish-roadmap.md`)
  expect(raw.status).toBe(200)
  expect(await raw.text()).toContain('# ')
  await api('DELETE', `/api/share/${token}`)
})

test('UI：frozen 行「刷新快照」→ 确认（TTL 重置注记）→ 链接不变访客见新内容', async ({ page }) => {
  test.setTimeout(60_000)
  const proj = await findProject(PROJECT_NAME)
  expect(proj).toBeTruthy()
  const projectId = proj!.id
  const shareBase = await getShareBase()
  const PROBE = 'e2e-refresh-ui.txt'

  // API 播种冻结链 + 项目内漂移（UI 段只验管理器动作链）
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'refresh-ui-v1' })
  const r = await api('POST', '/api/share', { projectId, path: PROBE, mode: 'frozen' })
  const token = r.json?.data?.token as string
  expect(token).toBeTruthy()
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
  await api('POST', `/api/projects/${projectId}/file/create`, { path: PROBE, content: 'refresh-ui-v2' })

  // 管理视图：frozen 行出现「刷新快照」钮（live 行不出现）
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10_000 })
  const row = page.locator('tr').filter({ hasText: PROBE }).first()
  await expect(row.locator('[data-testid="sm-frozen-badge"]')).toBeVisible()
  // 「刷新快照」收进行尾「更多」菜单（P-20261020-9）：frozen 行才出现
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('刷新快照', { exact: true }).click()

  // 确认弹窗：交代链接不变 + 保留期重置
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('保留期重置为 30 天')
  await dlg.getByRole('button', { name: '刷新快照' }).click()

  // toast 反馈 + 列表保持同 token（链接不变）
  await expect(page.locator('.n-message').filter({ hasText: '冻结快照，链接不变' })).toBeVisible({ timeout: 10_000 })
  const list = await api('GET', '/api/share')
  const same = ((list.json?.data || []) as { token: string }[]).find(x => x.token === token)
  expect(same).toBeTruthy()

  // 访客面：同 token 读到新内容
  const raw = await fetch(`${shareBase}/s/${token}/raw`)
  expect(await raw.text()).toBe('refresh-ui-v2')

  await api('DELETE', `/api/share/${token}`)
  await api('POST', `/api/projects/${projectId}/file/delete`, { path: PROBE })
})
