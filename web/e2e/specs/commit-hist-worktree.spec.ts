import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交右键「历史检视 worktree」E2E（P-20261005-179）：排查回归要在「提交 X
 * 的代码态」跑一下的零风险第三条路——worktree add <path> <hash> 定点检出
 * （HEAD 分离、不建分支、主检出零扰动）：
 *   A. 右键旧提交 → 创建 → toast 带「在新终端打开」→ 点击预填目录开对话框；
 *      worktree 管理区出现条目并带「历史检视」徽标；检视目录文件 = 历史态内容
 *   B. 残留复用（再点同提交不重建）→ 管理区右键删除 → 条目与目录都消失
 * 自备临时仓库，afterAll 清理（worktree remove + 项目删除 + uiState 归零，
 * 范式与 worktree-flow/reword-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-histwt')
const PROJ = 'e2e-histwt'
const FILE = '.e2e-histwt.tmp'
const ROOT_MSG = 'root: 历史检视基线'
const C1_MSG = 'c1: 历史态目标提交'

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

/** 检视工作区惯例落点 = 仓库兄弟目录 wt-hist-<8 位短 hash>（前端同名 util 口径） */
function expectedWtDir(firstHash: string): string {
  return path.join(path.dirname(REPO_DIR), 'wt-hist-' + firstHash.slice(0, 8))
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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

let firstHash = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'hist e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', ROOT_MSG])
  fs.appendFileSync(path.join(REPO_DIR, FILE), 'hist e2e v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', C1_MSG])
  firstHash = git(REPO_DIR, ['rev-parse', 'HEAD~1'])
  // 上轮残留的检视工作区：新仓库不认识它（纯目录形态），直接摘除
  try { fs.rmSync(expectedWtDir(firstHash), { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  // 兜底清理检视工作区（正常由用例 B 的 UI 删除链摘除）
  try { execFileSync('git', ['worktree', 'remove', '--force', '--force', expectedWtDir(firstHash)], { cwd: REPO_DIR }) } catch { /* 已删忽略 */ }
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目并展开 Git 页签提交列表（uiState 跨用例恢复态不定 → 归一化） */
async function openCommits(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item')).toHaveCount(2, { timeout: 8000 })
}

test('A. 右键旧提交创建历史检视 worktree：toast 打开动作 + 管理区徽标 + 目录为历史态', async ({ page }) => {
  await openCommits(page)

  // 日志倒序：首行 = HEAD（c1），第二行 = root——检视目标取最旧的 root
  const rootRow = page.locator('.commit-item').nth(1)
  await rootRow.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('在此提交检视', { exact: false })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  // 成功 toast 带动作副钮；点击「在新终端打开」→ 会话对话框目录预填检视路径
  const toast = page.locator('.n-message').filter({ hasText: '历史检视 worktree 已创建' })
  await expect(toast).toBeVisible({ timeout: 8000 })
  const openBtn = toast.getByText('在新终端打开')
  await expect(openBtn).toBeVisible()
  await openBtn.click()
  const dirInput = page.locator('.n-modal .n-form-item').filter({ hasText: '工作目录' }).locator('input')
  await expect(dirInput).toBeVisible({ timeout: 3000 })
  await expect(dirInput).toHaveValue(/wt-hist-[0-9a-f]{8}/)
  await page.locator('.nsd-footer button').filter({ hasText: '取消' }).click()

  // 管理区出现条目：「历史检视」徽标 + 分支列 @短hash（防误认为工作分支）
  const wtItem = page.locator('.wt-item').filter({ hasText: 'wt-hist-' })
  await expect(wtItem).toHaveCount(1, { timeout: 8000 })
  await expect(wtItem.locator('.wt-badge.hist')).toHaveText('历史检视')
  await expect(wtItem.locator('.wt-branch')).toHaveText('@' + firstHash.slice(0, 8))

  // 检视目录文件 = 目标提交的历史态内容（v1，非 HEAD 的 v2）
  const wtDir = expectedWtDir(firstHash)
  expect(fs.readFileSync(path.join(wtDir, FILE), 'utf8'), '检视工作区应为历史态内容').toBe('hist e2e v1\n')
  // 主检出零扰动：分支不变（未落入检视形态）、两个提交都在、工作区文件为 v2
  expect(git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])).not.toContain('wt-hist')
  expect(git(REPO_DIR, ['rev-list', '--count', 'HEAD'])).toBe('2')
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toBe('hist e2e v1\nhist e2e v2\n')
})

test('B. 残留复用 + 管理区清理：再点同提交不重建，删除后条目与目录消失', async ({ page }) => {
  await openCommits(page)

  // 前置自愈：用例 A 未留下检视 worktree（独立重跑形态）时先建一次
  let wtItem = page.locator('.wt-item').filter({ hasText: 'wt-hist-' })
  if ((await wtItem.count()) === 0) {
    await page.locator('.commit-item').nth(1).click({ button: 'right' })
    await page.locator('.n-dropdown-menu').getByText('在此提交检视', { exact: false }).click()
    await expect(page.locator('.n-message').filter({ hasText: '历史检视 worktree 已创建' })).toBeVisible({ timeout: 8000 })
    await expect(page.locator('.wt-item').filter({ hasText: 'wt-hist-' })).toHaveCount(1, { timeout: 8000 })
  }

  // 残留复用：同提交再点一次 → 提示直接复用而非报错/重建
  await page.locator('.commit-item').nth(1).click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在此提交检视', { exact: false }).click()
  await expect(page.locator('.n-message').filter({ hasText: '直接复用' })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.wt-item').filter({ hasText: 'wt-hist-' })).toHaveCount(1)

  // 管理区右键删除（用完即删既有链）→ 条目消失 + 目录被 git 摘除
  wtItem = page.locator('.wt-item').filter({ hasText: 'wt-hist-' })
  await wtItem.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).click()
  const confirmDialog = page.locator('.n-dialog')
  await expect(confirmDialog).toBeVisible({ timeout: 3000 })
  await confirmDialog.locator('button').filter({ hasText: '删除' }).click()
  await expect(page.locator('.wt-item').filter({ hasText: 'wt-hist-' })).toHaveCount(0, { timeout: 8000 })
  expect(fs.existsSync(expectedWtDir(firstHash)), '删除后检视目录应被移除').toBe(false)
})
