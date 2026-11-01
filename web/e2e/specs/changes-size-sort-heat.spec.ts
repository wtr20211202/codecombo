import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树「按改动量排序 + 行数热力」E2E（P-20261003-239）：树头排序模式钮
 * （默认路径序可切，改动行数降序=审阅焦点）+ 行首梯度热力条（峰值归一五档，
 * numstat 数据面 P-219 同源）。核心守护：
 *   1. 默认路径序；切排序 → 重目录（子树合计）与文件（自身行数）改动多的在
 *      前，热力档位随行数梯度递增（4/2/1 互异），tooltip 带精确行数；切回路径序；
 *   2. 与状态过滤正交：已暂存 chip 收窄视图后，留下文件的热力档不重标定
 *      （峰值按全量变更集算），排序在过滤视图内仍生效。
 * 夹具三目录各一文件，改动量 200/80/1 行（mid 已暂存——numstat HEAD 口径含
 * 已暂存侧），峰值归一档位恰为 4/2/1。自备临时仓库，afterAll 清理
 *（与 changes-copy-summary 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-size-sort-heat')
const PROJ = 'e2e-size-sort-heat'
const BRANCH = 'e2e-ss-main'
const F_BIG = 'zoo/big.txt' // +200（未暂存）→ 热力 4 档，所在目录子树合计最重
const F_MID = 'mid/mid.txt' // +80（已暂存，numstat HEAD 口径覆盖）→ 热力 2 档
const F_SMALL = 'alpha/small.txt' // +1（未暂存）→ 热力 1 档
// 树行只显基名（.cp-name = 目录段名/文件名）——定位与行序断言用基名
const BIG_NAME = 'big.txt'
const MID_NAME = 'mid.txt'
const SMALL_NAME = 'small.txt'

/** 路径序：alpha < mid < zoo（目录分组名序，组内文件随组） */
const PATH_ORDER = ['alpha', SMALL_NAME, 'mid', MID_NAME, 'zoo', BIG_NAME]
/** 量序：zoo(200) > mid(80) > alpha(1)，目录按子树合计、组内文件降序 */
const SIZE_ORDER = ['zoo', BIG_NAME, 'mid', MID_NAME, 'alpha', SMALL_NAME]

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', BRANCH], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，行数三平台一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, rel)), { recursive: true })
    fs.writeFileSync(path.join(REPO_DIR, rel), content)
  }
  write(F_BIG, 'big v1\n')
  write(F_MID, 'mid v1\n')
  write(F_SMALL, 'small v1\n')
  write('README.md', 'size sort heat e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 改动量排序基线'])
  // 三档改动量（注册项目前造好：注册使 status 缓存失效，首拉即含全量）；
  // mid 暂存——验证 numstat HEAD 口径下已暂存文件同样有行数与热力
  const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `${tag} line ${i + 1}`).join('\n') + '\n'
  write(F_BIG, 'big v1\n' + lines(200, 'big'))
  write(F_MID, 'mid v1\n' + lines(80, 'mid'))
  write(F_SMALL, 'small v1\nsmall change\n')
  git(REPO_DIR, ['add', F_MID])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(3)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: BIG_NAME })).toBeVisible({ timeout: 10000 })
}

/** 树内可见行序（目录组名 + 文件名的扁平序列） */
function nameOrder(page: import('@playwright/test').Page) {
  return page.locator('.commit-panel .cp-name').allTextContents()
}

/** 文件行的热力档位（data-level；numstat 去抖取数到位前元素不存在） */
function heatLevelOf(page: import('@playwright/test').Page, name: string) {
  return page.locator('.cp-node').filter({ hasText: name }).locator('.cp-heat').getAttribute('data-level')
}

test('排序切换：路径序 → 改动量序（大改动在前 + 热力梯度 4/2/1 + tooltip 行数）→ 切回路径序', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  const sortBtn = page.locator('[data-testid="cp-sort-by-size"]')

  // 基线：默认路径序；热力数据面为去抖按需取数，等梯度条就位（≤1s 去抖 + RTT）
  expect(await nameOrder(page)).toEqual(PATH_ORDER)
  await expect(panel.locator('.cp-node').filter({ hasText: BIG_NAME }).locator('.cp-heat')).toBeVisible({ timeout: 10000 })
  expect(await heatLevelOf(page, BIG_NAME)).toBe('4')
  expect(await heatLevelOf(page, MID_NAME)).toBe('2')
  expect(await heatLevelOf(page, SMALL_NAME)).toBe('1')
  // tooltip 带精确行数（梯度是概览，数字供核对）
  await expect(panel.locator('.cp-node').filter({ hasText: BIG_NAME }).locator('.cp-heat'))
    .toHaveAttribute('title', /改动 200 行/)

  // 切排序：目录按子树合计、文件按自身行数降序——大改动整体在前；钮呈激活态
  await sortBtn.click()
  await expect(sortBtn).toHaveClass(/active/)
  expect(await nameOrder(page)).toEqual(SIZE_ORDER)

  // 切回：路径序原样恢复（模式是可逆显示态）
  await sortBtn.click()
  await expect(sortBtn).not.toHaveClass(/active/)
  expect(await nameOrder(page)).toEqual(PATH_ORDER)
})

test('与状态过滤正交：已暂存 chip 收窄后热力档不重标定，排序在过滤视图内仍生效', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 等热力数据面就位（与用例一同款去抖取数）
  await expect(panel.locator('.cp-node').filter({ hasText: MID_NAME }).locator('.cp-heat')).toBeVisible({ timeout: 10000 })
  expect(await heatLevelOf(page, MID_NAME)).toBe('2')

  // 已暂存 chip：只剩 mid 分组（mid.txt 已暂存），计数 1/3
  await page.locator('[data-testid="cp-status-filter-staged"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: BIG_NAME })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: SMALL_NAME })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: MID_NAME })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/3')
  // 峰值按全量变更集（含被过滤隐藏的 big 200 行）——过滤不重标定色阶
  expect(await heatLevelOf(page, MID_NAME)).toBe('2')

  // 排序在过滤视图内仍生效（单组视图不炸、热力随行）
  await page.locator('[data-testid="cp-sort-by-size"]').click()
  await expect(page.locator('[data-testid="cp-sort-by-size"]')).toHaveClass(/active/)
  await expect(panel.locator('.cp-node').filter({ hasText: MID_NAME })).toBeVisible()
  expect(await heatLevelOf(page, MID_NAME)).toBe('2')
})
