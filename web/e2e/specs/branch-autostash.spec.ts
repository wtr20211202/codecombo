import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 脏工作区切换的自动暂存恢复 E2E（P-20261003-203）：
 * 脏区预警确认框第三选「自动暂存并恢复」→ 服务端 stash → checkout → stash pop
 * 链。主链路断言「变更跟着回来 + stash 栈清空」；冲突场景断言「切换成功 +
 * stash 保留的明确提示（不丢变更）」。夹具自备临时仓库，afterAll 清理
 * （范式与 branch-dirty-warning 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-autostash')
const PROJ = 'e2e-autostash'
const CARRY_FILE = 'carry.txt'
const CONFLICT_FILE = 'conflict.txt'
const FEATURE_BRANCH = 'e2e-autostash-feature'

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
  execFileSync('git', ['init', '-b', 'master'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // master 基线：carry.txt 两分支同内容（可干净携带）；conflict.txt 在 feature
  // 分支被提交改写——master 侧对它的脏改动 pop 回 feature 必冲突
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), 'carry\n')
  fs.writeFileSync(path.join(REPO_DIR, CONFLICT_FILE), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 自动暂存切换基线提交'])
  git(REPO_DIR, ['checkout', '-b', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, CONFLICT_FILE), 'feature version\n')
  git(REPO_DIR, ['commit', '-am', 'feat: conflict.txt on feature'])
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

/** 脏工作区预警确认弹窗（标题含「未提交修改」） */
function dirtyDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '未提交修改' })
}

/**
 * CLI 侧改动工作区后让前端 changes store 感知到最新状态：
 * 服务端 git 状态缓存 3s TTL，等 TTL 过期后经变更面板刷新按钮显式重拉
 * （该计数与预检同源，先归一再断言弹窗才确定性）。
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

/** 右键分支 → 菜单「切换到」→ 三选确认框可见 */
async function openDirtyDialog(page: import('@playwright/test').Page, target: string) {
  const item = page.locator('.branch-item', { hasText: target })
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()
  const dlg = dirtyDialog(page)
  await expect(dlg).toBeVisible({ timeout: 3000 })
  return dlg
}

test('脏工作区切分支 → 自动暂存并恢复：变更跟着回来，stash 栈清空', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 两分支同内容文件上做脏修改（pop 可干净应用）
  await syncChangesStore(page, () => fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), 'carry\ndirty edit\n'))
  await expectChangesCount(page, '1')

  const dlg = await openDirtyDialog(page, FEATURE_BRANCH)
  // 三选确认框：中键 = 自动暂存并恢复
  await dlg.locator('.n-dialog__action button').filter({ hasText: '自动暂存并恢复' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '修改已自动暂存并恢复' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
  // 变更回来了：修改内容随 pop 回到目标分支，stash 栈清空
  expect(fs.readFileSync(path.join(REPO_DIR, CARRY_FILE), 'utf8')).toContain('dirty edit')
  expect(git(REPO_DIR, ['stash', 'list'])).toBe('')
})

test('自动暂存 pop 冲突：切换成功 + stash 保留提示（不丢变更）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 归一 changes store 到当前脏状态（上一用例停在 feature 且 carry.txt 脏；
  // 新页面加载后 store 可能尚未拉齐——无实际改动仅重拉，保证预检确定性）
  await syncChangesStore(page, () => {})
  await expectChangesCount(page, '1')
  // 归一回 master：carry.txt 两分支同内容可携带，走「仍要切换」
  if (git(REPO_DIR, ['branch', '--show-current']) !== 'master') {
    const dlg = await openDirtyDialog(page, 'master')
    await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要切换' }).click()
    await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe('master')
  }
  // 还原 carry.txt，改在 conflict.txt 上做脏修改（与 feature 分支提交相撞 → pop 必冲突）
  await syncChangesStore(page, () => {
    execFileSync('git', ['checkout', '--', CARRY_FILE], { cwd: REPO_DIR })
    fs.writeFileSync(path.join(REPO_DIR, CARRY_FILE), 'carry\n')
    fs.writeFileSync(path.join(REPO_DIR, CONFLICT_FILE), 'master dirty\n')
  })
  await expectChangesCount(page, '1')

  const dlg = await openDirtyDialog(page, FEATURE_BRANCH)
  await dlg.locator('.n-dialog__action button').filter({ hasText: '自动暂存并恢复' }).click()

  // 冲突非失败：切换已成功，警告明确「stash 保留、变更未丢」
  await expect(page.locator('.n-message').filter({ hasText: '安全保留在 stash 中未丢失' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe(FEATURE_BRANCH)
  // stash 条目保留且语义注记可对账：git 自带 `On master:` 前缀 + 消息里的目标分支名
  const stashList = git(REPO_DIR, ['stash', 'list'])
  expect(stashList).toContain('On master:')
  expect(stashList).toContain('auto: checkout to e2e-autostash-feature')
  // 工作区留下冲突现场，master 侧改动内容在案（未丢）
  const conflicted = fs.readFileSync(path.join(REPO_DIR, CONFLICT_FILE), 'utf8')
  expect(conflicted).toContain('<<<<<<<')
  expect(conflicted).toContain('master dirty')
})

test('切回原分支：恢复提示出现 → 通知「恢复」一键 → 变更回来且 stash 清空（P-20261006-48）', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  // 前置：清掉上一用例的冲突现场（reset --hard 只动工作区/索引，保留的 stash
  // 条目原封不动），changes store 归一到干净态——切回原分支走「无弹窗直切」
  execFileSync('git', ['reset', '--hard'], { cwd: REPO_DIR })
  await syncChangesStore(page, () => {})
  await expectChangesCount(page, '0')

  // 干净工作区右键 master →「切换到」：无确认框直达，响应携带 recoverableStash
  const item = page.locator('.branch-item', { hasText: 'master' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('切换到', { exact: true }).click()
  await expect.poll(async () => git(REPO_DIR, ['branch', '--show-current']), { timeout: 5000 }).toBe('master')

  // 切回即提示（P-203「可切回原分支恢复」的闭环最后一环）：就地点名 toast
  await expect(page.locator('.n-message').filter({ hasText: '检测到切走前暂存的 1 条变更' })).toBeVisible({ timeout: 8000 })

  // 通知中心条目行内「恢复」按钮（actionInlineLabel 注册表渲染）→ 点击走
  // pendingAction 分发回 useStashRecover 既有 pop 链
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: '检测到切走前暂存的' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  const recoverBtn = row.locator('[data-testid^="notif-action-"]')
  await expect(recoverBtn).toHaveText('恢复')
  await recoverBtn.click()

  // 恢复反馈：成功 toast + master 侧变更回到工作区（状态栏计数就地拉齐）+
  // stash 栈清空
  await expect(page.locator('.n-message').filter({ hasText: '已恢复切走前暂存的变更' })).toBeVisible({ timeout: 10000 })
  await expectChangesCount(page, '1')
  expect(fs.readFileSync(path.join(REPO_DIR, CONFLICT_FILE), 'utf8')).toBe('master dirty\n')
  expect(git(REPO_DIR, ['stash', 'list'])).toBe('')
})
