import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交右键「还原提交（Revert）/ 重置到此提交（Reset）」E2E：
 *   revert HEAD：新增一条反向提交（计数 +1，文件内容还原，历史保留）
 *   reset --soft 到 root：HEAD 回根提交（计数 -1），v2 变更留在暂存区
 * 两用例共享 beforeAll 仓库但各自重建所需状态（revert 后 revert 回去？——
 * 不：revert 用例会多出反向提交，reset 用例以哈希定位根提交不受影响；
 * 反向提交本身再被 reset 掉，状态收敛）。
 * 自备临时仓库，afterAll 清理（范式与 reword-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-actions')
const PROJ = 'e2e-commit-actions'
const FILE = '.e2e-actions.tmp'

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

let rootHash = ''

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'actions v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 动作基线提交'])
  rootHash = git(REPO_DIR, ['rev-parse', 'HEAD'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'actions v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: 待还原的提交'])
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

test('还原提交（revert HEAD）：反向提交 + 内容还原 + 历史保留', async ({ page }) => {
  await enterAndOpenLog(page)
  const before = git(REPO_DIR, ['rev-list', '--count', 'HEAD'])

  await page.locator('.commit-item').first().click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('还原提交', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  await expect(page.locator('.n-message').filter({ hasText: 'Revert 成功' })).toBeVisible({ timeout: 5000 })

  // CLI：计数 +1（新增反向提交而非改写）；文件内容回 v1；根提交不受影响
  await expect.poll(async () => git(REPO_DIR, ['rev-list', '--count', 'HEAD']), { timeout: 5000 })
    .toBe(String(Number(before) + 1))
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('actions v1')
  expect(git(REPO_DIR, ['log', '--format=%s']).split('\n')[0]).toContain('Revert')
  expect(git(REPO_DIR, ['rev-parse', 'HEAD~2'])).toBe(rootHash)
})

test('重置到此提交（reset --soft 到 root）：HEAD 回根 + 变更留暂存', async ({ page }) => {
  await enterAndOpenLog(page)

  // 自备差异：在当前 HEAD 之上补一条 c2（与用例顺序/重试解耦——无论此前
  // 状态如何，soft reset 到 root 后 index 对 root 必有可见差异）
  fs.appendFileSync(path.join(REPO_DIR, FILE), 'actions v3\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: reset 目标差异提交'])

  // 定位根提交行（subject 匹配基线提交）
  const rootRow = page.locator('.commit-item').filter({ hasText: 'root: 动作基线提交' }).first()
  await rootRow.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('重置到此提交', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  // 确认按钮 = Soft（保留暂存）
  await page.locator('.n-dialog__action button').filter({ hasText: 'Soft' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '已重置' })).toBeVisible({ timeout: 5000 })

  // CLI：HEAD 回根提交（计数 1，哈希即根）；v2/v3 变更保留在暂存区
  await expect.poll(async () => git(REPO_DIR, ['rev-list', '--count', 'HEAD']), { timeout: 5000 }).toBe('1')
  expect(git(REPO_DIR, ['rev-parse', 'HEAD'])).toBe(rootHash)
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain('M')
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('actions v3')
})

test('cherry-pick：全分支搜索定位他分支提交 → 右键拣选 → 落到当前分支', async ({ page }) => {
  await enterAndOpenLog(page)

  // 自备跨分支提交：side 分支独有（主日志按当前分支拉取不可见，
  // 经 --all 的提交搜索定位——这正是该菜单的真实使用路径）
  git(REPO_DIR, ['reset', '--hard', rootHash]) // 清理上一用例遗留的暂存
  git(REPO_DIR, ['checkout', '-b', 'side'])
  fs.writeFileSync(path.join(REPO_DIR, 'picked.txt'), 'picked unique content\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'side: 跨分支拣选目标 XYZQ'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')

  // 提交搜索（--all 全分支）定位 side 提交
  // 占位符子串匹配（省略号字形差异鲁棒）：commits 工具条上的提交搜索框
  const searchInput = page.locator('.commits-panel input[placeholder*="搜索提交"]')
  await searchInput.fill('XYZQ')
  await searchInput.press('Enter')
  const targetRow = page.locator('.commit-item').filter({ hasText: 'XYZQ' }).first()
  await expect(targetRow).toBeVisible({ timeout: 5000 })

  await targetRow.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('Cherry-Pick', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  await expect(page.locator('.n-message').filter({ hasText: 'Cherry-Pick 成功' })).toBeVisible({ timeout: 5000 })

  // CLI：仍处 master；side.txt 落到当前分支；HEAD subject 带原消息
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  await expect.poll(async () => {
    const lines = git(REPO_DIR, ['log', '--format=%s']).split('\n')
    return lines.some(s => s.includes('XYZQ')) ? 'picked' : 'not-yet'
  }, { timeout: 5000 }).toBe('picked')
  expect(fs.existsSync(path.join(REPO_DIR, 'picked.txt'))).toBe(true)
})
