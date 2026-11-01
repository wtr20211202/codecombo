import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器标签页批量管理 E2E（EditorArea 右键菜单此前零覆盖）：
 * 打开 4 个文件 → 右键 tab → 关闭其他 / 关闭右侧 / 全部关闭。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-manage')
const PROJ = 'e2e-tab-manage'
const FILES = ['tab-a.txt', 'tab-b.txt', 'tab-c.txt', 'tab-d.txt']

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
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
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f), `content of ${f}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 标签管理基线'])
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
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function enterAndOpenAll(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0] }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f }).first().click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('.editor-tab')).toHaveCount(4)
}

test('关闭其他：右键 tab → 仅保留该标签', async ({ page }) => {
  await enterAndOpenAll(page)

  await page.locator('.editor-tab').filter({ hasText: FILES[0] }).click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: '关闭其他' }).click()
  await page.waitForTimeout(600)

  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.editor-tab')).toContainText(FILES[0])
})

test('关闭右侧：右键第 2 个 tab → 右侧两个消失', async ({ page }) => {
  await enterAndOpenAll(page)

  await page.locator('.editor-tab').filter({ hasText: FILES[1] }).click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: '关闭右侧' }).click()
  await page.waitForTimeout(600)

  await expect(page.locator('.editor-tab')).toHaveCount(2)
  await expect(page.locator('.editor-tab').filter({ hasText: FILES[0] })).toBeVisible()
  await expect(page.locator('.editor-tab').filter({ hasText: FILES[1] })).toBeVisible()
  await expect(page.locator('.editor-tab').filter({ hasText: FILES[2] })).toHaveCount(0)
})

test('全部关闭：右键 tab → 全部关闭 → 回到欢迎态', async ({ page }) => {
  await enterAndOpenAll(page)

  await page.locator('.editor-tab').first().click({ button: 'right' })
  await page.getByRole('menuitem').filter({ hasText: '关闭全部' }).click()
  await page.waitForTimeout(600)

  await expect(page.locator('.editor-tab')).toHaveCount(0)
  // 欢迎面板回归
  await expect(page.getByText('Codecombo').first()).toBeVisible()
})
