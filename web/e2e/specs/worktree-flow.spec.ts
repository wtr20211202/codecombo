import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 工作树（Worktree）管理 E2E：添加 Worktree（新分支）→ CLI worktree list
 * 含新路径 → UI 列表出现。自备临时仓库，afterAll 清理（worktree remove +
 * 项目删除 + uiState 归零）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-worktree')
const WT_DIR = REPO_DIR + '-wt'
const PROJ = 'e2e-worktree'
const WT_BRANCH = 'wt-e2e-branch'

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
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

/** 建待删除的 worktree（用例 2 兜底前置）：Windows 服务端走 CLI 反斜杠形态
 * （原始缺陷的触发形态）；linux 服务端经服务端 API 建——worktree 元数据里
 * 落的是 /mnt/c 形态，服务端按路径删除才按得中（Windows git 建 /mnt/c 路径
 * 会被当成相对路径，两侧无法同形） */
async function seedWorktree(headers: Record<string, string>): Promise<void> {
  if (serverIsLinux) {
    const created = await fetch(`${API_BASE}/api/projects/${projectId}/worktrees`, {
      method: 'POST', headers, body: JSON.stringify({ path: serverPath(WT_DIR), branch: WT_BRANCH }),
    })
    expect(created.ok()).toBeTruthy()
  } else {
    git(REPO_DIR, ['worktree', 'add', WT_DIR.replace(/\//g, '\\'), '-b', WT_BRANCH])
  }
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
  for (const dir of [REPO_DIR, WT_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'worktree e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: worktree 基线'])
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
  // 先摘除 worktree 注册再删目录（避免主仓库残留 worktree 元数据）
  try { execFileSync('git', ['worktree', 'remove', '--force', WT_DIR], { cwd: REPO_DIR }) } catch { /* 已不存在 */ }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(WT_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('添加 Worktree：新分支 + 路径 → CLI worktree list 含新路径', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }

  // 打开「新建 Worktree」弹窗（工作树区 [+]/标题按钮）
  const addBtn = page.locator('button[title="创建 Worktree"]').first()
  await expect(addBtn).toBeVisible({ timeout: 5000 })
  await addBtn.click()

  // 填路径 + 新分支名 → 创建（路径按服务端形态填入，服务端建 worktree 落同形态元数据）
  // 自定义弹窗（modal-overlay/modal-card）：按占位符定位字段
  const pathInput = page.locator('.modal-card input[placeholder*="repo-feature"]')
  const branchInput = page.locator('.modal-card input[placeholder*="feature/"]').first()
  await pathInput.fill(serverPath(WT_DIR))
  await branchInput.fill(WT_BRANCH)
  await page.locator('.modal-footer').getByRole('button', { name: '创建' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Worktree 已创建' })).toBeVisible({ timeout: 8000 })

  // CLI：worktree list 含新路径（服务端创建时登记的形态）且分支正确
  const list = git(REPO_DIR, ['worktree', 'list'])
  expect(list.split(String.fromCharCode(92)).join(String.fromCharCode(47))).toContain(serverPath(WT_DIR).replace(/\\/g, '/'))
  expect(list).toContain(WT_BRANCH)
})

test('工作树右键删除：确认弹窗 → worktree list 不再含该路径', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }

  // 自备待删除的 worktree（形态按服务端分支：见 seedWorktree 注释）
  if (!fs.existsSync(WT_DIR)) {
    const headers = await unlockHeaders()
    await seedWorktree(headers)
  }

  let wtRow = page.locator('.wt-item', { hasText: WT_BRANCH }).first()
  if (!(await wtRow.isVisible().catch(() => false))) {
    const header = page.locator('.section-header').filter({ hasText: '工作树' }).first()
    if (await header.isVisible().catch(() => false)) {
      await header.click()
      await page.waitForTimeout(600)
    }
    wtRow = page.locator('.wt-item', { hasText: WT_BRANCH }).first()
  }
  await expect(wtRow).toBeVisible({ timeout: 5000 })

  await wtRow.click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('删除', { exact: true }).first()
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  const confirmDlg = page.locator('.n-dialog').filter({ hasText: WT_BRANCH })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: '删除' }).click()

  await expect(page.locator('.n-message').filter({ hasText: 'Worktree 已删除' })).toBeVisible({ timeout: 8000 })

  // CLI：worktree list 不再含该路径
  await expect.poll(async () => git(REPO_DIR, ['worktree', 'list']), { timeout: 5000 }).not.toContain(WT_DIR)
})
