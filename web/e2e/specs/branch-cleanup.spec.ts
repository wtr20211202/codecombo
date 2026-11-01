import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 清理已合并分支 E2E（P-20261003-50）：
 * 造已合并分支 ×2 + 未合并分支 ×1 → 分支行「已合并」徽标只标已合并非当前分支；
 * 清理向导清单不含未合并/当前分支（main/master 保护名单硬排除）；批量勾删
 * （默认全不选 → 勾 2 → 计数确认 → 删）后 git 侧分支消失、未合并分支保留。
 * 自备临时仓库，afterAll 清理（范式与 branch-checkout 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-cleanup')
const PROJ = 'e2e-cleanup'
const MERGED_A = 'e2e-merged-a'
const MERGED_B = 'e2e-merged-b'
const KEPT = 'e2e-kept'

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // master 基线
  fs.writeFileSync(path.join(REPO_DIR, 'base.txt'), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 基线提交'])
  // 已合并分支 ×2：独立提交后合回 master（进入清理清单）
  for (const [name, file] of [[MERGED_A, 'a.txt'], [MERGED_B, 'b.txt']] as const) {
    git(REPO_DIR, ['checkout', '-b', name])
    fs.writeFileSync(path.join(REPO_DIR, file), `${name}\n`)
    git(REPO_DIR, ['add', '.'])
    git(REPO_DIR, ['commit', '-m', `feat: ${name}`])
    git(REPO_DIR, ['checkout', 'master'])
    git(REPO_DIR, ['merge', '--no-ff', '-m', `merge ${name}`, name])
  }
  // 未合并分支：提交留在分支上（不进清理清单）
  git(REPO_DIR, ['checkout', '-b', KEPT])
  fs.writeFileSync(path.join(REPO_DIR, 'kept.txt'), `${KEPT}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', `feat: ${KEPT}`])
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

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openBranchTree(page)
}

test('分支行「已合并」徽标：已合并非当前分支标，未合并/当前分支不标', async ({ page }) => {
  await enterProject(page)

  // 已合并分支行有灰徽标
  const rowA = page.locator('.branch-item', { hasText: MERGED_A })
  await expect(rowA).toBeVisible({ timeout: 5000 })
  await expect(rowA.locator('.branch-merged-badge')).toHaveText('已合并')
  const rowB = page.locator('.branch-item', { hasText: MERGED_B })
  await expect(rowB.locator('.branch-merged-badge')).toBeVisible()

  // 未合并分支无徽标
  const keptRow = page.locator('.branch-item', { hasText: KEPT })
  await expect(keptRow).toBeVisible({ timeout: 5000 })
  await expect(keptRow.locator('.branch-merged-badge')).toHaveCount(0)

  // 当前分支（master）无徽标
  const masterRow = page.locator('.branch-item.current', { hasText: 'master' })
  await expect(masterRow).toBeVisible()
  await expect(masterRow.locator('.branch-merged-badge')).toHaveCount(0)
})

test('清理向导：清单排除未合并/当前分支，批量勾删后 git 侧分支消失', async ({ page }) => {
  await enterProject(page)

  await page.locator('[data-testid="branch-cleanup-open"]').click()
  const modal = page.locator('[data-testid="branch-cleanup-modal"]')
  await expect(modal).toBeVisible({ timeout: 3000 })

  // 清单只含已合并的非当前本地分支：未合并 / 当前分支不进清单
  const items = modal.locator('[data-testid="branch-cleanup-item"]')
  await expect(items).toHaveCount(2)
  await expect(items.filter({ hasText: MERGED_A })).toBeVisible()
  await expect(items.filter({ hasText: MERGED_B })).toBeVisible()
  await expect(modal.locator('[data-testid="branch-cleanup-item"]', { hasText: KEPT })).toHaveCount(0)
  await expect(modal.locator('[data-testid="branch-cleanup-item"]', { hasText: 'master' })).toHaveCount(0)

  // 默认全不选（破坏性操作必须显式勾选）
  await expect(modal.locator('.n-checkbox--checked')).toHaveCount(0)

  // 勾选两个 → 计数联动
  await items.filter({ hasText: MERGED_A }).locator('.n-checkbox').click()
  await items.filter({ hasText: MERGED_B }).locator('.n-checkbox').click()
  await expect(modal.locator('.n-checkbox--checked')).toHaveCount(2)
  await expect(modal.getByText('已选 2 个')).toBeVisible()

  // 清理 → 计数确认弹窗 → 确认
  await modal.locator('[data-testid="branch-cleanup-confirm"]').click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: '将删除 2 个已合并分支' })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '清理' }).click()

  // 成功提示 + git 侧两分支已删、未合并分支保留
  await expect(page.locator('.n-message').filter({ hasText: '已清理 2 个已合并分支' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => git(REPO_DIR, ['branch', '--list', MERGED_A]), { timeout: 5000 }).toBe('')
  await expect.poll(async () => git(REPO_DIR, ['branch', '--list', MERGED_B]), { timeout: 5000 }).toBe('')
  expect(git(REPO_DIR, ['branch', '--list', KEPT]), '未合并分支不应被清理').not.toBe('')

  // 全部清理完自动收起，侧栏分支树刷新（已合并行消失、未合并行保留）
  await expect(modal).toBeHidden({ timeout: 3000 })
  await expect(page.locator('.branch-item', { hasText: MERGED_A })).toHaveCount(0)
  await expect(page.locator('.branch-item', { hasText: KEPT })).toBeVisible()
})

test('清理完成后重开向导：空态提示', async ({ page }) => {
  await enterProject(page)

  await page.locator('[data-testid="branch-cleanup-open"]').click()
  const modal = page.locator('[data-testid="branch-cleanup-modal"]')
  await expect(modal).toBeVisible({ timeout: 3000 })
  const empty = modal.locator('[data-testid="branch-cleanup-empty"]')
  await expect(empty).toBeVisible({ timeout: 3000 })
  await expect(empty).toHaveText('没有可清理的已合并分支')
})
