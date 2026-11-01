import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 交互式 rebase 编辑器（P-20261003-324 提交整理）E2E：
 *   用例 1 = 提案主线：本地仓 5 提交，自 a1 起整理（重排 a3 到首位 +
 *   squash a2 并入 a1 + drop a4）→ git log 校验结果（计数/消息/文件）；
 *   用例 2 = 冲突场景：drop 前置提交致后继补丁上下文失配 → 服务端 abort
 *   回原状（历史计数不变、无 rebase 残留、工作区内容不变）。
 * 自备临时仓库，afterAll 清理（范式与 commit-actions 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-rebase-editor')
const PROJ = 'e2e-rebase-editor'

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function commitFile(name: string, content: string, message: string) {
  fs.writeFileSync(path.join(REPO_DIR, name), content)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', message])
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
  commitFile('root.txt', 'base\n', 'r0: 基线提交')
  commitFile('a1.txt', 'one\n', 'a1: 甲')
  commitFile('a2.txt', 'two\n', 'a2: 乙')
  commitFile('a3.txt', 'three\n', 'a3: 丙')
  commitFile('a4.txt', 'four\n', 'a4: 丁')
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

async function enterAndOpenLog(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

/** 行内动作切换：行（消息锚定）→ 动作下拉 → 选项。
 * 只匹配当前打开的菜单：naive n-select 的菜单 DOM 首开后常驻（隐藏），
 * 逐行选择时隐藏旧菜单里的同名选项会先于打开菜单被命中（DOM 序靠前） */
async function setRowAction(page: import('@playwright/test').Page, rowMsg: string, optionText: string) {
  await page.locator(`[data-testid="rebase-row-${rowMsg}"] .n-select`).click()
  await page.locator('.n-base-select-menu:visible .n-base-select-option').filter({ hasText: optionText }).click()
}

test('整理提交历史：重排 + squash + drop → git log 校验结果', async ({ page }) => {
  await enterAndOpenLog(page)
  const before = Number(git(REPO_DIR, ['rev-list', '--count', 'HEAD']))
  expect(before).toBe(5)

  // 区间选取：右键 a1 → 整理自此提交起（区间 = a1..HEAD，按应用序展示）
  await page.locator('.commit-item').filter({ hasText: 'a1: 甲' }).first().click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('整理自此提交起', { exact: false })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const modal = page.locator('[data-testid="rebase-editor-modal"]')
  await expect(modal).toBeVisible({ timeout: 5000 })
  const rangeHint = page.locator('[data-testid="rebase-range-hint"]')
  await expect(rangeHint).toContainText('4')

  // 编辑计划：
  //   应用序 [a1,a2,a3,a4] → 重排 a3 到首位（上移两次）→ [a3,a1,a2,a4]
  //   a2 = 并入上条（squash 进 a1），a4 = 丢弃
  // 上移 icon 按钮的微提示抽样断言（P-20261005-213：title/aria-label 落 DOM）
  const moveUpBtn = page.locator('[data-testid="rebase-row-a3: 丙"] .rebase-move-up')
  await expect(moveUpBtn).toHaveAttribute('title', '上移')
  await expect(moveUpBtn).toHaveAttribute('aria-label', '上移')
  for (let i = 0; i < 2; i++) {
    await moveUpBtn.click()
    await page.waitForTimeout(200)
  }
  await setRowAction(page, 'a2: 乙', '并入上条')
  await setRowAction(page, 'a4: 丁', '丢弃')

  // 实时预览：a1 行带并入项，a4 摘出为丢弃
  const preview = page.locator('[data-testid="rebase-preview"]')
  await expect(preview).toContainText('a1: 甲')
  await expect(preview).toContainText('并入：a2: 乙')
  await expect(preview).toContainText('丢弃：a4: 丁')

  // 执行（本地仓无远程：不触已推送确认流）
  await page.locator('[data-testid="rebase-execute"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '提交历史已整理' })).toBeVisible({ timeout: 15000 })
  await expect(modal).toBeHidden()

  // CLI 校验：5 → 3（root + a1+a2 合并 + a3）；合并消息 = a1/a2 按序空行连接
  await expect.poll(async () => git(REPO_DIR, ['rev-list', '--count', 'HEAD']), { timeout: 5000 }).toBe('3')
  const subjects = git(REPO_DIR, ['log', '--format=%s']).split('\n')
  expect(subjects[0]).toBe('a1: 甲')
  expect(subjects[1]).toBe('a3: 丙')
  const full = git(REPO_DIR, ['log', '--format=%B', '-1', 'HEAD'])
  expect(full).toContain('a1: 甲')
  expect(full).toContain('a2: 乙')
  // 被丢提交的文件消失，其余保留
  expect(fs.existsSync(path.join(REPO_DIR, 'a4.txt'))).toBe(false)
  for (const f of ['a1.txt', 'a2.txt', 'a3.txt', 'root.txt']) {
    expect(fs.existsSync(path.join(REPO_DIR, f))).toBe(true)
  }
})

test('冲突场景：服务端 abort 回原状（历史不变 + 无 rebase 残留）', async ({ page }) => {
  await enterAndOpenLog(page)

  // 自备冲突材料：c5 新增共享行，c6 基于 c5 再追加 → drop c5 后 c6 补丁上下文失配
  commitFile('c5.txt', 'line-x\n', 'c5: 冲突前置提交')
  fs.appendFileSync(path.join(REPO_DIR, 'c5.txt'), 'line-y\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c6: 冲突后继提交'])
  const before = git(REPO_DIR, ['rev-list', '--count', 'HEAD'])

  // CLI 提交不触发面板自动刷新：经提交搜索触发重查定位 c5（cherry-pick 同路径）
  const searchInput = page.locator('.commits-panel input[placeholder*="搜索提交"]')
  await searchInput.fill('c5: 冲突前置提交')
  await searchInput.press('Enter')
  const targetRow = page.locator('.commit-item').filter({ hasText: 'c5: 冲突前置提交' }).first()
  await expect(targetRow).toBeVisible({ timeout: 5000 })

  await targetRow.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('整理自此提交起', { exact: false })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const modal = page.locator('[data-testid="rebase-editor-modal"]')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await setRowAction(page, 'c5: 冲突前置提交', '丢弃')

  await page.locator('[data-testid="rebase-execute"]').click()
  // 服务端 abort 保底：本地化文案明示「已恢复原状」
  await expect(page.locator('.n-message').filter({ hasText: '已恢复原状' })).toBeVisible({ timeout: 20000 })

  // CLI：历史计数不变、无进行中 rebase、工作区内容不变
  await expect.poll(async () => git(REPO_DIR, ['rev-list', '--count', 'HEAD']), { timeout: 5000 }).toBe(before)
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'rebase-merge'))).toBe(false)
  expect(fs.existsSync(path.join(REPO_DIR, '.git', 'rebase-apply'))).toBe(false)
  expect(fs.readFileSync(path.join(REPO_DIR, 'c5.txt'), 'utf8')).toContain('line-y')
  expect(git(REPO_DIR, ['log', '--format=%s']).split('\n')[0]).toBe('c6: 冲突后继提交')
})
