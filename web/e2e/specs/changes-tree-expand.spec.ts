import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树批量展开/收起 E2E（P-20261003-169）：树头两钮（cp-expand-all /
 * cp-collapse-all）对 collapsedDirs 批量操作，几十组目录逐组点击的一键化。
 * 核心守护：
 *   收起全部 → 只剩顶层目录行（深层目录同进折叠集）+ 根级文件；
 *   展开全部 → 全部目录行与文件行回归；
 *   过滤命中自动展开优先（正交）：先期收起的目录不藏过滤命中；过滤态下点
 *   收起全部，显示仍由自动展开裁定，清过滤后折叠态原样生效。
 * 自备临时仓库（嵌套目录夹具），afterAll 清理（与 changes-filter 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tree-expand')
const PROJ = 'e2e-tree-expand'
// 嵌套目录夹具：目录组 src（含 a/b 两层）、docs；top.txt 验证根级文件不受折叠影响
const F_ONE = 'src/a/one.txt'
const F_TWO = 'src/a/two.txt'
const F_THREE = 'src/b/three.txt'
const F_GUIDE = 'docs/guide.md'
const F_TOP = 'top.txt'
// 行定位用末段名（树行只显示末段，且与其他行名互不为子串）
const N_ONE = 'one.txt'
const N_TWO = 'two.txt'
const N_THREE = 'three.txt'
const N_GUIDE = 'guide.md'
const N_TOP = 'top.txt'

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
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'tree expand e2e baseline\n')
  for (const f of [F_ONE, F_TWO, F_THREE, F_GUIDE, F_TOP]) {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, f)), { recursive: true })
    fs.writeFileSync(path.join(REPO_DIR, f), `${f} v1\n`)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 变更树展开收起基线'])
  // 全部改动不暂存：5 条工作区 Modified（注册前造好，项目注册使服务端 status
  // 缓存失效，进项目首拉即含全量变更）
  for (const f of [F_ONE, F_TWO, F_THREE, F_GUIDE, F_TOP]) {
    fs.writeFileSync(path.join(REPO_DIR, f), `${f} v2\n`)
  }
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(5)

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
  await expect(page.locator('.cp-node').filter({ hasText: N_TOP })).toBeVisible({ timeout: 10000 })
}

/** 变更列表头部的即时过滤输入框（placeholder 部分匹配，规避省略号字形差异） */
function filterInput(page: import('@playwright/test').Page) {
  return page.locator('.commit-panel input[placeholder*="过滤变更"]')
}

async function expectAllFilesVisible(panel: ReturnType<import('@playwright/test').Page['locator']>) {
  for (const n of [N_ONE, N_TWO, N_THREE, N_GUIDE, N_TOP]) {
    await expect(panel.locator('.cp-node').filter({ hasText: n })).toBeVisible()
  }
}

test('收起全部→只剩顶层目录与根级文件；展开全部→目录行与文件行全量回归', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 基线：树头两钮在位（tooltip 走 i18n，zh 固定语下断中文文案），全量 9 行
  //（4 目录 + 5 文件）
  const expandAll = panel.locator('[data-testid="cp-expand-all"]')
  const collapseAll = panel.locator('[data-testid="cp-collapse-all"]')
  await expect(expandAll).toHaveAttribute('title', '展开全部目录分组')
  await expect(collapseAll).toHaveAttribute('title', '收起全部目录分组')
  await expectAllFilesVisible(panel)
  await expect(panel.locator('.cp-node')).toHaveCount(9)

  // 收起全部：只剩 2 个顶层目录行 + 根级文件 top.txt；深层目录组的文件全藏
  await collapseAll.click()
  await expect(panel.locator('.cp-node').filter({ hasText: 'src' })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: 'docs' })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: N_TOP })).toBeVisible()
  for (const n of [N_ONE, N_TWO, N_THREE, N_GUIDE]) {
    await expect(panel.locator('.cp-node').filter({ hasText: n })).toHaveCount(0)
  }
  await expect(panel.locator('.cp-node')).toHaveCount(3)

  // 展开全部：4 目录 + 5 文件全量回归
  await expandAll.click()
  await expectAllFilesVisible(panel)
  await expect(panel.locator('.cp-node')).toHaveCount(9)
})

test('过滤命中自动展开优先：收起的目录不藏命中，清过滤折叠态原样生效；过滤态收起全部在清过滤后兑现', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 单组收起：点 src 目录行（组行点击=toggle 既有语义），组内三文件藏、其余不动
  await panel.locator('.cp-node').filter({ hasText: 'src' }).click()
  for (const n of [N_ONE, N_TWO, N_THREE]) {
    await expect(panel.locator('.cp-node').filter({ hasText: n })).toHaveCount(0)
  }
  await expect(panel.locator('.cp-node').filter({ hasText: N_GUIDE })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: N_TOP })).toBeVisible()

  // 过滤命中自动展开优先：src 仍处收起态，过滤 'one' 的命中行照常可见
  //（否则先期收起的目录会把命中整组藏掉）
  await filterInput(page).fill('one')
  await expect(panel.locator('.cp-node').filter({ hasText: N_ONE })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/5')

  // 正交：清过滤后 src 的收起态原样生效（两钮/组行操作的是折叠集本身）
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: N_ONE })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: N_GUIDE })).toBeVisible()

  // 过滤态下点收起全部：显示仍由命中自动展开裁定（命中行不消失）；清过滤后
  // 折叠兑现——只剩顶层目录行 + 根级文件
  await filterInput(page).fill('guide')
  await expect(panel.locator('.cp-node').filter({ hasText: N_GUIDE })).toBeVisible()
  await panel.locator('[data-testid="cp-collapse-all"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: N_GUIDE })).toBeVisible()
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: 'src' })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: 'docs' })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: N_TOP })).toBeVisible()
  for (const n of [N_ONE, N_TWO, N_THREE, N_GUIDE]) {
    await expect(panel.locator('.cp-node').filter({ hasText: n })).toHaveCount(0)
  }

  // 收尾复位：展开全部回基线（不影响 uiState，面板折叠态本就不持久化）
  await panel.locator('[data-testid="cp-expand-all"]').click()
  await expectAllFilesVisible(panel)
})
