import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树右键「在分屏打开」（P-20261003-321）E2E：
 *   ① 树右键文件 → 在分屏打开 → 分屏组出现该文件且激活（免「先开再 tab 右键」两步）
 *   ② 已分屏时再树右键另一文件 → 直接进分屏组并激活（openInSplit 既有链路，
 *      openFileInto(1)）
 *   ③ 主组不被波及：树右键分屏打开只落分屏组，主组不新增该文件签
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tree-split')
const PROJ = 'e2e-tree-split'
const FILES = [
  { name: 'tree-split-a.txt', content: 'tree split alpha content' },
  { name: 'tree-split-b.txt', content: 'tree split beta content' },
]

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 树右键分屏基线'])
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

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 打开项目并确认树可见（rail「项目文件」是 toggle——循环保证最终打开） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await itemByName(page, FILES[0]!.name).isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

/** 若上次会话恢复出分屏（空态占位或带文件），先一键关闭归到单组（editor-split 同款） */
async function ensureSplitClosed(page: Page) {
  if (!(await page.locator('.pane-split').isVisible().catch(() => false))) return
  const emptyClose = page.locator('.split-empty-close')
  if (await emptyClose.isVisible().catch(() => false)) {
    await emptyClose.click()
  } else {
    await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '关闭分屏' }).click()
  }
  await expect(page.locator('.pane-split')).toHaveCount(0)
}

/** 树右键目标文件 → 菜单「在分屏打开」（P-20261003-321 新入口）。
 *  树菜单选项无 menuitem role（naive-ui 该形态不落 role，实测 OPT role=null），
 *  与 file-tree-context 同款按 label 文本定位，不走 getByRole */
async function treeOpenInSplit(page: Page, name: string) {
  const item = itemByName(page, name)
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('在分屏打开', { exact: true }).click()
}

test('树右键「在分屏打开」：分屏组出现该文件且激活，主组不被波及', async ({ page }) => {
  await enterProject(page)
  await ensureSplitClosed(page)

  // 未经单击打开，直接树右键 → 分屏组自动开 + 该文件激活（openInSplit 链路）
  await treeOpenInSplit(page, FILES[0]!.name)
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-split')).toHaveClass(/pane-active/) // 打开即切活跃组
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })

  // 主组不被波及：树右键分屏打开只落分屏组，主组不新增该文件签
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveCount(0)
})

test('已分屏时树右键另一文件：直接进分屏组并激活', async ({ page }) => {
  await enterProject(page)
  await ensureSplitClosed(page)

  // 先经树右键开 a 进分屏组，再树右键 b：分屏组两签、b 激活
  await treeOpenInSplit(page, FILES[0]!.name)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()
  await treeOpenInSplit(page, FILES[1]!.name)
  await expect(page.locator('.pane-split .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })

  // 主组两次都不新增签（对照阅读从树发起不污染主组打开集）
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toHaveCount(0)
})
