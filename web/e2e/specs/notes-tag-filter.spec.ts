import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  clearNotesViewUiState, closeNotesOverlayIfOpen, DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 侧栏标签过滤 E2E（P-20261112-7 S3）：行内标签徽记 / 标签行 chips 点击=按该
 * 标签过滤清单（GET /api/notes?tag= 服务端过滤），与标题搜索 AND 叠加；过滤态
 * 在搜索行下显示可移除的标签胶囊，移除恢复全量清单。
 *   1. 徽记点击过滤（请求携 ?tag=）→ AND 组合（标题搜索再筛）→ 空态分语境 →
 *      胶囊移除恢复全量
 *   2. 标签行 chips 点击同链（chip 切换过滤、胶囊跟随、x 恢复）+ 徽记 title
 *      全名（截断友好语境）
 * 自备临时仓库与项目，afterAll 清理（范式与 notes-tags.spec 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-tag-filter')
const PROJ = 'e2e-notes-tag-filter'

let projId = ''
let headers: Record<string, string> = { 'Content-Type': 'application/json' }

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes-tag-filter e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 侧栏标签过滤基线'])
}

interface NoteMeta { id: string; title: string; tags?: string[] }

async function globalList(trash = false): Promise<NoteMeta[]> {
  const res = await fetch(`${API_BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data?: NoteMeta[] }).data ?? []
}

async function purgeAllGlobal(): Promise<void> {
  for (const view of [await globalList(), await globalList(true)]) {
    for (const n of view) {
      await fetch(`${API_BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
    }
  }
}

async function apiCreate(title: string, content: string, tags?: string[]): Promise<string> {
  const res = await fetch(`${API_BASE}/api/notes`, {
    method: 'POST', headers, body: JSON.stringify({ title, content, tags }),
  })
  expect(res.status).toBe(201)
  return ((await res.json()) as { data?: { id?: string } }).data?.id || ''
}

async function openNotesPanel(page: Page) {
  const panel = page.locator('[data-testid="notes-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-notes"]').click()
  }
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-notes"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

/** 侧栏在册行（不含回收站段）——清单断言与行内徽记定位的统一入口 */
function listItems(page: Page) {
  return page.locator('.np-sidebar [data-testid="notes-list-item"]:not(.trashed)')
}

test.beforeAll(async () => {
  headers = await unlockHeaders()
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  for (const p of stale.data ?? []) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  makeRepo(REPO)
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  headers = await unlockHeaders()
  await purgeAllGlobal()
  if (projId) await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  // uiState notesView 开态键兜底归位（P-20261112-6-S1；notes-view.spec afterAll
  // 同款）：本 spec 用例结束时面板保持打开，开态残留会跨 spec/跨 run 复活遮住
  // 首页项目卡——命名空间浅合并只清本键，其余命名空间不动
  await clearNotesViewUiState(API_BASE)
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('徽记点击过滤：清单拉取携 ?tag= → 与标题搜索 AND → 空态分语境 → 胶囊移除恢复全量', async ({ page }) => {
  await purgeAllGlobal()
  const idA = await apiCreate('项目交接', 'handover', ['alpha', '很长的标签名称用于验证截断title提示'])
  await apiCreate('会议记录', 'meeting', ['alpha'])
  const idC = await apiCreate('项目草稿', 'draft', ['gamma'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await closeNotesOverlayIfOpen(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)

  // 全量清单 3 行；行内徽记与清单 meta.tags 一致
  await expect(listItems(page)).toHaveCount(3, { timeout: 8000 })
  const rowA = listItems(page).filter({ hasText: '项目交接' })
  await expect(rowA.locator('[data-testid="notes-list-tag"]').filter({ hasText: 'alpha' })).toBeVisible()
  // 徽记 title=全名（截断友好语境：侧栏宽可调，拖宽即见全名）
  await expect(rowA.locator('[data-testid="notes-list-tag"]').filter({ hasText: '很长的标签名称' }))
    .toHaveAttribute('title', '很长的标签名称用于验证截断title提示')

  // 点徽记 alpha → 服务端过滤（请求携 ?tag=alpha），清单收窄到 2 行 + 过滤胶囊出现
  const tagReq = page.waitForRequest(r => r.method() === 'GET' && r.url().includes('/api/notes?tag=alpha'))
  await rowA.locator('[data-testid="notes-list-tag"]').filter({ hasText: 'alpha' }).click()
  expect((await tagReq).url()).toContain('tag=alpha')
  await expect(listItems(page)).toHaveCount(2)
  await expect(listItems(page).filter({ hasText: '项目交接' })).toBeVisible()
  await expect(listItems(page).filter({ hasText: '会议记录' })).toBeVisible()
  await expect(page.locator('[data-testid="notes-tag-filter-name"]')).toHaveText('alpha')

  // AND 组合：标题搜索再筛（服务端标签过滤 ∩ 本地标题过滤）
  const search = page.locator('[data-testid="notes-search"] input')
  await search.fill('项目')
  await expect(listItems(page)).toHaveCount(1)
  await expect(listItems(page).filter({ hasText: '项目交接' })).toBeVisible()
  await search.fill('')
  await expect(listItems(page)).toHaveCount(2) // 清搜索恢复标签过滤子集

  // AND 无交集：过滤语境空态（非空库文案）——同值徽记再点幂等（不重拉）
  await listItems(page).filter({ hasText: '项目交接' }).locator('[data-testid="notes-list-tag"]').filter({ hasText: 'alpha' }).click()
  await expect(page.locator('[data-testid="notes-tag-filter-name"]')).toHaveText('alpha')
  await search.fill('草稿') // 仅 C（gamma 篇）标题含——不在 alpha 子集内 → AND 无交集
  await expect(listItems(page)).toHaveCount(0)
  await expect(page.locator('.np-sidebar').locator('.np-sidebar-empty')).toHaveText('没有带该标签的笔记')
  await search.fill('')

  // 胶囊 x 移除过滤 → 全量清单回归
  await page.locator('[data-testid="notes-tag-filter-clear"]').click()
  await expect(page.locator('[data-testid="notes-tag-filter"]')).toHaveCount(0)
  await expect(listItems(page)).toHaveCount(3)
  expect(await globalList().then(l => l.find(n => n.id === idA)?.tags)).toEqual(['alpha', '很长的标签名称用于验证截断title提示']) // 过滤链零写副作用
  expect((await globalList()).find(n => n.id === idC)?.tags).toEqual(['gamma']) // idC 未被过滤链触碰
})

test('标签行 chips 点击同链：chip 切换过滤、胶囊跟随、x 恢复全量', async ({ page }) => {
  await purgeAllGlobal()
  await apiCreate('会议记录', 'meeting', ['alpha'])
  await apiCreate('草稿篇', 'draft')
  await apiCreate('交接篇', 'handover', ['alpha', 'beta'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await closeNotesOverlayIfOpen(page)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  const panel = await openNotesPanel(page)

  // 切到「交接篇」（最新建 updatedAt 最大——清单首位，稳妥显式切）
  await panel.locator('.np-tab').filter({ hasText: '交接篇' }).click()
  await expect(panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'beta' })).toBeVisible({ timeout: 4000 })

  // 点标签行 chip 'beta' → 同链过滤（清单收窄到带 beta 的篇 + 胶囊出现）
  await panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'beta' }).click()
  await expect(page.locator('[data-testid="notes-tag-filter-name"]')).toHaveText('beta', { timeout: 8000 })
  await expect(listItems(page)).toHaveCount(1)
  await expect(listItems(page).filter({ hasText: '交接篇' })).toBeVisible()

  // 再点 chip 'alpha' → 过滤切换（alpha 清单 2 行，与 beta 的 1 行可区分）
  await panel.locator('[data-testid="notes-tag"]').filter({ hasText: 'alpha' }).first().click()
  await expect(page.locator('[data-testid="notes-tag-filter-name"]')).toHaveText('alpha')
  await expect(listItems(page)).toHaveCount(2)
  await expect(listItems(page).filter({ hasText: '会议记录' })).toBeVisible()

  // 胶囊 x 恢复全量（3 行，与 alpha 子集的 2 行可区分）
  await page.locator('[data-testid="notes-tag-filter-clear"]').click()
  await expect(listItems(page)).toHaveCount(3, { timeout: 8000 })
  await expect(page.locator('[data-testid="notes-tag-filter"]')).toHaveCount(0)
})
