import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树状态过滤 chip E2E（P-20261003-136）：CommitFilterBar 状态四态 chips
 * （全部/未暂存/已暂存/冲突）按暂存状态收窄显示，与路径子串过滤 AND 叠加。
 * 核心守护：
 *   未暂存/已暂存 chip 只显对应状态行（untracked 同属未暂存侧的口径不在此
 *   展开——Modified 足以判别 staged 维度）；
 *   chip × 文本过滤 AND 组合（alpha 匹配两个文件，已暂存 chip 收窄到 1 个）；
 *   纯显示层过滤——提交按钮计数始终按全量暂存计（与文本过滤同解耦约束）；
 *   冲突 chip：无冲突文件时禁用；合并冲突仓库单列 Unmerged 文件、行内状态
 *   字母 U 高亮，与未暂存 chip 的包含关系（冲突恒 staged=false）成立。
 * 自备临时仓库（常规 + 冲突各一），afterAll 清理（与 changes-filter 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-status-chips')
const CONFLICT_DIR = path.join(os.tmpdir(), 'sc-e2e-status-chips-conflict')
const PROJ = 'e2e-status-chips'
const CONFLICT_PROJ = 'e2e-status-chips-conflict'
const F1 = 'alpha-staged.txt'
const F2 = 'beta-staged.txt'
const F3 = 'alpha-unstaged.txt'
const F4 = 'beta-unstaged.txt'
const CONFLICT_F = 'conflict.txt'
const OTHER_F = 'other.txt'

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
let conflictProjectId = ''

/** 常规仓库：4 文件全部已跟踪后改动，2 个入暂存区、2 个留在工作区 */
function buildPlainRepo(): void {
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of [F1, F2, F3, F4]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} v1\n`)
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'status chips e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 状态 chip 基线'])
  // 全部改动后只暂存一半：staged/unstaged 两侧各 2 条 Modified
  for (const f of [F1, F2, F3, F4]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} v2\n`)
  git(REPO_DIR, ['add', F1, F2])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(4)
}

/** 冲突仓库：merge 冲突出 Unmerged 条目 + 一条无关未暂存改动（由注册前造好，
 * 项目注册使服务端 status 缓存失效，进项目首拉即含冲突态） */
function buildConflictRepo(): void {
  fs.mkdirSync(CONFLICT_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: CONFLICT_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: CONFLICT_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: CONFLICT_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: CONFLICT_DIR })
  fs.writeFileSync(path.join(CONFLICT_DIR, CONFLICT_F), 'base\n')
  fs.writeFileSync(path.join(CONFLICT_DIR, OTHER_F), 'other v1\n')
  fs.writeFileSync(path.join(CONFLICT_DIR, 'README.md'), 'conflict chips e2e baseline\n')
  git(CONFLICT_DIR, ['add', '.'])
  git(CONFLICT_DIR, ['commit', '-m', 'root: 冲突 chip 基线'])
  git(CONFLICT_DIR, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(CONFLICT_DIR, CONFLICT_F), 'feature\n')
  git(CONFLICT_DIR, ['commit', '-am', 'feature side'])
  git(CONFLICT_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(CONFLICT_DIR, CONFLICT_F), 'main\n')
  git(CONFLICT_DIR, ['commit', '-am', 'main side'])
  // 无关文件先改不暂存：merge 不触及它，冲突态下仍是普通未暂存条目
  fs.writeFileSync(path.join(CONFLICT_DIR, OTHER_F), 'other v2\n')
  try {
    git(CONFLICT_DIR, ['merge', 'feature', '--no-edit'])
    throw new Error('merge 应因冲突失败')
  } catch (e) {
    // execFileSync 对 git 冲突退出码抛错即预期；真错误（如仓库没建好）由下方断言兜住
    if ((e as Error).message.includes('merge 应因冲突失败')) throw e
  }
  expect(git(CONFLICT_DIR, ['status', '--porcelain'])).toContain('UU ' + CONFLICT_F)
}

async function registerProject(name: string, dir: string, headers: Record<string, string>): Promise<string> {
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id).not.toBe('')
  return id
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ || p.name === CONFLICT_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(CONFLICT_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  buildPlainRepo()
  buildConflictRepo()
  projectId = await registerProject(PROJ, REPO_DIR, headers)
  conflictProjectId = await registerProject(CONFLICT_PROJ, CONFLICT_DIR, headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  if (conflictProjectId) await fetch(`${API_BASE}/api/projects/${conflictProjectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(CONFLICT_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
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

async function enterProject(page: import('@playwright/test').Page, proj: string, firstFile: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: proj }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: firstFile })).toBeVisible({ timeout: 10000 })
}

/** 变更列表头部的即时过滤输入框（placeholder 部分匹配，规避省略号字形差异） */
function filterInput(page: import('@playwright/test').Page) {
  return page.locator('.commit-panel input[placeholder*="过滤变更"]')
}

function statusChip(page: import('@playwright/test').Page, key: string) {
  return page.locator(`[data-testid="cp-status-filter-${key}"]`)
}

test('状态 chip 三态：未暂存/已暂存各自收窄、再点回落全部，与文本过滤 AND 组合，提交计数按全量', async ({ page }) => {
  await enterProject(page, PROJ, F1)
  const panel = page.locator('.commit-panel')

  // 基线：4 行全量、无过滤计数；无冲突文件 → 冲突 chip 禁用
  for (const f of [F1, F2, F3, F4]) await expect(panel.locator('.cp-node').filter({ hasText: f })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveCount(0)
  await expect(statusChip(page, 'conflict')).toBeDisabled()
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (2)')

  // 未暂存 chip：只显 2 条工作区改动，计数 2/4，提交计数仍按全量暂存 (2)
  await statusChip(page, 'unstaged').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F4 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toHaveCount(0)
  await expect(panel.locator('.cp-filter-count')).toHaveText('2/4')
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (2)')

  // 再点激活 chip 回落全部（与归属 chips「再点取消」同款手感）
  await statusChip(page, 'unstaged').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveCount(0)

  // 已暂存 chip：只显 2 条暂存改动
  await statusChip(page, 'staged').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: F4 })).toHaveCount(0)
  await expect(panel.locator('.cp-filter-count')).toHaveText('2/4')

  // AND 组合：文本 'alpha' 命中 F1/F3 两个，已暂存 chip 收窄到 F1 一个
  await filterInput(page).fill('alpha')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toHaveCount(0)
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/4')

  // 清文本恢复已暂存侧全量；全部 chip 复位（计数消失）
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(statusChip(page, 'all')).toBeEnabled()
  await statusChip(page, 'all').click()
  for (const f of [F1, F2, F3, F4]) await expect(panel.locator('.cp-node').filter({ hasText: f })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveCount(0)
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (2)')
})

test('冲突 chip：单列 Unmerged 文件（状态字母 U）、与未暂存 chip 包含关系成立、AND 过滤可再收窄', async ({ page }) => {
  await enterProject(page, CONFLICT_PROJ, CONFLICT_F)
  const panel = page.locator('.commit-panel')

  // 基线：冲突文件 + 无关未暂存文件两行；冲突态下冲突 chip 可用
  await expect(panel.locator('.cp-node').filter({ hasText: OTHER_F })).toBeVisible()
  await expect(statusChip(page, 'conflict')).toBeEnabled()

  // 冲突 chip：只显 Unmerged 行，行内状态字母 U（STATUS_LABEL_MAP 本次补的映射）
  await statusChip(page, 'conflict').click()
  await expect(panel.locator('.cp-node').filter({ hasText: CONFLICT_F })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: CONFLICT_F }).locator('.cp-status')).toHaveText('U')
  await expect(panel.locator('.cp-node').filter({ hasText: OTHER_F })).toHaveCount(0)
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/2')

  // AND：冲突 chip 下文本过滤到无关文件 → 无命中提示
  await filterInput(page).fill('other')
  await expect(panel.locator('.cp-no-match')).toBeVisible()
  await expect(panel.locator('.cp-node')).toHaveCount(0)
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: CONFLICT_F })).toBeVisible()

  // 冲突 ⊆ 未暂存（服务端 Unmerged 恒 staged=false）：切未暂存 chip 两行都在
  await statusChip(page, 'unstaged').click()
  await expect(panel.locator('.cp-node').filter({ hasText: CONFLICT_F })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: OTHER_F })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveText('2/2')
})
