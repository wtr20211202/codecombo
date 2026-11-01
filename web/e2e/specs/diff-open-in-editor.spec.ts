import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff「在编辑器打开」直达 E2E（P-20261003-57）：diff 是审阅终点，工具条按钮
 * 一键把右侧版本对应的真实文件开进编辑器（预览位，OPS_OPEN_FILE_AT 既有链），
 * 补「审阅→修改」动线。形态守卫断言（伪 ref 静禁用）：
 *   1. 变更面板工作区 diff（diff:HEAD:wt:<file>）→ 按钮可用 → 点击后真实文件
 *      成活跃 tab（非 Diff 签），DiffEditor 卸载
 *   2. 提交历史对比（diff:<hash>:HEAD:<file>）→ 按钮可见但置灰（右侧为历史
 *      版本，与磁盘现状无对应，打开落空）
 * 自备临时仓库（c1 基线 + 工作区未提交修改），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-open-in-editor')
const PROJ = 'e2e-diff-open-in-editor'
const FILE = 'review.txt'

const C1_CONTENT = 'reviewed baseline\nsecond line\n'
const WT_CONTENT = 'reviewed baseline\nsecond line EDITED in worktree\n'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let c1 = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])
  // 工作区未提交修改（测试 1 的审阅对象；git 历史仅 c1 供测试 2 对比）
  fs.writeFileSync(path.join(REPO_DIR, FILE), WT_CONTENT)

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

// rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-panel')).toBeVisible()
}

// rail git 面板提交列表（uiState 恢复态不定，同款 toggle 归一化）
async function openCommitLog(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

const openInEditorBtn = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="diff-open-in-editor"]')

test('工作区 diff：按钮可用 → 点击打开真实文件成活跃 tab', async ({ page }) => {
  await enterProject(page)
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: FILE })).toBeVisible({ timeout: 10000 })

  // 双击变更行 → diff:HEAD:wt 标签（DiffEditor 挂载）
  await page.locator('.cp-node').filter({ hasText: FILE }).first().dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })

  // 右侧=工作区版本 → 守卫放行，按钮可用
  const btn = openInEditorBtn(page)
  await expect(btn).toBeVisible()
  await expect(btn).toBeEnabled()

  // 点击 → OPS_OPEN_FILE_AT 打开链（预览位）：真实文件成活跃 tab（非 Diff 签）
  await btn.click()
  const activeName = page.locator('.editor-tab.active .tab-name')
  await expect(activeName).toHaveText(FILE, { timeout: 10000 })
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  // DiffEditor 随活跃 tab 切换卸载——动线终点是可编辑的普通编辑器
  await expect(page.locator('.monaco-diff-editor')).toHaveCount(0)
})

test('历史对比 diff：按钮置灰（右侧为 HEAD 历史版本）', async ({ page }) => {
  await enterProject(page)
  await openCommitLog(page)

  // 选中 c1 → 右侧对比文件节点 → 右键「查看此次变更」→ diff:<hash>:HEAD 标签
  await page.locator('.commit-item').filter({ hasText: c1.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })

  // 伪 ref（newRef=HEAD）守卫：按钮在但置灰，点击无效果（仍停留 diff 签）
  const btn = openInEditorBtn(page)
  await expect(btn).toBeVisible()
  await expect(btn).toBeDisabled()
})
