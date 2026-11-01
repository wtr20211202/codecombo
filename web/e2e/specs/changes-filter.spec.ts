import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更列表即时过滤 E2E：CommitPanel 文件列表头部过滤框按路径子串收窄显示。
 * 核心守护「过滤仅影响显示」的解耦约束：
 *   过滤剩 1 → 勾选它 → 清过滤 → 其余 2 仍在且未勾选（勾选集不被过滤波及）；
 *   未勾选时提交按钮计数始终按全量暂存计（过滤隐藏不改变 stagedCount）。
 * 三个文件在注册项目前已 git add（项目注册使服务端 status 缓存失效，
 * 进项目首拉即含 3 条 staged 变更，无需等 TTL/手动刷新）。
 * 自备临时仓库，afterAll 清理（与 rollback-confirm 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-changes-filter')
const PROJ = 'e2e-changes-filter'
const F1 = 'alpha-filter.txt'
const F2 = 'beta-other.txt'
const F3 = 'gamma-extra.txt'

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'filter e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 变更过滤基线'])
  // 造 3 个 staged 变更（勾选框 ☑/☐ 仅对 staged 文件渲染）
  for (const f of [F1, F2, F3]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} staged content\n`)
  git(REPO_DIR, ['add', '.'])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(3)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
}

/** 变更列表头部的即时过滤输入框（placeholder 部分匹配，规避省略号字形差异） */
function filterInput(page: import('@playwright/test').Page) {
  return page.locator('.commit-panel input[placeholder*="过滤变更"]')
}

test('过滤即时收窄：剩 1 显示 n/总数 → 无命中提示 → 清空恢复全量，提交计数始终按全量', async ({ page }) => {
  await enterProject(page)

  // 基线：3 个 staged 文件全量显示，无过滤计数，未勾选时提交按钮 = 全量暂存数 3
  const panel = page.locator('.commit-panel')
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveCount(0)
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (3)')

  // 过滤 'alpha' → 只剩 F1，头部计数 1/3，其余两个从显示中消失
  await filterInput(page).fill('alpha')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toHaveCount(0)
  await expect(panel.locator('.cp-filter-count')).toHaveText('1/3')
  // 徽标不受过滤影响：仍按全量计（解耦约束的显示侧证据）
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (3)')

  // 无命中：给引导提示，列表为空
  await filterInput(page).fill('zzz-no-match')
  await expect(panel.locator('.cp-no-match')).toBeVisible()
  await expect(panel.locator('.cp-node')).toHaveCount(0)
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (3)')

  // 清空恢复全量：3 行回来、计数与提示消失
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toBeVisible()
  await expect(panel.locator('.cp-filter-count')).toHaveCount(0)
  await expect(panel.locator('.cp-no-match')).toHaveCount(0)
})

test('过滤后勾选与全量解耦：勾选过滤项 → 清过滤 → 其余仍在且未勾选、勾选保持', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 过滤剩 F1 → 勾选它（提交选择从 0 变 1，按钮切到按勾选计）
  await filterInput(page).fill('alpha')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☑')
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (1)')

  // 清过滤：3 个文件全量回来，F1 勾选保持，其余 2 个未勾选
  await filterInput(page).fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☑')
  await expect(panel.locator('.cp-node').filter({ hasText: F2 }).locator('.cp-commit-check')).toHaveText('☐')
  await expect(panel.locator('.cp-node').filter({ hasText: F3 }).locator('.cp-commit-check')).toHaveText('☐')
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (1)')
})
