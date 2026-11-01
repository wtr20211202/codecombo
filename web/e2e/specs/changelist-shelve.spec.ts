import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更列表（changelist）与搁置（shelve）E2E（P-20261007-19）：
 *   ① 分区 CRUD：新建列表 → 变更树右键「移入列表」→ 行计数/活跃高亮 → 删除；
 *   ② active 过滤：变更树按活跃组收敛（「活跃组」chip），与文本过滤 AND 叠加；
 *   ③ shelve 闭环：列表行「搁置本组」→ stash 页签条目带「搁置」徽标 → 恢复回树。
 * 用例间经 API 铺底（列表/归属/活跃），UI 驱动与 git CLI 真实状态核对分离；
 * 自备临时仓库，afterAll 清项目/列表/目录/uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-changelist')
const PROJ = 'e2e-changelist'
const F1 = 'alpha-cl.txt'
const F2 = 'beta-cl.txt'
const F3 = 'gamma-cl.txt'
const LIST_MAIN = 'feature-cl'
const LIST_SHELVE = 'shelve-group'
const SHELVE_MSG = 'e2e: shelve 消息'

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

async function deleteList(headers: Record<string, string>, name: string) {
  await fetch(`${API_BASE}/api/changelists/${encodeURIComponent(name)}?projectId=${projectId}`, { method: 'DELETE', headers })
}

/** API 铺底：建列表（重名 409 忽略）→ 移入文件 → 可选设活跃 */
async function prepareList(headers: Record<string, string>, name: string, file: string, active: boolean) {
  await fetch(`${API_BASE}/api/changelists`, {
    method: 'POST', headers, body: JSON.stringify({ name, projectId }),
  })
  if (file) {
    const mv = await fetch(`${API_BASE}/api/changelists/move-file`, {
      method: 'PUT', headers, body: JSON.stringify({ changelist: name, file, projectId }),
    })
    expect(mv.ok, `前置：移入 ${file} 到 ${name}`).toBeTruthy()
  }
  if (active) {
    const act = await fetch(`${API_BASE}/api/changelists/active`, {
      method: 'PUT', headers, body: JSON.stringify({ name, projectId }),
    })
    expect(act.ok, `前置：设活跃 ${name}`).toBeTruthy()
  }
}

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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'changelist e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: changelist 基线'])
  // 三条变更：F1 已暂存（供勾选框与搁置语义核对），F2/F3 未暂存
  for (const f of [F1, F2, F3]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} content v1\n`)
  git(REPO_DIR, ['add', F1])

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
  // 分区列表随项目删除前显式清理（config 全局存储，孤儿条目不留台账）
  for (const name of [LIST_MAIN, LIST_SHELVE]) {
    await deleteList(headers, name)
  }
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
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

function dialogInput(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog .n-input input')
}
function dialogConfirm(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog__action button').filter({ hasText: '确认' })
}

test('分区 CRUD：新建 → 右键移入文件 → 计数/活跃高亮 → 删除', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')

  // 新建列表（分区标题行「新建」钮 → promptDialog）
  await expect(panel.locator('[data-testid="cl-section"]')).toBeVisible()
  await panel.locator('[data-testid="cl-new"]').click()
  await expect(dialogInput(page)).toBeVisible({ timeout: 3000 })
  await dialogInput(page).fill(LIST_MAIN)
  await dialogConfirm(page).click()
  const row = panel.locator('[data-testid="cl-row"]').filter({ hasText: LIST_MAIN })
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row.locator('.cp-cl-count')).toHaveText('0')

  // 变更树右键 F1 → 移入列表子菜单 → feature-cl（行计数 0 → 1）
  await panel.locator('.cp-node').filter({ hasText: F1 }).click({ button: 'right' })
  const moveOpt = page.locator('.n-dropdown-option-body').filter({ hasText: '移入列表' })
  await expect(moveOpt).toBeVisible({ timeout: 3000 })
  await moveOpt.hover()
  const child = page.locator('.n-dropdown-option-body').filter({ hasText: LIST_MAIN })
  await expect(child).toBeVisible({ timeout: 3000 })
  await child.click()
  await expect(page.locator('.n-message').filter({ hasText: '已移入列表' })).toBeVisible({ timeout: 5000 })
  await expect(row.locator('.cp-cl-count')).toHaveText('1', { timeout: 5000 })

  // 设为活跃（●钮）：行高亮 is-active
  await row.locator('[data-testid="cl-set-active"]').click()
  await expect(panel.locator('[data-testid="cl-row"].is-active').filter({ hasText: LIST_MAIN })).toBeVisible({ timeout: 5000 })

  // 删除：二次确认弹窗 → 行消失（组内文件不受影响，变更树仍 3 条）
  await row.locator('[data-testid="cl-delete"]').click()
  await page.locator('.n-dialog__action button').filter({ hasText: '删除' }).click()
  await expect(panel.locator('[data-testid="cl-row"]').filter({ hasText: LIST_MAIN })).toHaveCount(0, { timeout: 5000 })
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(3)
})

test('active 过滤：变更树收敛到活跃组，与文本过滤 AND 叠加', async ({ page }) => {
  const headers = await unlockHeaders()
  // API 铺底（UI 建组/移入/活跃路径由上一用例覆盖）：feature-cl = {F1}，活跃
  await deleteList(headers, LIST_MAIN)
  await prepareList(headers, LIST_MAIN, F1, true)

  await enterProject(page)
  const panel = page.locator('.commit-panel')
  const chip = panel.locator('[data-testid="cp-changelist-filter"]')
  const row = panel.locator('[data-testid="cl-row"]').filter({ hasText: LIST_MAIN })

  // 活跃组就绪（is-active 高亮）后 chip 可用；未开启时三文件全量显示
  await expect(row).toHaveClass(/is-active/, { timeout: 5000 })
  await expect(chip).toBeEnabled()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()

  // 开启「只看活跃组」：树收敛到 F1，F2/F3 隐藏
  await chip.click()
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toHaveCount(0)
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toHaveCount(0)

  // AND 叠加：文本过滤与活跃组取交集——'beta' 命中的 F2 不在组内 → 无命中提示
  await panel.locator('input[placeholder*="过滤变更"]').fill('beta')
  await expect(panel.locator('.cp-no-match')).toBeVisible()
  // 交集命中：过滤词 'alpha' → F1 仍在
  await panel.locator('input[placeholder*="过滤变更"]').fill('alpha')
  await expect(panel.locator('.cp-node').filter({ hasText: F1 })).toBeVisible()
  await panel.locator('input[placeholder*="过滤变更"]').fill('')

  // 关闭 chip 恢复全量
  await chip.click()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible()
  await expect(panel.locator('.cp-node').filter({ hasText: F3 })).toBeVisible()
})

test('shelve 闭环：搁置本组 → stash 条目带搁置徽标 → 恢复回树', async ({ page }) => {
  const headers = await unlockHeaders()
  // 清掉可能的前次遗留 stash（用例开头先 API 清空惯例）
  for (let i = 0; i < 10; i++) {
    const list = await (await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })).json()
    if (((list?.data || []) as unknown[]).length === 0) break
    await fetch(`${API_BASE}/api/projects/${projectId}/stash/0`, { method: 'DELETE', headers })
  }
  // API 铺底：shelve-group = {F2}（未搁置）
  await deleteList(headers, LIST_SHELVE)
  await prepareList(headers, LIST_SHELVE, F2, false)
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain(F2)

  await enterProject(page)
  const panel = page.locator('.commit-panel')
  const row = panel.locator('[data-testid="cl-row"]').filter({ hasText: LIST_SHELVE })
  await expect(row).toBeVisible({ timeout: 5000 })

  // 搁置本组：消息弹窗 → 确认 → toast + F2 从变更树消失（工作区归零）
  await row.locator('[data-testid="cl-shelve"]').click()
  await expect(dialogInput(page)).toBeVisible({ timeout: 3000 })
  await dialogInput(page).fill(SHELVE_MSG)
  await dialogConfirm(page).click()
  await expect(page.locator('.n-message').filter({ hasText: '已搁置 1 个文件' })).toBeVisible({ timeout: 5000 })
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toHaveCount(0, { timeout: 5000 })
  // 仓库真实状态：F2 的变更入 stash（消息带 shelve: 标识），F1 暂存/F3 未暂存不动
  const status = git(REPO_DIR, ['status', '--porcelain'])
  expect(status).not.toContain(F2)
  expect(status).toContain(F1)
  expect(status).toContain(F3)
  expect(git(REPO_DIR, ['stash', 'list'])).toContain(`shelve: ${SHELVE_MSG}`)

  // stash 页签：条目带「搁置」徽标，消息剥前缀显示
  await page.locator('[data-testid="cp-tab-stash"]').click()
  const stashItem = panel.locator('.cp-stash-item').first()
  await expect(stashItem).toBeVisible({ timeout: 5000 })
  await expect(stashItem.locator('[data-testid="cl-stash-badge"]')).toHaveText('搁置')
  await expect(stashItem.locator('.cp-stash-msg')).toContainText(SHELVE_MSG)

  // 恢复（pop）：F2 回变更树，stash 清空
  await stashItem.getByRole('button', { name: '恢复' }).click()
  await page.locator('[data-testid="cp-tab-changes"]').click()
  await expect(panel.locator('.cp-node').filter({ hasText: F2 })).toBeVisible({ timeout: 5000 })
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain(F2)
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toBe('')
})
