import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 右键复制路径 E2E（P-20261002-88）：
 *   ① 「复制路径」→ 剪贴板 = 项目相对路径（正斜杠）
 *   ② 「复制文件名」→ 剪贴板 = 路径末段
 *   ③ 「复制绝对路径」→ 剪贴板 = 项目根拼接（Windows 根出原生反斜杠）
 * 子目录文件使相对路径 ≠ 文件名（两断言可区分）。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-copy-path')
const PROJ = 'e2e-tab-copy-path'
const REL = 'sub/copy-target.txt'
const NAME = 'copy-target.txt'
const CONTENT = 'copy path target content'

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

/** 服务端存的项目根（= 前端 projectStore.currentProject.path 的来源），abs 断言用 */
async function fetchProjectPath(headers: Record<string, string>, id: string): Promise<string> {
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const mine = ((list?.data || []) as { id?: string; path?: string }[]).find(p => p.id === id)
  return mine?.path || ''
}

let projectId = ''
let projRoot = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.dirname(path.join(REPO_DIR, REL)), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, REL), CONTENT + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 复制路径基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
  projRoot = await fetchProjectPath(headers, projectId)
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

/** 进项目 → 文件树展开 sub/ 打开目标文件（子目录：tab 名为路径末段） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: 'sub' }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: 'sub' }).first().click() // 展开目录
  await page.locator('.file-tree .item-name', { hasText: NAME }).first().click() // click 自带等待展开
  await expect(page.locator('.editor-tab', { hasText: NAME })).toBeVisible()
}

/** tab 右键 → 点指定菜单项 → 剪贴板读回 */
async function copyViaContextMenu(page: import('@playwright/test').Page, itemName: string): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.editor-tab', { hasText: NAME }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: itemName }).click()
  return page.evaluate(() => navigator.clipboard.readText())
}

test('tab 右键复制路径/文件名：相对路径正斜杠 + 路径末段', async ({ page }) => {
  await openProjectAndFile(page)

  // 复制路径：项目相对路径，反斜杠归一为 /
  expect(await copyViaContextMenu(page, '复制路径')).toBe(REL)
  await expect(page.locator('.n-message').filter({ hasText: '路径已复制' })).toBeVisible({ timeout: 5000 })

  // 复制文件名：路径末段（子目录文件 ≠ 相对路径，两断言可区分）
  expect(await copyViaContextMenu(page, '复制文件名')).toBe(NAME)
  await expect(page.locator('.n-message').filter({ hasText: '文件名已复制' })).toBeVisible({ timeout: 5000 })
})

test('tab 右键复制绝对路径：项目根拼接（Windows 根出原生反斜杠）', async ({ page }) => {
  await openProjectAndFile(page)

  const root = projRoot.replace(/[\\/]+$/, '')
  expect(root, '服务端项目记录应含路径').not.toBe('')
  const sep = root.includes('\\') ? '\\' : '/'
  expect(await copyViaContextMenu(page, '复制绝对路径')).toBe(root + sep + REL.replace(/\//g, sep))
  await expect(page.locator('.n-message').filter({ hasText: '绝对路径已复制' })).toBeVisible({ timeout: 5000 })
})
