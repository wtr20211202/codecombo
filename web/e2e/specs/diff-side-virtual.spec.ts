import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * DiffViewer 并排视图虚拟化 E2E（P-20261003-325）：5 万行级种子 diff 并排打开，
 * DOM <tr> 只有窗口量级（全量直渲染是浏览器冻结级缺陷——本断言即修复目标本体），
 * 滚动容器 scrollHeight 为全量高度（wrapper 撑占位）；深度滚动后窗口切片内容与
 * 行号对位（虚拟化不串行）；变更导航 next 在并排虚拟化下落点正确。
 * 夹具 = 200 行基线（首行改一处）+ 追加 5 万行 → c1↔c2 diff 两 hunk（顶部小改
 * + 尾部 5 万 add）。入口复用 diff-nav-hunks 的对比弹窗路径。自备临时仓库，
 * afterAll 清理。
 * 扁平序列几何不硬编码：服务端 diff 的 header 行数随 git 输出形态变化，spec 启动
 * 期拉同一 branch-file-diff 端点、按 DiffViewer 解析同款规则（header/@@/正文各占
 * 一槽、空行无槽）现算各锚点 flat 下标。
 * hunkIndex 对位口径：暂存/放弃键由 enableHunkStaging 门控且当前无生产面挂载
 * （全部消费方只传 content），stage/unstage/discard 按解析层 hunkIndex 寻址、
 * 与渲染切片无关（数据层不变）——本 spec 以 data-hunk-nav 锚点在窗口内正确
 * 对位作为该下标在虚拟化下不失真的证据。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-side-virtual')
const PROJ = 'e2e-diff-side-virtual'
const FILE = 'big.txt'

const BASE_LINES = 200
const ADDED_LINES = 50000
// 行槽 = diff 字号档（stores/font.ts FONT_DEFAULTS.diff = 13，未预置字号时 load
// 合并出的生效档）× 1.5（DiffViewer DIFF_LINE_HEIGHT 同款换算），P-20261004-104
// 起行高随字号联动——本 spec 不预置 diff 字号，按默认档推导
const DIFF_FONT_DEFAULT = 13
const ROW_H = Math.round(DIFF_FONT_DEFAULT * 1.5)

const c1Lines = Array.from({ length: BASE_LINES }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`)
const addedLines = Array.from({ length: ADDED_LINES }, (_, i) => `added-${String(i + 1).padStart(6, '0')}`)
const C1_CONTENT = c1Lines.join('\n') + '\n'
// 首行改一处（小 hunk）+ 尾部整段追加（5 万 add 大 hunk）
const C2_CONTENT = ['line-001-edited', ...c1Lines.slice(1), ...addedLines].join('\n') + '\n'

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

let projectId = ''
let c2 = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  git(REPO_DIR, ['branch', 'feature']) // feature 指回 c1：对比弹窗选它即得 c1↔c2 diff
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: one edit + 50k appended lines'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')

  // 扁平序列几何现算（服务端 diff 的 header 行数随 git 输出形态变化，不硬编码）
  geometry = await fetchGeometry(headers)
  // 夹具形态守卫：两块（顶部小改 + 尾部 5 万 add）且追加行槽全部解析在位
  expect(geometry.navHunks).toEqual([1, 2])
  expect(geometry.addedFlat.size).toBe(ADDED_LINES)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

// ── 扁平序列几何（与 DiffViewer 解析同口径现算）──
// header（---/+++/diff/index/Binary 前缀）与 @@ 行、正文行各占一槽，空行无槽；
// header 先于首个 @@ 时归文件头伪块（hunk 0），每个 @@ 开新块
interface DiffGeometry {
  total: number
  headFlat: Map<number, number> // hunkIndex → 该块 @@ 行 flat 下标
  navHunks: number[] // 带 +/- 的 hunkIndex（导航序列，同组件 navHunks 口径）
  addedFlat: Map<number, number> // 追加行序 k → flat 下标
}

async function fetchGeometry(headers: Record<string, string>): Promise<DiffGeometry> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/branch-file-diff?from=feature&to=HEAD&file=${encodeURIComponent(FILE)}`, { headers })
  expect(res.ok).toBeTruthy()
  const text = (((await res.json()) as { data?: string }).data) || ''
  expect(text.length).toBeGreaterThan(ADDED_LINES * 10) // 5 万行补丁确实在位

  const geo: DiffGeometry = { total: 0, headFlat: new Map(), navHunks: [], addedFlat: new Map() }
  const hasChange: boolean[] = []
  let cur = -1 // 当前 hunkIndex；-1 = 尚无块
  let flat = 0
  for (const raw of text.split('\n')) {
    const slot = flat
    if (/^(--- |\+\+\+ |diff |index |Binary files)/.test(raw)) {
      if (hasChange.length === 0) { hasChange.push(false); cur = 0 } // 文件头伪块
    } else if (/^@@ /.test(raw)) {
      hasChange.push(false)
      cur = hasChange.length - 1
      geo.headFlat.set(cur, slot)
    } else if (raw !== '') {
      if ((raw.startsWith('+') || raw.startsWith('-')) && cur >= 0) hasChange[cur] = true
      const m = raw.match(/^\+added-(\d{6})$/)
      if (m) geo.addedFlat.set(parseInt(m[1]!, 10), slot)
    }
    if (raw !== '') flat++
  }
  geo.total = flat
  geo.navHunks = hasChange.reduce<number[]>((acc, ch, i) => (ch ? [...acc, i] : acc), [])
  return geo
}

let geometry: DiffGeometry

// 进项目并展开底部 Git 面板提交列表（rail 是 toggle，按提交可见性收敛）
async function enterAndOpenLog(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

/** 打开对比弹窗（内嵌 DiffViewer）并切到并排模式：c2 文件节点 → 在编辑器中打开
 *  → 对比 → 选 feature */
async function openCompareModalSideMode(page: import('@playwright/test').Page) {
  await enterAndOpenLog(page)
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.ega-btn').filter({ hasText: '对比' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `对比：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('.n-base-selection').first().click()
  const featureOption = page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: 'feature' })
  await expect(featureOption).toBeVisible({ timeout: 10000 })
  await featureOption.click()
  await expect(modal.locator('.crm-diff')).toBeVisible({ timeout: 10000 })
  await modal.getByRole('button', { name: '并排', exact: true }).click()
  await expect(modal.locator('.crm-diff table')).toBeVisible({ timeout: 10000 })
  return modal
}

/** 并排滚动面几何：DOM 行数 + 容器占位/视口/滚动位（经 table 祖先定位，
 * 不依赖 inline style 选择器） */
function sideGeometry(modal: import('@playwright/test').Locator) {
  return modal.locator('.crm-diff table').evaluate((el) => {
    const container = el.parentElement!.parentElement! as HTMLElement
    return {
      rows: el.querySelectorAll('tr').length,
      scrollHeight: container.scrollHeight,
      clientHeight: container.clientHeight,
      scrollTop: container.scrollTop,
    }
  })
}

/** 把并排滚动容器滚到指定 scrollTop（置位即触发 onScroll 重算窗口切片）。
 *  窗口切片重渲会平移 wrapper marginTop（offsetTop 跳变），浏览器滚动锚定
 *  （overflow-anchor）此时会微调实际 scrollTop——与 P-182 时间线同一干扰源，
 *  按「实测位差回补」收敛：滚后量目标行顶与容器顶的偏差，非零则补偿，至贴顶 */
async function scrollToRowTop(modal: import('@playwright/test').Locator, top: number, probeText: string) {
  const table = modal.locator('.crm-diff table')
  await table.evaluate((el, t) => {
    (el.parentElement!.parentElement! as HTMLElement).scrollTop = t as number
  }, top)
  for (let i = 0; i < 6; i++) {
    await expect(modal.locator('.crm-diff').getByText(probeText, { exact: true })).toBeVisible()
    const drift = await modal.locator('.crm-diff td').filter({ hasText: probeText }).last().evaluate((el) => {
      const container = el.closest('table')!.parentElement!.parentElement! as HTMLElement
      return Math.round(el.getBoundingClientRect().top - container.getBoundingClientRect().top)
    })
    if (Math.abs(drift) <= ROW_H) return
    await table.evaluate((el, d) => {
      (el.parentElement!.parentElement! as HTMLElement).scrollTop += d as number
    }, drift)
  }
  throw new Error(`scroll settle failed: ${probeText} 未在 6 轮位差回补内贴顶`)
}

test('并排大 diff 窗口化：DOM 行数窗口量级（非全量 5 万行）且滚动占位为全量高度', async ({ page }) => {
  const modal = await openCompareModalSideMode(page)

  // 首窗内容正常（文件头 + 首个小 hunk + 大 hunk 头部区间）
  await expect(modal.locator('.crm-diff').getByText('line-001-edited', { exact: true })).toBeVisible()
  await expect(modal.locator('.crm-diff').getByText('added-000001', { exact: true })).toBeVisible()

  // 核心断言：全量 flat 数万行，DOM <tr> 只有窗口量级（可见 + overscan）
  const geo = await sideGeometry(modal)
  expect(geo.rows).toBeGreaterThan(10)
  expect(geo.rows).toBeLessThan(500)
  // wrapper 撑全量高度：scrollHeight ≈ total × 行槽(20) ≈ 100 万 px（全量直渲染
  // 无占位、不足额占位则深滚不可达——两端一起钉死虚拟化形态）
  expect(geo.clientHeight).toBeGreaterThan(100)
  expect(geo.scrollHeight).toBeGreaterThan(geometry.total * ROW_H * 0.7)
})

test('并排大 diff 深度滚动定位：窗口切片内容与行号对位不串行', async ({ page }) => {
  const modal = await openCompareModalSideMode(page)

  // 滚到 added-25000 所在 flat × 行高（实测位差回补收敛，见 scrollToRowTop）
  const k = 25000
  const probe = `added-${String(k).padStart(6, '0')}`
  await scrollToRowTop(modal, geometry.addedFlat.get(k)! * ROW_H, probe)
  // 内容对位：切片里的正是目标行
  await expect(modal.locator('.crm-diff').getByText(probe, { exact: true })).toBeVisible()
  // 行号对位：右侧行号 = 基线 200 行 + k（追加行新文件序号）
  await expect(modal.locator('.crm-diff').getByText(String(BASE_LINES + k), { exact: true })).toBeVisible()

  // 落点贴顶（flat × 行高定位精度，回补后 ≤1 行），窗口行数仍为窗口量级
  const drift = await modal.locator('.crm-diff td').filter({ hasText: probe }).last().evaluate((el) => {
    const container = el.closest('table')!.parentElement!.parentElement! as HTMLElement
    return Math.abs(el.getBoundingClientRect().top - container.getBoundingClientRect().top)
  })
  expect(drift).toBeLessThanOrEqual(ROW_H)
  expect((await sideGeometry(modal)).rows).toBeLessThan(500)
})

test('并排大 diff 变更导航：next 逐块前进落点正确，hunkIndex 锚点在窗口内对位', async ({ page }) => {
  const modal = await openCompareModalSideMode(page)
  const [firstHunk, bigHunk] = geometry.navHunks

  // 首击 next 落首块（顶部小改）：锚点高亮 + 内容跟随
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator(`td[data-hunk-nav="${firstHunk}"].diff-nav-flash`)).toBeVisible()
  await expect(modal.locator('.crm-diff').getByText('line-001-edited', { exact: true })).toBeVisible()

  // 再击落大块（尾部 5 万 add）：虚拟窗口随 scrollTo 切到追加区
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator(`td[data-hunk-nav="${bigHunk}"].diff-nav-flash`)).toBeVisible()
  await expect(modal.locator('.crm-diff').getByText('added-000001', { exact: true })).toBeVisible()

  // next 尾→首回绕回首块
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator(`td[data-hunk-nav="${firstHunk}"].diff-nav-flash`)).toBeVisible()
})
