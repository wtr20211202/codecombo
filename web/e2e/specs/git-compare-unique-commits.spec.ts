import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 分支比较弹层「仅独有提交」过滤 E2E（P-20261003-233）：CompareRefModal 工具条
 * 下提交区间清单——开 = main..feature 单向（仅待合入侧独有），关 = main...feature
 * 对称差双向全量。夹具分叉双分支（提交时间显式钉死，对称差两侧「最新在前」的
 * 相对序才可精确断言），自备临时仓库 afterAll 清理；基线缺失降级（noBase 标志）
 * 走 API 直测——UI 侧基线不可解析无自然入口（当前分支名始终可解析），服务端
 * 语义已由 go test 锁定，此处只验响应契约（200 + 全量 + noBase）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-compare-unique')
const PROJ = 'e2e-git-compare-unique'
const FILE = 'lib.txt'

function git(cwd: string, args: string[], date?: string) {
  const env: Record<string, string> = { ...process.env as Record<string, string> }
  if (date) {
    env.GIT_AUTHOR_DATE = date
    env.GIT_COMMITTER_DATE = date
  }
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8', env,
  }).trim()
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

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 提交时间钉死：main 侧 c2 最新（对称差排最前），feature 侧 f2 > f1
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'base\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: base'], '2026-01-01T01:00:00 +0000')
  git(REPO_DIR, ['branch', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'base\nmain line\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: main side'], '2026-01-01T04:00:00 +0000')
  git(REPO_DIR, ['switch', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'base\nfeature one\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'f1: feature one'], '2026-01-01T02:00:00 +0000')
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'base\nfeature one\nfeature two\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'f2: feature two'], '2026-01-01T03:00:00 +0000')
  git(REPO_DIR, ['switch', 'main'])

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

// 打开比较弹窗（经提交面板选 c2 → 文件节点右键「在编辑器中打开」→ 右上「对比」）
async function openCompareModal(page: import('@playwright/test').Page) {
  await page.locator('.commit-item').filter({ hasText: 'c2: main side' }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.ega-btn').filter({ hasText: '对比' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `对比：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

async function selectFeature(page: import('@playwright/test').Page, modal: import('@playwright/test').Locator) {
  await modal.locator('.n-base-selection').first().click()
  const featureOption = page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: 'feature' })
  await expect(featureOption).toBeVisible({ timeout: 10000 })
  await featureOption.click()
  await expect(modal.locator('[data-test="compare-commits"]')).toBeVisible({ timeout: 10000 })
}

test('toggle 关 = 对称差双向全量；开 = 仅参照独有单向；可逆', async ({ page }) => {
  await enterAndOpenLog(page)
  const modal = await openCompareModal(page)
  await selectFeature(page, modal)

  const list = modal.locator('[data-test="compare-commit-list"]')
  const rows = list.locator('.crm-commit-row')

  // 默认（开关关）：main...feature 对称差 = 两侧独有全量（c2/f2/f1，提交时间
  // 已钉死 → 最新在前精确可断言），共同祖先 c1 不在列
  const rangeLabel = modal.locator('.crm-commits-range')
  await expect(rangeLabel).toHaveText('main ... feature')
  await expect(rows).toHaveCount(3, { timeout: 10000 })
  await expect(rows.nth(0)).toContainText('c2: main side')
  await expect(rows.nth(1)).toContainText('f2: feature two')
  await expect(rows.nth(2)).toContainText('f1: feature one')
  await expect(modal.locator('.crm-commits-note')).toHaveCount(0)

  // 开「仅独有提交」：main..feature 单向 = 仅 feature 侧（f2/f1），main 侧 c2 消失
  await modal.locator('[data-test="compare-unique-toggle"]').click()
  await expect(rangeLabel).toHaveText('main .. feature')
  await expect(rows).toHaveCount(2, { timeout: 10000 })
  await expect(rows.nth(0)).toContainText('f2: feature two')
  await expect(rows.nth(1)).toContainText('f1: feature one')
  await expect(rows.filter({ hasText: 'c2: main side' })).toHaveCount(0)

  // 再关：回到双向全量（开关可逆）
  await modal.locator('[data-test="compare-unique-toggle"]').click()
  await expect(rows).toHaveCount(3, { timeout: 10000 })
  await expect(rows.nth(0)).toContainText('c2: main side')
})

test('基线缺失降级：服务端返回参照全量 + noBase 标志（API 契约）', async () => {
  const headers = await unlockHeaders()

  // from 不可解析（分支已删/写错）：200 + to 全量历史（c1/f1/f2）+ noBase=true
  const res = await fetch(
    `${API_BASE}/api/projects/${projectId}/log?range=compare&from=ghost-branch&to=feature&unique=1&limit=50`,
    { headers },
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: { message?: string }[]; noBase?: boolean }
  expect(body.noBase).toBe(true)
  const subjects = (body.data || []).map(c => c.message || '').sort()
  expect(subjects).toEqual(['c1: base', 'f1: feature one', 'f2: feature two'])

  // to 缺参 → 400（对比本身不可能）
  const bad = await fetch(`${API_BASE}/api/projects/${projectId}/log?range=compare&from=main`, { headers })
  expect(bad.status).toBe(400)
})
