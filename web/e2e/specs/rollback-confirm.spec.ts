import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更列表右键「回滚更改」确认弹窗 E2E：该操作直接丢弃未提交修改且不可恢复，
 * 此前无确认裸奔（误点即丢工作）——本 spec 守护 confirmDialog 接线不被回归。
 *   右键 → 确认框出现（含文件名与「不可恢复」警示）→ 取消 → 文件不动；
 *   再右键 → 确认「回滚」→ 文件恢复到已提交内容、工作区干净。
 * 全程以 git CLI 校验仓库真实状态，UI 只负责驱动操作。
 * 自备临时仓库，afterAll 清理（项目/目录/uiState 归零，与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-rollback-confirm')
const PROJ = 'e2e-rollback-confirm'
const FILE = '.e2e-rollback.tmp'
const COMMITTED = 'rollback e2e v1\n'
const MODIFIED = 'rollback e2e v2\n'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份 -c 内联不依赖本机 git 配置
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
  fs.writeFileSync(path.join(REPO_DIR, FILE), COMMITTED)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: rollback 确认基线'])
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
  // uiState 归零收尾（与 stash-flow 对称，防布局恢复污染后续 spec）
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
}

/**
 * 经 API 写入工作区变更。变更列表无周期轮询（仅挂载/切项目/聚焦时拉取），
 * 写完需点面板刷新按钮让 status 重取；服务端 git status 另有 3s TTL 缓存且
 * 文件写入不失效它（仅项目增删失效）——立即刷新会命中进入项目时的陈旧
 * 空缓存，先等 TTL 过期再刷新，行仍未出现就再等再刷一轮。
 */
async function makeWorkingChange(page: import('@playwright/test').Page, headers: Record<string, string>) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content: MODIFIED }),
  })
  expect(put.ok).toBeTruthy()
  expect(git(REPO_DIR, ['status', '--porcelain']), '前置：工作区应有变更').not.toBe('')
  for (let i = 0; i < 3; i++) {
    await page.waitForTimeout(3200)
    await page.locator('.commit-panel .cp-tab-refresh').click()
    if (await page.locator('.cp-node').filter({ hasText: FILE }).isVisible().catch(() => false)) return
  }
  await expect(page.locator('.cp-node').filter({ hasText: FILE })).toBeVisible({ timeout: 10000 })
}

/** 右键变更行 → 点「回滚更改」菜单 → 等确认弹窗出现（含文件名与警示文案） */
async function openRollbackConfirm(page: import('@playwright/test').Page) {
  await page.locator('.cp-node').filter({ hasText: FILE }).first().click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('回滚更改', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText('回滚更改')
  await expect(dialog).toContainText(FILE)
  await expect(dialog).toContainText('不可恢复')
  return dialog
}

test('回滚确认取消：弹窗出现（含文件名警示）→ 取消 → 变更原样保留', async ({ page }) => {
  await enterProject(page)
  const headers = await unlockHeaders()
  await makeWorkingChange(page, headers)

  const dialog = await openRollbackConfirm(page)
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()

  // 取消后弹窗关闭，变更不动（内容仍是修改版，工作区仍脏）
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('v2')
  expect(git(REPO_DIR, ['status', '--porcelain'])).not.toBe('')
})

test('回滚确认执行：确认「回滚」→ 文件恢复到已提交内容', async ({ page }) => {
  await enterProject(page)
  const headers = await unlockHeaders()
  await makeWorkingChange(page, headers)

  const dialog = await openRollbackConfirm(page)
  await dialog.locator('.n-dialog__action button').filter({ hasText: '回滚' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '已回滚' })).toBeVisible({ timeout: 5000 })
  // 仓库真实状态：文件回到已提交内容，工作区干净（refs/files 落盘在
  // Windows 文件层有可观测的短暂滞后 → poll 轮询而非单次读取）
  expect(fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')).toContain('v1')
  await expect.poll(async () => git(REPO_DIR, ['status', '--porcelain']), { timeout: 5000 }).toBe('')
})
