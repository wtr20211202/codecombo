import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 分支右键「合并到当前分支 / 变基当前分支到此处」E2E（此前零覆盖）：
 *   merge：master 右键 feature → 确认弹层重申「将 feature 合入 master」（P-20261003-222
 *           取消不合并）→ master 含 feature 提交
 *   rebase：master checkout -b side 落后 feature → rebase side onto feature
 *           → side 含 feature 提交且 master 未动
 *   squash（P-20261007-18）：三提交功能分支 → 确认弹层选「压平合并」→ master
 *           单新提交含自动生成的汇总消息，工作树内容与逐提交合并一致
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-merge-rebase')
const PROJ = 'e2e-merge-rebase'
const FILE = 'shared.txt'
const FEATURE_BRANCH = 'e2e-feature'

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
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 合并基线'])
  git(REPO_DIR, ['checkout', '-b', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, 'feature.txt'), 'feature work\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: feature 独有提交'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') }),
  })
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
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

test('分支右键合并：确认弹层重申方向，feature → master 内容并入', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  const featureItem = page.locator('.branch-item', { hasText: FEATURE_BRANCH })
  await expect(featureItem).toBeVisible({ timeout: 5000 })
  await featureItem.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('合并到当前分支', { exact: true }).click()

  // 防误合护栏（P-20261003-222）：确认弹层重申合入方向「将 <source> 合入 <base>」
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '确认合并' })
  await expect(confirmDlg).toBeVisible({ timeout: 5000 })
  await expect(confirmDlg.getByText('将 e2e-feature 合入 master')).toBeVisible()

  // 取消：不执行合并（feature 独有文件不落 master）
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(confirmDlg).toBeHidden()
  expect(fs.existsSync(path.join(REPO_DIR, 'feature.txt'))).toBe(false)

  // 再次发起并确认：方向无误才真正合并
  await featureItem.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('合并到当前分支', { exact: true }).click()
  const confirmDlg2 = page.locator('.n-dialog').filter({ hasText: '确认合并' })
  await expect(confirmDlg2).toBeVisible({ timeout: 5000 })
  await expect(confirmDlg2.getByText('将 e2e-feature 合入 master')).toBeVisible()
  await confirmDlg2.locator('.n-dialog__action button').filter({ hasText: '合入' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '合并' })).toBeVisible({ timeout: 8000 })

  // CLI：master 含 feature 独有文件（快进合并），仍在 master
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  expect(fs.existsSync(path.join(REPO_DIR, 'feature.txt'))).toBe(true)
  expect(git(REPO_DIR, ['log', '--format=%s']).split('\n')).toContain('feat: feature 独有提交')
})

test('分支右键变基：master 落后时 rebase master onto feature', async ({ page }) => {
  // 造落后分支：master 从当前位置再前进（新提交），checkout 落后分支 side
  // 此处语义按 UI 菜单「变基当前分支到此处」：当前分支=side，目标=feature
  git(REPO_DIR, ['checkout', '-b', 'side'])
  fs.writeFileSync(path.join(REPO_DIR, 'side.txt'), 'side work\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'side: 独有提交'])
  // feature 上再前进，使 side 需要变基才能线性包含 feature 最新
  git(REPO_DIR, ['checkout', FEATURE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, 'feature2.txt'), 'feature more\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: feature 二号提交'])
  git(REPO_DIR, ['checkout', 'side'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('side')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  const featureItem = page.locator('.branch-item', { hasText: FEATURE_BRANCH })
  await expect(featureItem).toBeVisible({ timeout: 5000 })
  await featureItem.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('变基当前分支到此处', { exact: true }).click()

  await expect(page.locator('.n-message').filter({ hasText: /变基|Rebase|rebase/ }).first()).toBeVisible({ timeout: 8000 })

  // CLI：side 变基后线性包含 feature 的两个提交；side 独有提交保留
  await expect.poll(async () => {
    const subjects = git(REPO_DIR, ['log', '--format=%s', 'side']).split('\n')
    return subjects.includes('feat: feature 二号提交') && subjects.includes('feat: feature 独有提交') && subjects.includes('side: 独有提交') ? 'ok' : 'pending'
  }, { timeout: 8000 }).toBe('ok')
})

test('分支右键压平合并：三提交功能分支压为 master 单条汇总提交', async ({ page }) => {
  // 造三提交功能分支（回 master 拉出，避免卷入 side 的变基结果），回 master 待合
  git(REPO_DIR, ['checkout', 'master'])
  git(REPO_DIR, ['checkout', '-b', 'e2e-squash'])
  fs.writeFileSync(path.join(REPO_DIR, 'sq1.txt'), 'squash one\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: squash 首条'])
  fs.writeFileSync(path.join(REPO_DIR, 'sq2.txt'), 'squash two\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'wip: squash 中途'])
  fs.writeFileSync(path.join(REPO_DIR, 'sq3.txt'), 'squash three\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'fix: squash 末条'])
  git(REPO_DIR, ['checkout', 'master'])
  expect(git(REPO_DIR, ['branch', '--show-current'])).toBe('master')
  const headBefore = git(REPO_DIR, ['rev-parse', 'HEAD'])

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)

  const squashItem = page.locator('.branch-item', { hasText: 'e2e-squash' })
  await expect(squashItem).toBeVisible({ timeout: 5000 })
  await squashItem.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('合并到当前分支', { exact: true }).click()

  // 确认弹层（P-222 方向重申不变）选「压平合并」→ 汇总消息输入出现，留空走
  // 服务端自动生成默认消息「(<source>) N commits: 首末提交标题」
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '确认合并' })
  await expect(confirmDlg).toBeVisible({ timeout: 5000 })
  await expect(confirmDlg.getByText('将 e2e-squash 合入 master')).toBeVisible()
  await confirmDlg.locator('[data-testid="merge-strategy-squash"]').click()
  await expect(confirmDlg.locator('[data-testid="merge-squash-msg"]')).toBeVisible()
  await confirmDlg.locator('[data-testid="merge-confirm"]').click()

  await expect(page.locator('.n-message').filter({ hasText: '压平' })).toBeVisible({ timeout: 8000 })

  // CLI：master 恰单新提交，消息 = 自动生成的「(源分支) N commits: 首末提交标题」，
  // 工作树内容与逐提交合并一致（三个文件全部落地）
  expect(git(REPO_DIR, ['rev-list', '--count', `${headBefore}..master`])).toBe('1')
  expect(git(REPO_DIR, ['log', '-1', '--format=%s', 'master']))
    .toBe('(e2e-squash) 3 commits: feat: squash 首条 .. fix: squash 末条')
  expect(fs.readFileSync(path.join(REPO_DIR, 'sq1.txt'), 'utf8')).toBe('squash one\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'sq3.txt'), 'utf8')).toBe('squash three\n')
  // 源分支保持现状：不自动删除
  expect(git(REPO_DIR, ['rev-parse', '--verify', 'refs/heads/e2e-squash'])).toBeTruthy()
})
