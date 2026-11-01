import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 密集面板可读性基线（P-20261019-3）E2E：
 * 计算样式断言代表选择器，防「以压字号换密度」回潮——
 *   舒适档：Git 提交元信息/refs/worktree 路径/分区标题与计数 ≥ 分层下限，
 *           文件树正文 ≥12px、设置标签 ≥12px、设置元信息 ≥11.5px；
 *   紧凑档：--fs-meta-min 注入 10.5px 保密度、行高 token 仍 22px，元信息不跌破下限。
 * 数值来源 = main.css 的 --fs-meta-min / --fs-section-min / --lh-meta 三 token，
 * 紧凑档覆写由 stores/ui-density.ts apply() 单点注入（本 spec 走 settings API
 * 落档 + 刷新，复刻启动 hydrate 链）。settings 是实例全局态，afterAll 还原
 * 舒适档；工作树经服务端 worktree API 创建（跨拓扑 serverPath 翻译）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-readability')
const WT_DIR = path.join(os.tmpdir(), 'sc-e2e-readability-wt')
const PROJ = 'e2e-readability'
const WT_BRANCH = 'wt-readability'
const META_FLOOR_COMFORT = 11.5
const META_FLOOR_COMPACT = 10.5
const SECTION_FLOOR = 12

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 密度档是服务端全局态：先落档再进页面，复刻 boot hydrate → apply 链 */
async function setDensity(density: 'comfortable' | 'compact'): Promise<void> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ uidensity: density }),
  })
  expect(res.ok).toBe(true)
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WT_DIR, REPO_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# readability baseline\n')
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'index.ts'), 'export const baseline = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 可读性基线夹具'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# readability baseline\n\nsecond commit\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'meta: 第二个提交（提交元信息断言用）'])

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')

  // 额外工作树：页面需渲染非主工作树行才有 .wt-path（经服务端 API 创建，
  // 路径按双路径纪律翻译，跨拓扑同源）
  const wt = await fetch(`${API_BASE}/api/projects/${projectId}/worktrees`, {
    method: 'POST', headers, body: JSON.stringify({ path: serverPath(WT_DIR), branch: WT_BRANCH }),
  })
  expect(wt.ok).toBe(true)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) {
    await fetch(`${API_BASE}/api/projects/${projectId}/worktrees`, {
      method: 'DELETE', headers, body: JSON.stringify({ path: serverPath(WT_DIR), force: true }),
    }).catch(() => { /* 残留由项目删除兜底 */ })
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  }
  for (const dir of [WT_DIR, REPO_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  // 密度档还原舒适档（实例全局态，防污染同实例其他 spec）
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ uidensity: 'comfortable' }),
  })
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).first().click()
  await page.waitForURL('**/project')
}

/** 底部 Git 面板（rail 是 toggle，uiState 恢复态不定） */
async function openGitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible({ timeout: 5000 })
  // 工作树分节是独立数据请求（worktreeApi.list），提交列表可见不代表已就绪
  await expect(page.locator('.git-sidebar .wt-path').first()).toBeAttached({ timeout: 5000 })
}

/** 左侧文件树（rail-files 同为 toggle） */
async function ensureFileTree(page: import('@playwright/test').Page) {
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.file-tree .tree-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.file-tree .tree-item').first()).toBeVisible({ timeout: 5000 })
}

interface FontMetric { fontSize: number; lineHeight: string }

/** 代表选择器的计算样式（元素缺失返回 null，由断言给出可读失败信息） */
async function readFontMetrics(
  page: import('@playwright/test').Page,
  selectors: string[],
): Promise<Record<string, FontMetric | null>> {
  return page.evaluate((sels) => {
    const out: Record<string, { fontSize: number; lineHeight: string } | null> = {}
    for (const sel of sels) {
      const el = document.querySelector(sel)
      if (!el) { out[sel] = null; continue }
      const cs = getComputedStyle(el)
      out[sel] = { fontSize: parseFloat(cs.fontSize), lineHeight: cs.lineHeight }
    }
    return out
  }, selectors)
}

function fontSizeOf(metrics: Record<string, FontMetric | null>, selector: string): number {
  const m = metrics[selector]
  expect(m, `选择器 ${selector} 应存在并渲染`).not.toBeNull()
  return m!.fontSize
}

test('舒适档：Git 元信息/分区/文件树/设置均守可读下限', async ({ page }) => {
  await setDensity('comfortable')
  await enterProject(page)
  await openGitPanel(page)

  const metrics = await readFontMetrics(page, [
    '.commit-msg',
    '.commit-meta',
    '.commit-refs',
    '.git-sidebar .section-header',
    '.git-sidebar .section-count',
    '.git-sidebar .section-add-btn',
    '.git-sidebar .wt-path',
  ])
  expect(fontSizeOf(metrics, '.commit-meta')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.commit-refs')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.git-sidebar .wt-path')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.git-sidebar .section-count')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.git-sidebar .section-add-btn')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.git-sidebar .section-header')).toBeGreaterThanOrEqual(SECTION_FLOOR)
  expect(fontSizeOf(metrics, '.commit-msg')).toBeGreaterThanOrEqual(13)

  // 元信息行高 1.45（任务书 1.4~1.5）：计算行高 / 字号
  const meta = metrics['.commit-meta']!
  expect(parseFloat(meta.lineHeight) / meta.fontSize).toBeGreaterThanOrEqual(1.4)
  // + 钮点击区不再 10px 高
  const addBtnBox = await page.locator('.git-sidebar .section-add-btn').first().boundingBox()
  expect(addBtnBox?.height ?? 0).toBeGreaterThanOrEqual(18)
  // 字号上调不得撑破 40px 提交行槽（拓扑图对齐依赖行高恒定）
  const commitContentH = await page.locator('.commit-item').first().evaluate((el) => {
    const msg = el.querySelector('.commit-msg-row')?.getBoundingClientRect().height ?? 0
    const metaEl = el.querySelector('.commit-meta')?.getBoundingClientRect().height ?? 0
    return msg + metaEl
  })
  expect(commitContentH).toBeLessThanOrEqual(38)

  await ensureFileTree(page)
  const treeMetrics = await readFontMetrics(page, ['.file-tree .item-name', '.file-tree .tree-header'])
  expect(fontSizeOf(treeMetrics, '.file-tree .item-name')).toBeGreaterThanOrEqual(12)
  expect(fontSizeOf(treeMetrics, '.file-tree .tree-header')).toBeGreaterThanOrEqual(META_FLOOR_COMFORT)

  // 设置弹窗内容：标签 12px、分区标题 ≥12px、元信息（外观分区滑条值）≥11.5px
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  const generalMetrics = await readFontMetrics(page, [
    '[data-testid="settings-pane-general"] .pane-title',
    '[data-testid="settings-pane-general"] .setting-label',
  ])
  expect(fontSizeOf(generalMetrics, '[data-testid="settings-pane-general"] .pane-title')).toBeGreaterThanOrEqual(SECTION_FLOOR)
  expect(fontSizeOf(generalMetrics, '[data-testid="settings-pane-general"] .setting-label')).toBeGreaterThanOrEqual(12)
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const appearanceMetrics = await readFontMetrics(page, ['[data-testid="settings-pane-appearance"] .slider-value'])
  expect(fontSizeOf(appearanceMetrics, '[data-testid="settings-pane-appearance"] .slider-value'))
    .toBeGreaterThanOrEqual(META_FLOOR_COMFORT)
})

test('紧凑档：--fs-meta-min 注入 10.5px 保密度，元信息不跌破下限', async ({ page }) => {
  await setDensity('compact')
  await enterProject(page)
  await openGitPanel(page)

  const tokens = await page.evaluate(() => ({
    metaMin: getComputedStyle(document.documentElement).getPropertyValue('--fs-meta-min').trim(),
    rowH: getComputedStyle(document.documentElement).getPropertyValue('--row-h').trim(),
  }))
  expect(tokens.metaMin).toBe('10.5px')
  expect(tokens.rowH).toBe('22px')

  const metrics = await readFontMetrics(page, [
    '.commit-meta',
    '.commit-refs',
    '.git-sidebar .section-header',
    '.git-sidebar .wt-path',
  ])
  const metaSize = fontSizeOf(metrics, '.commit-meta')
  expect(metaSize).toBeGreaterThanOrEqual(META_FLOOR_COMPACT)
  // 紧凑档确实比舒适档更紧（区分度断言，防 token 注入失效时两侧同值假绿）
  expect(metaSize).toBeLessThan(META_FLOOR_COMFORT)
  expect(fontSizeOf(metrics, '.commit-refs')).toBeGreaterThanOrEqual(META_FLOOR_COMPACT)
  expect(fontSizeOf(metrics, '.git-sidebar .wt-path')).toBeGreaterThanOrEqual(META_FLOOR_COMPACT)
  // 分区标题是结构层级，不随密度压缩
  expect(fontSizeOf(metrics, '.git-sidebar .section-header')).toBeGreaterThanOrEqual(SECTION_FLOOR)

  await ensureFileTree(page)
  const rowH = await page.locator('.file-tree .tree-item').first().evaluate((el) => el.getBoundingClientRect().height)
  expect(rowH).toBe(22)
})
