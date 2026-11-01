import { test, expect, type Locator, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 本地分支重命名 E2E（P-20261003-221）：
 * 分支右键「重命名…」→ 输入新名 → 分支列表更新（旧名消失、新名出现）；
 * 非法名前端校验拦截（分支不变）；upstream 跟踪配置随 git branch -m 迁移
 * （`git branch -m` 语义优势：相对删除重建不丢 tracking）；远程分支右键无
 * 重命名项（远程跟踪引用不可本地改名）；当前分支重命名后 HEAD 跟随。
 * 自备临时仓库 + bare 远端，afterAll 清理（范式与 branch-cleanup 对称）。
 * 注意：远程分支行文本只显示去前缀的 displayName（如 "main"），与本地分支名
 * 可能同串——分支行定位一律用 .branch-name 精确文本/类名区分，不用裸 hasText。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-rename')
const REMOTE_DIR = path.join(os.tmpdir(), 'sc-e2e-rename-origin.git')
const PROJ = 'e2e-rename'
const PLAIN_OLD = 'feat/old-name'
const PLAIN_NEW = 'feat/new-name'
const TRACK_OLD = 'feat/tracked'
const TRACK_NEW = 'feat/tracked-kept'

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
  for (const dir of [REPO_DIR, REMOTE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '--bare', '-b', 'main', REMOTE_DIR])
  execFileSync('git', ['init', '-b', 'main', REPO_DIR])
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 基线提交'])
  // bare 远端：仅推送 main 建立远程引用（供 upstream 保留断言与远程右键负例用）
  git(REPO_DIR, ['remote', 'add', 'origin', REMOTE_DIR])
  git(REPO_DIR, ['push', '-u', 'origin', 'main'])
  // 非当前分支（无 tracking）：重命名后列表/引用面更新
  git(REPO_DIR, ['branch', PLAIN_OLD])
  // 带 tracking 的非当前分支：验证 upstream 配置随改名迁移
  git(REPO_DIR, ['branch', TRACK_OLD])
  git(REPO_DIR, ['branch', '--set-upstream-to=origin/main', TRACK_OLD])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('main')
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
  for (const dir of [REPO_DIR, REMOTE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 展开底部面板 Git 页签并归一化分支树可见（uiState 跨用例恢复态不定） */
async function openBranchTree(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.branch-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.branch-item').first()).toBeVisible()
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)
}

/** 本地分支行（.branch-name 恰为该名——远程行 displayName 可能同串，须排除） */
function localBranchRow(page: Page, name: string): Locator {
  return page.locator('.branch-item').filter({
    has: page.locator('.branch-name:not(.remote)', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }),
  })
}

/** 右键分支行并点「重命名…」菜单项，返回弹出的重命名对话框 */
async function openRenameDialog(page: Page, row: Locator) {
  await row.click({ button: 'right' })
  const item = page.locator('.n-dropdown-option', { hasText: '重命名' })
  await expect(item).toBeVisible({ timeout: 3000 })
  await item.click()
  const dlg = page.locator('.n-dialog').filter({ hasText: '重命名分支' })
  await expect(dlg).toBeVisible({ timeout: 3000 })
  return dlg
}

async function confirmRename(page: Page, dlg: Locator, newName: string) {
  const input = dlg.locator('input')
  await input.fill(newName)
  await dlg.locator('.n-dialog__action button').filter({ hasText: '重命名' }).click()
}

test('非当前分支右键重命名：分支列表更新（旧名消失、新名出现）', async ({ page }) => {
  await enterProject(page)

  const dlg = await openRenameDialog(page, localBranchRow(page, PLAIN_OLD))
  // 输入框预填旧名（defaultValue），替换为新名后确认
  await expect(dlg.locator('input')).toHaveValue(PLAIN_OLD)
  await confirmRename(page, dlg, PLAIN_NEW)

  // 成功提示 + 列表刷新：旧名行消失、新名行出现
  await expect(page.locator('.n-message').filter({ hasText: `分支 ${PLAIN_OLD} 已重命名为 ${PLAIN_NEW}` })).toBeVisible({ timeout: 5000 })
  await expect(localBranchRow(page, PLAIN_OLD)).toHaveCount(0)
  await expect(localBranchRow(page, PLAIN_NEW)).toBeVisible({ timeout: 5000 })
  // git 侧真源：旧引用已不存在、新引用就位
  await expect.poll(async () => git(REPO_DIR, ['branch', '--list', PLAIN_OLD]), { timeout: 5000 }).toBe('')
  expect(git(REPO_DIR, ['branch', '--list', PLAIN_NEW])).not.toBe('')
})

test('非法新名被前端校验拦截：分支保持不变', async ({ page }) => {
  await enterProject(page)

  const dlg = await openRenameDialog(page, localBranchRow(page, PLAIN_NEW))
  await confirmRename(page, dlg, 'bad name!')

  // 校验错误提示（弹窗不关闭），分支未被改名
  await expect(page.locator('.n-message').filter({ hasText: '非法字符' })).toBeVisible({ timeout: 3000 })
  expect(git(REPO_DIR, ['branch', '--list', PLAIN_NEW])).not.toBe('')
  // 取消退出，不留悬挂弹窗
  await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dlg).toBeHidden({ timeout: 3000 })
})

test('upstream 跟踪配置随改名保留；远程分支右键无重命名项', async ({ page }) => {
  await enterProject(page)

  // 远程分支（origin 组内 displayName "main"）右键：菜单无「重命名」
  // （远程跟踪引用不可本地改名）。先等菜单出现再断言缺失，避免「未渲染≠无此项」
  const remoteRow = page.locator('.branch-item').filter({ has: page.locator('.branch-name.remote', { hasText: /^main$/ }) })
  await remoteRow.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu').first()).toBeVisible({ timeout: 3000 })
  await expect(page.locator('.n-dropdown-option', { hasText: '重命名' })).toHaveCount(0)
  // 收起菜单：点菜单自身「复制名称」项（菜单向下展开会盖住过滤框/分支行，
  // 外部点击目标多被其遮住；点自身选项天然收起且无副作用）
  await page.locator('.n-dropdown-option', { hasText: '复制名称' }).click()
  await expect(page.locator('.n-dropdown-menu')).toHaveCount(0)

  // 带 tracking 的本地分支改名 → git branch -m 迁移 branch.<name> 配置段
  const dlg = await openRenameDialog(page, localBranchRow(page, TRACK_OLD))
  await confirmRename(page, dlg, TRACK_NEW)
  await expect(localBranchRow(page, TRACK_NEW)).toBeVisible({ timeout: 5000 })

  await expect.poll(async () => git(REPO_DIR, ['config', '--get', `branch.${TRACK_NEW}.remote`]), { timeout: 5000 }).toBe('origin')
  expect(git(REPO_DIR, ['config', '--get', `branch.${TRACK_NEW}.merge`])).toBe('refs/heads/main')
  // 分支 -vv 视图仍显示跟踪关系（upstream 未丢的直接证据）
  expect(git(REPO_DIR, ['branch', '-vv', '--list', TRACK_NEW])).toContain('[origin/main]')
})

test('当前分支重命名：HEAD 跟随，当前标记落到新名', async ({ page }) => {
  await enterProject(page)

  // 当前分支行带 .current 类（本地 main；远程行无 current，不受同串干扰）
  const dlg = await openRenameDialog(page, page.locator('.branch-item.current'))
  await confirmRename(page, dlg, 'mainline')

  // 列表刷新：当前分支（● 标记行）为新名、旧名行消失
  await expect(localBranchRow(page, 'mainline')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.branch-item.current').filter({ has: page.locator('.branch-name', { hasText: /^main$/ }) })).toHaveCount(0)
  // git 侧：HEAD 符号引用随 git branch -m 更新
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('mainline')
})
