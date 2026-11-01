import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 合并预演（P-20261005-174）：分支右键「合并预演…」→ merge-tree 只读弹层——
 *   冲突分支：红清单（文件+状态+冲突段展开）+ 干净并入计数，工作区零副作用；
 *   干净分支：绿态「可干净合并」→「直接去合并」走既有确认合并链真合并。
 * 自备临时仓库（conflict / clean 双分支），afterAll 清理（含 uiState 归零）。
 * 能力位感知：服务端 git < 2.38（merge-tree 现代模式缺失）时入口隐藏，用例如实跳过
 *（stash-flow stagedSupported 同款）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-merge-preview')
const PROJ = 'e2e-merge-preview'
const SHARED_FILE = 'shared.txt'
const CONFLICT_BRANCH = 'e2e-conflict'
const CLEAN_BRANCH = 'e2e-clean'

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
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'master'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, SHARED_FILE), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 预演基线'])

  // 冲突分支：同改 shared.txt 同一行（真合并必冲突）
  git(REPO_DIR, ['checkout', '-b', CONFLICT_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, SHARED_FILE), 'conflict side\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'conflict: 同行改写'])

  // 干净分支：从 master 另起，只新增独立文件（可干净合并）
  git(REPO_DIR, ['checkout', 'master'])
  git(REPO_DIR, ['checkout', '-b', CLEAN_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, 'clean-added.txt'), 'clean work\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'clean: 独有新增'])

  // master 前进：与 conflict 分支形成同文件分叉
  git(REPO_DIR, ['checkout', 'master'])
  fs.writeFileSync(path.join(REPO_DIR, SHARED_FILE), 'master side\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'master: 同行改写'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') }),
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')

  // 能力位感知：服务端 git < 2.38 时 merge-previewSupported=false，入口隐藏
  const branches = await (await fetch(`${API_BASE}/api/projects/${projectId}/branches`, { headers })).json() as { mergePreviewSupported?: boolean }
  test.skip(branches.mergePreviewSupported !== true, '服务端 git 不支持 merge-tree 现代模式（< 2.38），入口按降级语义隐藏')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function openBranchTree(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.branch-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.branch-item').first()).toBeVisible()
}

async function openPreviewModal(page: import('@playwright/test').Page, branch: string) {
  const item = page.locator('.branch-item', { hasText: branch })
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('合并预演', { exact: false }).click()
  await expect(page.getByTestId('merge-preview-modal')).toBeVisible({ timeout: 5000 })
}

test('冲突分支预演：红清单文件正确 + 冲突段可展开 + 工作区零副作用', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  await openPreviewModal(page, CONFLICT_BRANCH)

  // 红态横幅 + 冲突文件清单（shared.txt 双方同改）
  await expect(page.getByTestId('merge-preview-conflict-banner')).toContainText('1 个文件冲突')
  const conflictItem = page.getByTestId('merge-preview-conflict').filter({ hasText: SHARED_FILE })
  await expect(conflictItem).toBeVisible()
  await expect(conflictItem).toContainText('双方修改')

  // 点击展开冲突段摘要：ours/theirs 两段预览
  await conflictItem.click()
  await expect(conflictItem.getByText('当前分支（master）')).toBeVisible()
  await expect(conflictItem.getByText('来源分支')).toBeVisible()
  await expect(conflictItem.locator('pre').filter({ hasText: 'master side' })).toBeVisible()
  await expect(conflictItem.locator('pre').filter({ hasText: 'conflict side' })).toBeVisible()

  // 预演零副作用：工作区 shared.txt 仍是 master 侧原文，无冲突标记落下
  expect(fs.readFileSync(path.join(REPO_DIR, SHARED_FILE), 'utf8')).toBe('master side\n')
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
})

test('干净分支预演：绿态可干净合并 →「直接去合并」走既有确认链真合并', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  await openPreviewModal(page, CLEAN_BRANCH)

  // 绿态横幅：可干净合并 + 合成 stat（1 文件 +1）
  await expect(page.getByTestId('merge-preview-clean-banner')).toContainText('可干净合并')
  await expect(page.getByTestId('merge-preview-clean-banner')).toContainText('1 个文件的变更')

  // 「直接去合并」→ 既有防误合确认弹层重申方向（P-20261003-222 护栏不因入口放水）
  await page.getByTestId('merge-preview-go').click()
  await expect(page.getByTestId('merge-preview-modal')).toBeHidden()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '确认合并' })
  await expect(confirmDlg).toBeVisible({ timeout: 5000 })
  await expect(confirmDlg.getByText(`将 ${CLEAN_BRANCH} 合入 master`)).toBeVisible()
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '合入' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '合并' })).toBeVisible({ timeout: 8000 })

  // CLI：master 已并入 clean 分支独有文件
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  expect(fs.existsSync(path.join(REPO_DIR, 'clean-added.txt'))).toBe(true)
  expect(git(REPO_DIR, ['log', '--format=%s']).split('\n')).toContain('clean: 独有新增')
})
