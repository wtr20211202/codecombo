import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更列表键盘导航 E2E（P-20261002-39）：CommitPanel 文件列表容器可聚焦后，
 *   ↑↓ 在过滤后可见行（目录行+文件行）环绕移动高亮、Home/End 首尾、
 *   Enter 激活当前行（文件=开 diff，目录=展开/收起）、Space 切 staged 文件的
 *   提交勾选；焦点在过滤输入框内时方向键不劫持（让位原生光标移动），
 *   且导航按 P-33 过滤后的可见项遍历。
 * 四个文件（其一在子目录）在注册项目前已 git add（项目注册使服务端 status
 * 缓存失效，进项目首拉即含 staged 变更）。自备临时仓库，afterAll 清理
 * （与 changes-filter 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-changes-keyboard')
const PROJ = 'e2e-changes-keyboard'
const F1 = 'alpha-key.txt'
const F2 = 'beta-key.txt'
const F3 = 'gamma-key.txt'
const F4_DIR = 'nested'
const F4 = 'nested/kappa-key.txt'

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
  fs.mkdirSync(path.join(REPO_DIR, F4_DIR), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'keyboard e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 键盘导航基线'])
  // 造 4 个 staged 变更（勾选框 ☑/☐ 仅对 staged 文件渲染；子目录文件出目录行）
  for (const f of [F1, F2, F3, F4]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} staged content\n`)
  git(REPO_DIR, ['add', '.'])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(4)

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

/** 聚焦列表容器并断言焦点落位（tabindex=0） */
async function focusList(page: import('@playwright/test').Page) {
  const list = page.locator('.cp-file-list')
  await list.focus()
  await expect(list).toBeFocused()
  return list
}

/** 当前键盘高亮行的文件名（目录行即目录名） */
function activeName(page: import('@playwright/test').Page) {
  return page.locator('.cp-node.is-active .cp-name')
}

// flatTree 行序：目录行在前（sortTree 目录优先），子项按字母序——
// nested → kappa-key.txt → alpha-key.txt → beta-key.txt → gamma-key.txt

test('方向键环绕移动高亮 + Home/End 首尾 + 目录行 Enter 展开/收起', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await focusList(page)

  // 初始高亮在首行（目录行 nested）；↑↓ 沿扁平行序移动，到尾环绕回头、到头顶环绕回尾
  await expect(activeName(page)).toHaveText(F4_DIR)
  for (const expected of ['kappa-key.txt', F1, F2, F3]) {
    await page.keyboard.press('ArrowDown')
    await expect(activeName(page)).toHaveText(expected)
  }
  await page.keyboard.press('ArrowDown')
  await expect(activeName(page)).toHaveText(F4_DIR) // 尾→头环绕
  await page.keyboard.press('ArrowUp')
  await expect(activeName(page)).toHaveText(F3) // 头→尾环绕
  await page.keyboard.press('Home')
  await expect(activeName(page)).toHaveText(F4_DIR)
  await page.keyboard.press('End')
  await expect(activeName(page)).toHaveText(F3)

  // Enter 在目录行 = 展开/收起（通知中心组行展开同语义），不与 diff 混淆
  await page.keyboard.press('Home')
  await expect(activeName(page)).toHaveText(F4_DIR)
  await page.keyboard.press('Enter')
  await expect(panel.locator('.cp-node').filter({ hasText: 'kappa-key.txt' })).toHaveCount(0)
  await expect(activeName(page)).toHaveText(F4_DIR) // 收起后高亮仍锚在目录行
  await page.keyboard.press('Enter')
  await expect(panel.locator('.cp-node').filter({ hasText: 'kappa-key.txt' })).toBeVisible()
})

test('Space 切换提交勾选并与提交计数联动，Enter 打开当前文件 diff', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await focusList(page)

  // 基线：未勾选 → 提交按钮按全量暂存计 4
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (4)')

  // Home 归位后两步到 alpha → Space 切勾选 ☐→☑→☐，提交计数 4→1→4 联动
  await page.keyboard.press('Home') // nested
  await page.keyboard.press('ArrowDown') // → kappa-key.txt
  await page.keyboard.press('ArrowDown') // → alpha-key.txt
  await expect(activeName(page)).toHaveText(F1)
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☐')
  await page.keyboard.press('Space')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☑')
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (1)')
  await page.keyboard.press('Space')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-commit-check')).toHaveText('☐')
  await expect(panel.locator('.n-button').filter({ hasText: '提交' })).toContainText('提交 (4)')

  // End 到末行 gamma → Enter 开 diff（tab 名 <文件名> (Diff)）。
  // 放最后：diff 打开后主区出现编辑器页签，面板路由态不再适合同用例内继续操作面板
  await page.keyboard.press('End')
  await expect(activeName(page)).toHaveText(F3)
  await page.keyboard.press('Enter')
  await expect(page.getByRole('tab', { name: `${F3} (Diff)` })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.diff-editor-container').first()).toBeVisible({ timeout: 10000 })
})

test('过滤输入框内方向键不劫持；导航按过滤后可见项遍历', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  const filterInput = page.locator('.commit-panel input[placeholder*="过滤变更"]')

  // Home 锚到首行（目录行）后进过滤框：输入框内按方向键只动光标，高亮不被劫持
  await focusList(page)
  await page.keyboard.press('Home')
  await expect(activeName(page)).toHaveText(F4_DIR)
  await filterInput.click()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(activeName(page)).toHaveText(F4_DIR)

  // 过滤 'gamma' → 可见项只剩 1 行且高亮回落其上（P-33 兼容：导航遍历过滤后可见项）
  await filterInput.fill('gamma')
  await expect(panel.locator('.cp-node')).toHaveCount(1)
  await expect(activeName(page)).toHaveText(F3)
  await filterInput.click()
  await page.keyboard.press('ArrowDown') // 单行列表环绕仍在自身，且输入框内不劫持
  await expect(activeName(page)).toHaveText(F3)

  // 清空过滤恢复全量 → 高亮回落首行
  await filterInput.fill('')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(activeName(page)).toHaveText(F4_DIR)
})
