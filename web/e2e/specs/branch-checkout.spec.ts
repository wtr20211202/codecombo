import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 分支右键「切换到」真实检出 E2E：
 * master 与 e2e-feature 两分支内容分叉 → UI 右键切换 → CLI 当前分支变化 +
 * 工作文件内容随分支切换 + 再切回 master 还原。核心 git 检出流此前零 UI 覆盖。
 * 自备临时仓库，afterAll 清理（范式与 stash-flow/tag-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-checkout')
const PROJ = 'e2e-checkout'
const FILE = 'feature.txt'
const FEATURE_BRANCH = 'e2e-feature'

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

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
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // master：基线；e2e-feature：多一个独有文件（切换后应出现在工作区）
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 检出基线提交'])
  git(REPO_DIR, ['checkout', '-b', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'feature 分支独有内容\n')
  // base.txt 追加分支特有行：让「打开中的编辑器随检出同步」可断言
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\nfeature edit\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: feature 分支独有提交'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  // 待删除分支（应用加载前创建，保证 UI 分支树首拉即含）
  git(REPO_DIR, ['branch', 'e2e-doomed'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
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
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 展开底部面板 Git 页签并归一化分支树可见（uiState 跨用例恢复态不定） */
async function openBranchTree(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.branch-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.branch-item').first()).toBeVisible()
}

test('分支右键切换：master → e2e-feature → 工作区内容随检出变化', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 打开 base.txt（master 版本），让「编辑器随检出同步」可观察
  const baseItem = page.locator('.file-tree .item-name', { hasText: 'base.txt' })
  for (let i = 0; i < 3; i++) {
    if (await baseItem.first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await baseItem.first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('base', { timeout: 8000 })

  // 右键 feature 分支 → 切换到
  const featureItem = page.locator('.branch-item', { hasText: FEATURE_BRANCH })
  await expect(featureItem).toBeVisible({ timeout: 5000 })
  await featureItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  await expect(page.locator('.n-message').filter({ hasText: `已切换到 ${FEATURE_BRANCH}` })).toBeVisible({ timeout: 5000 })

  // CLI：当前分支切换 + 独有文件出现在工作区
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
  expect(fs.existsSync(path.join(REPO_DIR, FILE)), '检出后 feature 独有文件应出现').toBe(true)

  // 打开中的编辑器自动重读：base.txt 出现分支特有行
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('feature edit', { timeout: 8000 })
})

test('切回 master：工作区还原', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 前置：上一用例可能停在 feature（uiState 恢复），不在 master 则先切回——
  // 但此处走 UI 验证「从 feature 切回 master」本身即是被测路径
  const masterItem = page.locator('.branch-item', { hasText: 'master' })
  await masterItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  if (await menuItem.isVisible().catch(() => false)) {
    await menuItem.click()
    await expect(page.locator('.n-message').filter({ hasText: '已切换到 master' })).toBeVisible({ timeout: 5000 })
  } else {
    // 已在 master（当前分支无「切换到」菜单项）→ 无需操作
    await page.keyboard.press('Escape')
  }

  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe('master')
  expect(fs.existsSync(path.join(REPO_DIR, FILE)), '切回 master 后 feature 独有文件应消失').toBe(false)
})

test('分支右键删除：确认弹窗 → 分支消失', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 分支已在 beforeAll 创建（与 master 同指，可直接安全删除）
  const doomedItem = page.locator('.branch-item', { hasText: 'e2e-doomed' })
  if (!(await doomedItem.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(800)
  }
  await expect(doomedItem).toBeVisible({ timeout: 5000 })

  // 右键 → 删除 → 确认弹窗 → 删除
  await doomedItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('删除', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: 'e2e-doomed' })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '删除' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '已删除' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--list', 'e2e-doomed']), { timeout: 5000 }).toBe('')
})
