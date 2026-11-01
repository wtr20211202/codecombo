import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 仓库管理弹窗 → Git 钩子流程 E2E（GitManageModal 此前零覆盖）：
 * 打开弹窗 → 切 Git 钩子页签 → 钩子清单可见 → 选中 pre-commit → 编辑内容 →
 * 保存 → toast + CLI 断言 .git/hooks/pre-commit 落盘含标记内容。
 * 自备临时仓库，afterAll 清理（范式与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-hooks')
const PROJ = 'e2e-git-hooks'
const HOOK_MARKER = 'e2e-hook-marker'

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
  fs.mkdirSync(path.join(REPO_DIR), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'git hooks e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: hooks 基线提交'])
  await registerProject(headers, PROJ, REPO_DIR)
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

test('仓库管理 → Git 钩子：清单可见 → 编辑 pre-commit → 保存落盘', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 展开底部面板 Git 页签并打开仓库管理弹窗
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('button[title="仓库管理"]').first().click()
  const modal = page.locator('.n-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })

  // 切 Git 钩子页签 → 标准钩子清单渲染
  await modal.locator('.n-tabs-tab').filter({ hasText: 'Git 钩子' }).click()
  const preCommitRow = modal.getByText('pre-commit', { exact: true }).first()
  await expect(preCommitRow).toBeVisible({ timeout: 5000 })

  // 选中 pre-commit → 编辑内容 → 保存
  await preCommitRow.click()
  const hookTextarea = modal.locator('textarea')
  await expect(hookTextarea).toBeVisible({ timeout: 5000 })
  await hookTextarea.fill(`#!/bin/sh\necho "${HOOK_MARKER}"\n`)
  await modal.getByRole('button', { name: '保存' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Hook 已保存' })).toBeVisible({ timeout: 5000 })

  // CLI：钩子文件落盘且包含标记内容
  const hookFile = path.join(REPO_DIR, '.git', 'hooks', 'pre-commit')
  expect(fs.existsSync(hookFile), 'pre-commit 钩子文件应已写入').toBe(true)
  expect(fs.readFileSync(hookFile, 'utf8')).toContain(HOOK_MARKER)
})

test('仓库管理其余页签：子模块空态 / GPG 状态 / LFS 状态渲染', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('button[title="仓库管理"]').first().click()
  const modal = page.locator('.n-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })

  // 子模块：无子模块仓库 → 空态
  await modal.locator('.n-tabs-tab').filter({ hasText: '子模块' }).click()
  await expect(modal.getByText('暂无 Submodule')).toBeVisible({ timeout: 5000 })

  // GPG：签名开关状态渲染（新仓库默认禁用，二选一文案必现其一）
  await modal.locator('.n-tabs-tab').filter({ hasText: 'GPG 签名' }).click()
  await expect(modal.getByText(/已启用|已禁用/).first()).toBeVisible({ timeout: 5000 })

  // LFS：状态行渲染（本机未装 LFS 时为「未安装」+ 安装按钮，装了则为「已安装」）
  await modal.locator('.n-tabs-tab').filter({ hasText: 'LFS' }).click()
  await expect(modal.getByText('LFS 状态:')).toBeVisible({ timeout: 5000 })
  await expect(modal.getByText(/已安装|未安装/).first()).toBeVisible({ timeout: 5000 })
})

test('GPG 签名开关：切换 → 仓库配置翻转 → 再切回还原', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('button[title="仓库管理"]').first().click()
  const modal = page.locator('.n-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })

  await modal.locator('.n-tabs-tab').filter({ hasText: 'GPG 签名' }).click()
  await expect(modal.getByText(/已启用|已禁用/).first()).toBeVisible({ timeout: 5000 })

  // 读取基线（git config commit.gpgsign，未设置时为空）
  const baseline = (() => {
    try { return git(REPO_DIR, ['config', '--local', 'commit.gpgsign']) } catch { return '' }
  })()

  const checkbox = modal.locator('.n-checkbox').first()
  await checkbox.click()
  await expect(page.locator('.n-message').last()).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(500)

  const flipped = (() => {
    try { return git(REPO_DIR, ['config', '--local', 'commit.gpgsign']) } catch { return '' }
  })()
  expect(flipped, '开关点击后本地配置应翻转').not.toBe(baseline)

  // 还原基线：toggle 写显式 bool（unset 基线翻转后会残留 'false'），
  // 清理回测试前状态，避免污染仓库配置
  if (baseline === '') {
    try { git(REPO_DIR, ['config', '--local', '--unset', 'commit.gpgsign']) } catch { /* 已不存在 */ }
  } else {
    git(REPO_DIR, ['config', '--local', 'commit.gpgsign', baseline])
  }
  const finalConfig = (() => {
    try { return git(REPO_DIR, ['config', '--local', 'commit.gpgsign']) } catch { return '' }
  })()
  expect(finalConfig).toBe(baseline)
})
