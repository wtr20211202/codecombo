import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName, closeShareManagerAndClearState } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享模式错位面修复 e2e（P-20261114-3-S1 两面 + P-20261114-3-S2 本步面）：
 *   1. 批量告知（S1 面）：多选右键「分享选中」→ 创建弹层批量区块披露服务端
 *      约束句（paths 仅收 frozen、不可切实时——替代撞 400 才知），share.batch.
 *      frozenOnlyNote 的 data-testid="share-batch-frozen-only" 在场
 *   2. 单路径重发切 live（S1 面）：过期冻结行「重新分享」弹层模式可改——
 *      默认沿用来源（定格提示行），切「实时视图」确认后重建为 live 行
 *     （sm-frozen-badge 消失；S1 的存在意义：重发不该被锁死在来源模式上）
 *   3. 快照陈旧徽标与原地刷新联动（S2 面）：frozen 创建记源根基准 → 改源 →
 *      管理列表行显「源已更新」徽标（staleAt 投影）+ 快捷刷新钮在场 →
 *      原地刷新（保 token 换内容）→ 徽标消失、基准复位（API 复核 staleAt
 *      缺省）。徽标是提示性面，处置主路 = 原地刷新（P-20261005-177）
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性。
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
// 批量告知探针（docs/ 前缀内，两项同屏可选）
const BATCH_DIR = 'e2e-stale-batch'
const BATCH_PATHS = [`docs/${BATCH_DIR}/one.txt`, `docs/${BATCH_DIR}/two.txt`]
// 陈旧联动探针（单文件 frozen）
const STALE_PROBE = 'docs/e2e-stale-probe.txt'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

/** 播种探针文件（先删后建保内容可控；分享创建要对目标 stat + 敏感扫描） */
async function seedFile(request: APIRequestContext, headers: Record<string, string>, projectId: string, path: string, content: string): Promise<void> {
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path } }).catch(() => {})
  const res = await request.post(`${BASE}/api/projects/${projectId}/file/create`, {
    headers, data: { path, content },
  })
  expect(res.ok()).toBeTruthy()
}

async function removeProbeFiles(request: APIRequestContext, headers: Record<string, string>, projectId: string): Promise<void> {
  for (const p of [...BATCH_PATHS, STALE_PROBE]) {
    await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: p } }).catch(() => {})
  }
  await request.post(`${BASE}/api/projects/${projectId}/file/delete`, { headers, data: { path: `docs/${BATCH_DIR}` } }).catch(() => {})
}

/** 建一条 frozen 分享，返回 token */
async function seedFrozenShare(request: APIRequestContext, headers: Record<string, string>, projectId: string, path: string, expiresAt?: string): Promise<string> {
  const res = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path, mode: 'frozen' } })
  expect(res.ok()).toBeTruthy()
  const token = ((await res.json()) as { data?: { token: string } }).data?.token
  expect(token).toBeTruthy()
  if (expiresAt) {
    const upd = await request.post(`${BASE}/api/share/${token}/expiry`, { headers, data: { expiresAt } })
    expect(upd.ok()).toBeTruthy()
  }
  return token!
}

/** 行内列表投影按 token 取 staleAt 有无 */
async function staleAtPresent(request: APIRequestContext, headers: Record<string, string>, token: string): Promise<boolean> {
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string; staleAt?: string }[] }).data || []
  const row = list.find(s => s.token === token)
  return !!row?.staleAt
}

async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

// ── 文件树多选辅助（share-batch.spec 同款惯例：奇数次点击保证侧栏打开、
// 反复展开直到目标目录可见——展开态在 uiState 恢复 + 虚拟列表下有竞态） ──

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.getByText('README.md').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

async function expandDir(page: Page, name: string): Promise<void> {
  const dir = itemByName(page, name)
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    const arrow = (await dir.locator('.dir-arrow').textContent().catch(() => '')) || ''
    if (arrow === '▼') return
    await dir.click()
    await page.waitForTimeout(600)
  }
}

// 分享管理开态残留清场（P-20261112-6-S3）：开态即时写落 uiState 会在后续
// 用例恢复出管理视图——rail 再点被 toggle 语义反转。先卸载 SPA 防 unload
// 路径回写，再 API 只清 shareManager 命名空间
test.afterEach(async ({ page, request }) => {
  await closeShareManagerAndClearState(page, request, BASE)
})
test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})
test.afterEach(async ({ request }) => {
  await cleanupShares(request)
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers).catch(() => '')
  if (projectId) await removeProbeFiles(request, headers, projectId)
})

test('批量告知：多选右键分享选中 → 创建弹层披露服务端约束句（仅冻结）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedFile(request, headers, projectId, BATCH_PATHS[0], 'stale-batch-one')
  await seedFile(request, headers, projectId, BATCH_PATHS[1], 'stale-batch-two')

  await enterProject(page)
  await expandDir(page, 'docs')
  await expandDir(page, BATCH_DIR)
  const one = itemByName(page, 'one.txt')
  const two = itemByName(page, 'two.txt')
  await expect(one).toBeVisible({ timeout: 5000 })
  await one.click({ modifiers: ['Control'] })
  await two.click({ modifiers: ['Control'] })
  await expect(page.locator('.tree-item.selected')).toHaveCount(2)

  // 右键落在多选集合内 → 「分享选中（2 项）」→ 创建弹层批量区块
  await two.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('分享选中（2 项）', { exact: true }).click()

  const createModal = page.locator('.share-create-modal')
  await expect(createModal).toBeVisible()
  await expect(createModal.locator('[data-testid="share-batch-mode"]')).toBeVisible()
  // S1 面：批量区块就地披露服务端约束句（paths 非空仅收 frozen，不可切实时）
  // ——替代「撞 400 才知」；批量记录重发链路的同族约束在 ShareReshareDialog
  const note = createModal.locator('[data-testid="share-batch-frozen-only"]')
  await expect(note).toBeVisible()
  await expect(note).toContainText('服务端约束')
  await expect(note).toContainText('仅支持定格快照')

  // 约束句是告知面不是拦截面：确认后照常创建成功（批量链路健全）
  await createModal.locator('[data-testid="share-create-confirm"]').click()
  const resultModal = page.locator('.share-result-modal')
  await expect(resultModal).toBeVisible()
  const link = await resultModal.locator('input[readonly]').inputValue()
  expect(link).toMatch(/\/s\/[0-9a-z]{16}$/)
})

test('单路径重发切 live：过期冻结行重发弹层模式切实时 → 重建为 live 行', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedFile(request, headers, projectId, STALE_PROBE, 'stale probe v1\n')
  const past = new Date(Date.now() - 60_000).toISOString()
  const token = await seedFrozenShare(request, headers, projectId, STALE_PROBE, past)

  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: STALE_PROBE })
  await expect(row).toHaveCount(1)
  await expect(row.locator('[data-testid="sm-frozen-badge"]')).toBeVisible()

  // 重发弹层（P-20261114-3-S1 显式确认面）：沿用提示在场 → 切「实时视图」
  await row.getByTestId('sm-more-btn').click()
  await page.locator('.n-dropdown-menu').last().getByText('重新分享', { exact: true }).click()
  const reshareModal = page.getByTestId('share-reshare-modal')
  await expect(reshareModal).toBeVisible()
  await expect(reshareModal.getByTestId('share-reshare-mode-hint')).toContainText('模式沿用来源链接')
  await reshareModal.getByTestId('share-reshare-mode-live').click()
  // 模式改过 → 沿用提示退场（单选组自身就是现状）
  await expect(reshareModal.getByTestId('share-reshare-mode-hint')).toHaveCount(0)
  await reshareModal.getByTestId('share-reshare-confirm').click()

  // 重建为 live：行不再带冻结徽标（API 复核 frozen 缺省）
  await expect(row.locator('[data-testid="sm-frozen-badge"]')).toHaveCount(0, { timeout: 10000 })
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string; frozen?: boolean }[] }).data || []
  const rebuilt = list.find(s => s.name.includes('e2e-stale-probe'))
  expect(rebuilt).toBeTruthy()
  expect(rebuilt!.frozen).toBeFalsy()
  expect(rebuilt!.token).not.toBe(token)
})

test('陈旧徽标与原地刷新联动：改源 → 徽标在场 → 快捷刷新 → 徽标消失基准复位', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  await seedFile(request, headers, projectId, STALE_PROBE, 'stale probe baseline\n')
  const token = await seedFrozenShare(request, headers, projectId, STALE_PROBE)

  // 新鲜基准：API 投影不带 staleAt（创建即当前源）
  expect(await staleAtPresent(request, headers, token)).toBe(false)

  // 改源（先删后建换内容 + mtime 前移）→ 投影置 staleAt（主档惰性对比；
  // fsnotify 加速器与主档殊途同归，此处只断言最终投影）
  await seedFile(request, headers, projectId, STALE_PROBE, 'stale probe CHANGED\n')
  await expect.poll(async () => staleAtPresent(request, headers, token), { timeout: 15000 }).toBe(true)

  // 管理列表：徽标在场 + 快捷刷新钮（原地刷新为主的快捷处置）
  await openManager(page)
  const row = page.locator('.sm-card tbody tr').filter({ hasText: STALE_PROBE })
  await expect(row).toHaveCount(1)
  const badge = row.getByTestId('sm-stale-badge')
  await expect(badge).toBeVisible()
  await expect(badge).toHaveText('源已更新')
  const quick = row.getByTestId('sm-refresh-quick')
  await expect(quick).toBeVisible()

  // 原地刷新（保 token 换内容）：确认框 → 刷新 → 徽标消失 + API 基准复位
  await quick.click()
  await page.locator('.n-dialog').getByRole('button', { name: '刷新快照' }).click()
  await expect(row.getByTestId('sm-stale-badge')).toHaveCount(0, { timeout: 10000 })
  await expect(row.getByTestId('sm-refresh-quick')).toHaveCount(0, { timeout: 10000 })
  await expect.poll(async () => staleAtPresent(request, headers, token), { timeout: 10000 }).toBe(false)
  // 链接保持不变（保 token 语义）：列表里的短链仍是同一条
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  expect(list.some(s => s.token === token)).toBe(true)
})
