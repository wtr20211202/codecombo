import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目移除撤销（P-20261002-47）E2E：移除成功后的「已移除 {name}」toast 带 [撤销]
 * 按钮（6s 窗口）——点撤销按闭包暂存的 name/path 原路重新登记，卡片回来且 API
 * 列表恢复；不点撤销则超时自动消失、列表保持移除态。磁盘目录始终保留。
 * 覆盖两个移除入口：首页卡片（useHomeProjects）与项目页 TopBar → 确认弹窗
 * （RemoveConfirmModal）。toast 用 render 自绘（无 .n-message 内层），定位其
 * .n-message-wrapper 外层。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-remove-undo')
const PROJ = 'e2e-remove-undo'

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

async function listProjects(): Promise<Array<{ id: string; name: string }>> {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  return (list?.data || []) as Array<{ id: string; name: string }>
}

async function removeRegistrationByName() {
  const headers = await unlockHeaders()
  for (const p of await listProjects()) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

function undoToast(page: Page) {
  return page.locator('.n-message-wrapper').filter({ hasText: '已移除' })
}

test.beforeEach(async ({ request }) => {
  await removeRegistrationByName()
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'remove undo e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root'])
  const create = await request.post(`${API_BASE}/api/projects`, {
    // 注册路径按服务端形态交接（linux 实例经 /mnt/c 同见 %TEMP% 夹具）
    headers: await unlockHeaders(),
    data: { name: PROJ, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  expect(create.ok()).toBeTruthy()
})

test.afterEach(async () => {
  await removeRegistrationByName()
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 首页卡片 hover 出移除按钮 → 确认弹窗确认 → 卡片消失（toast 由用例接力） */
async function removeViaHomeCard(page: Page) {
  const card = page.locator('.project-card').filter({ hasText: PROJ })
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.project-remove-btn').click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: /删除|移除/ }).click()
  await expect(card).toBeHidden({ timeout: 5000 })
  return card
}

test('首页移除 → 撤销 toast 出现 → 点撤销卡片回来且 API 列表恢复', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const card = await removeViaHomeCard(page)

  // 撤销 toast：「已移除 {name}」文案 + [撤销] 按钮（6s 窗口内操作绰绰有余）
  const toast = undoToast(page)
  await expect(toast).toBeVisible({ timeout: 3000 })
  const undoBtn = toast.locator('[data-testid="project-undo-action"]')
  await expect(undoBtn).toBeVisible()
  await undoBtn.click()

  // 卡片回来（addProject 原路重新登记）+ API 列表恢复；磁盘目录始终保留
  await expect(card).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => (await listProjects()).some(p => p.name === PROJ), { timeout: 5000 }).toBe(true)
  expect(fs.existsSync(path.join(REPO_DIR, 'readme.md')), '磁盘目录应保留').toBe(true)
})

test('首页移除 → 不点撤销 → toast 超时消失，列表保持移除态', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await removeViaHomeCard(page)

  const toast = undoToast(page)
  await expect(toast).toBeVisible({ timeout: 3000 })
  // 6s 撤销窗口过后自动消失（含离场动画余量）
  await expect(toast).toBeHidden({ timeout: 10000 })
  expect((await listProjects()).some(p => p.name === PROJ)).toBe(false)
})

test('项目页 TopBar 移除 → 点撤销 → API 列表恢复且顶栏切回该项目', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // 进项目：首页卡片点击进入项目页
  await page.locator('.project-card').filter({ hasText: PROJ }).click()
  await expect(page.locator('.ide-header')).toBeVisible({ timeout: 5000 })

  // TopBar「更多操作」下拉 → 移除当前项目 → 确认弹窗
  await page.locator('.ide-header [title="更多操作"]').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '移除当前项目' }).click()
  const confirmDlg = page.locator('.n-dialog').filter({ hasText: PROJ })
  await expect(confirmDlg).toBeVisible({ timeout: 3000 })
  await confirmDlg.locator('.n-dialog__action button').filter({ hasText: /删除|移除/ }).click()

  const toast = undoToast(page)
  await expect(toast).toBeVisible({ timeout: 3000 })
  await toast.locator('[data-testid="project-undo-action"]').click()

  // 恢复后 addProject 会把 currentProjectId 切回新登记的项目，顶栏选择器应显示它
  await expect.poll(async () => (await listProjects()).some(p => p.name === PROJ), { timeout: 5000 }).toBe(true)
  await expect(page.locator('.ide-header .n-base-selection').filter({ hasText: PROJ })).toBeVisible({ timeout: 5000 })
})
