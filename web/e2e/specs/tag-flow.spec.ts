import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Git 提交历史「创建标签」E2E（核心 git 操作此前零 UI 覆盖）：
 * 提交右键 → 创建标签 → prompt 输入 → toast + CLI `git tag -l` 出现 + UI 标签
 * 区计数从 0 → 1。自备临时仓库，afterAll 清理（范式与 commit-amend/stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tag')
const PROJ = 'e2e-tag'
const FILE = '.e2e-tag.tmp'
const TAG_NAME = 'e2e-v1'

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'tag e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tag 基线提交'])
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

test('提交右键创建标签：prompt 输入 → CLI 出现 + UI 标签区计数 1', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 展开底部面板 Git 页签（uiState 跨用例恢复态不定 → 归一化）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  const row = page.locator('.commit-item').first()
  await expect(row).toBeVisible({ timeout: 5000 })

  // 右键提交 → 上下文菜单 → 创建标签
  await row.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('创建标签', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  // prompt 输入标签名 → 确认
  const dialogInput = page.locator('.n-dialog input')
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await dialogInput.fill(TAG_NAME)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: TAG_NAME })).toBeVisible({ timeout: 5000 })

  // CLI：标签存在且指向 HEAD
  expect(git(REPO_DIR, ['tag', '-l'])).toContain(TAG_NAME)
  expect(git(REPO_DIR, ['rev-parse', `${TAG_NAME}^{commit}`])).toBe(git(REPO_DIR, ['rev-parse', 'HEAD']))

  // UI：分支树的标签区计数 0 → 1（面板顶栏「刷新」后拉取）
  await page.locator('button[title="刷新分支/标签（先拉取远程）"]').click().catch(() => {
    // 顶部按钮可能被遮挡时退回面板内刷新按钮
    return page.locator('.bottom-panel button[title*="刷新"]').first().click()
  })
  await expect(page.locator('.bottom-panel')).toContainText(TAG_NAME, { timeout: 8000 })
})

test('提交右键从此处创建分支：prompt 输入 → CLI 分支存在且指向 HEAD', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  const row = page.locator('.commit-item').first()
  await expect(row).toBeVisible({ timeout: 5000 })

  await row.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('从此处创建分支', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const dialogInput = page.locator('.n-dialog input')
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await dialogInput.fill('e2e-branch')
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'e2e-branch' })).toBeVisible({ timeout: 5000 })

  // CLI：分支存在、指向 HEAD，且当前分支未被切换（创建 ≠ 检出）
  expect(git(REPO_DIR, ['branch', '--list', 'e2e-branch'])).toContain('e2e-branch')
  expect(git(REPO_DIR, ['rev-parse', 'e2e-branch'])).toBe(git(REPO_DIR, ['rev-parse', 'HEAD']))
  expect(git(REPO_DIR, ['branch', '--show-current']), '当前分支应保持不变').not.toBe('e2e-branch')
})
