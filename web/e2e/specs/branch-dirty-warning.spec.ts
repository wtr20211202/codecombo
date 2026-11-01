import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 切换分支前脏工作区预警 E2E：
 * Git 侧栏右键「切换到」在 changes store 已加载数据非空时先弹确认
 * （确认 → 携带修改切换成功；取消 → 原地不动），干净工作区不弹框直接切换。
 * 夹具两分支共享 carry.txt 内容（同内容修改可被 git 干净携带），
 * 自备临时仓库，afterAll 清理（范式与 branch-checkout 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-dirty-warn')
const PROJ = 'e2e-dirty-warn'
const CARRY_FILE = 'carry.txt'
const CARRY_BASE = 'carry\n'
const FEATURE_BRANCH = 'e2e-dirty-feature'

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // master：base + carry 两文件基线；feature 分支只追加独有文件——
  // carry.txt 在两分支内容一致，未提交修改才能被 git 干净「携带」到目标分支
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), CARRY_BASE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 脏切换预警基线提交'])
  git(REPO_DIR, ['checkout', '-b', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, 'feature.txt'), 'feature 分支独有内容\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: feature 分支独有提交'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
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

/** 脏工作区预警确认弹窗（标题含「未提交修改」，内容含数量与目标分支） */
function dirtyDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '未提交修改' })
}

/**
 * CLI 侧改动工作区后让前端 changes store 感知到最新状态：
 * 服务端 git 状态缓存 3s TTL，file.changed 触发的自动重拉会命中旧缓存——
 * 等 TTL 过期后经「状态栏变更计数 → 变更面板刷新按钮」显式重拉。
 * 该计数与预检同源（changes store files 列表），先归一再断言弹窗才确定性。
 */
async function syncChangesStore(page: import('@playwright/test').Page, mutate: () => void) {
  mutate()
  await page.waitForTimeout(3500)
  await page.locator('.statusbar-changes').click()
  const refreshBtn = page.locator('.cp-tab-refresh')
  await expect(refreshBtn).toBeVisible({ timeout: 8000 })
  await refreshBtn.click()
}

/** 等 changes store 感知工作区文件数（状态栏未提交计数与预检同源同值） */
async function expectChangesCount(page: import('@playwright/test').Page, n: string) {
  await expect(page.locator('.statusbar-changes .changes-unstaged')).toHaveText(n, { timeout: 10000 })
}

test('脏工作区切分支：确认框出现 → 确认后携带修改切换成功', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 改文件不提交：两分支同内容文件上做工作区修改（可被携带，不构成冲突）
  await syncChangesStore(page, () => fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), 'carry\ndirty edit\n'))
  await expectChangesCount(page, '1')

  // 右键目标分支 → 切换到 → 预警确认框：数量与目标分支都已插值
  const featureItem = page.locator('.branch-item', { hasText: FEATURE_BRANCH })
  await expect(featureItem).toBeVisible({ timeout: 5000 })
  await featureItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const dlg = dirtyDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await expect(dlg).toContainText('1 个未提交修改')
  await expect(dlg).toContainText(FEATURE_BRANCH)

  // 确认 → 走原 checkout：成功提示 + CLI 分支已切换 + 修改被携带
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要切换' }).click()
  await expect(page.locator('.n-message').filter({ hasText: `已切换到 ${FEATURE_BRANCH}` })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
  expect(fs.readFileSync(path.join(REPO_DIR, CARRY_FILE), 'utf8')).toContain('dirty edit')
})

test('脏工作区切分支：取消 → 原地不动', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 前置：上一用例停在 feature 且 carry.txt 仍脏；不在 feature 则先确认切回（同脏预检路径）
  if (git(REPO_DIR, ['branch', '--show-current']) !== FEATURE_BRANCH) {
    const featureItem = page.locator('.branch-item', { hasText: FEATURE_BRANCH })
    await featureItem.click({ button: 'right' })
    const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
    if (await menuItem.isVisible().catch(() => false)) {
      await menuItem.click()
      const dlg = dirtyDialog(page)
      if (await dlg.isVisible().catch(() => false)) {
        await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要切换' }).click()
      }
      await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
    } else {
      await page.keyboard.press('Escape')
    }
  }
  // 归一 changes store 到当前脏状态（无实际改动，仅重拉）
  await syncChangesStore(page, () => {})
  await expectChangesCount(page, '1')

  // 右键 master → 切换到 → 取消：弹窗关闭，分支不变
  const masterItem = page.locator('.branch-item', { hasText: 'master' })
  await masterItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const dlg = dirtyDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dlg).toBeHidden({ timeout: 3000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 3000 }).toBe(FEATURE_BRANCH)
})

test('干净工作区切分支：不弹框直接切换（预检跳过）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 还原修改：确认框消失的前提是 changes store 空列表（等状态栏计数归零，
  // 该计数与预检同源，保证走的是「干净跳过」而非「弹窗恰好没渲染」）
  await syncChangesStore(page, () => {
    execFileSync('git', ['checkout', '--', CARRY_FILE], { cwd: REPO_DIR })
    fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), CARRY_BASE) // 同内容重写：补一个文件事件，内容与索引一致仍为净
  })
  await expectChangesCount(page, '0')

  // 右键 master → 切换到 → 无确认框，直接成功（成功消息出现即证明未被弹窗拦截）
  const masterItem = page.locator('.branch-item', { hasText: 'master' })
  await masterItem.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  await expect(page.locator('.n-message').filter({ hasText: '已切换到 master' })).toBeVisible({ timeout: 5000 })
  await expect(dirtyDialog(page)).toHaveCount(0)
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe('master')
})
