import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 视图忽略空白切换 E2E（P-20261001-16）：夹具 = c2 相对 c1 三行全部只有
 * 首尾空白变化（前导空格/尾随 tab/前导 tab），git 视为真实提交、trim 后逐行等价。
 *   1. Monaco diff 路径（commits 面板右键「查看此次变更」→ DiffEditor 标签）：
 *      默认显示空白差异行（line-delete/line-insert）→ 开忽略空白 → 差异清零 → 可逆
 *   2. 文本 diff 路径（「在编辑器中打开」→「对比」弹窗 → DiffViewer unified）：
 *      +/- 前缀行存在 → 开忽略空白 → trim 等价行对合并为 context → 可逆
 * 自备临时仓库（feature 分支指回 c1 供对比弹窗选 ref），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-ignore-ws')
const PROJ = 'e2e-diff-ignore-ws'
const FILE = 'format.txt'

const C1_CONTENT = 'alpha line\nbeta line\ngamma line\n'
const C2_CONTENT = '    alpha line\nbeta line\t\n\t\tgamma line\n'

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
let c2 = ''

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
  git(REPO_DIR, ['branch', 'feature']) // feature 指回 c1：对比弹窗选它即得 c1↔c2 空白 diff
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: whitespace only'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

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

// 进项目并展开底部 Git 面板提交列表（rail 是 toggle，按提交可见性收敛）
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

/** 选中 c2（点 meta 行，消息区单击是展开 body）→ 返回右侧变更文件节点 */
async function selectWhitespaceCommit(page: import('@playwright/test').Page) {
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  return node
}

test('Monaco diff 路径：默认显示空白差异 → 开忽略空白清零 → 可逆', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectWhitespaceCommit(page)

  // 查看此次变更 → DiffEditor 标签（c1↔c2 仅空白差异）
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })

  // 默认（开关关）：DiffEditor 显式 ignoreTrimWhitespace:false，空白-only 行仍标差异
  const delLines = page.locator('.monaco-diff-editor .line-delete')
  const insLines = page.locator('.monaco-diff-editor .line-insert')
  await expect(delLines.first()).toBeVisible({ timeout: 10000 })
  await expect(insLines.first()).toBeVisible()

  // 开忽略空白 → updateOptions 触发重算，差异装饰清零
  const toggle = page.locator('.diff-nav-bar button[title="忽略空白"]')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(delLines).toHaveCount(0, { timeout: 10000 })
  await expect(insLines).toHaveCount(0)

  // 再点恢复：开关可逆（视图级状态，不落盘）
  await toggle.click()
  await expect(delLines.first()).toBeVisible({ timeout: 10000 })
})

test('文本 diff 路径：unified +/- 行 → 开忽略空白合并为 context → 可逆', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectWhitespaceCommit(page)

  // 在编辑器中打开普通文件 → 右上「对比」→ CompareRefModal（内嵌 DiffViewer）
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.ega-btn').filter({ hasText: '对比' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `对比：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })

  // 选 feature（指向 c1）→ feature ↔ HEAD 即空白-only diff，默认 unified 视图
  await modal.locator('.n-base-selection').first().click()
  const featureOption = page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: 'feature' })
  await expect(featureOption).toBeVisible({ timeout: 10000 })
  await featureOption.click()
  await expect(modal.locator('.crm-diff')).toBeVisible({ timeout: 10000 })

  // 默认：3 del + 3 add 前缀行
  const marks = modal.locator('.diff-line-prefix').filter({ hasText: /^[+-]$/ })
  await expect(marks.first()).toBeVisible({ timeout: 10000 })
  await expect(marks).toHaveCount(6)

  // 开忽略空白 → trim 等价行对合并为 context，+/- 前缀清零
  await modal.getByRole('button', { name: '忽略空白' }).click()
  await expect(marks).toHaveCount(0)
  await expect(modal.locator('.diff-line').first()).toBeVisible()

  // 再点恢复：开关可逆
  await modal.getByRole('button', { name: '忽略空白' }).click()
  await expect(marks.first()).toBeVisible({ timeout: 10000 })
})
