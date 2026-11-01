import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 全部保存（P-20261002-101）E2E：
 *   ① 三个文件各自编辑 → Ctrl+Alt+S → toast 汇总「已保存 3 个文件」+ 三文件落盘
 *   ② 命令面板「全部保存」命令同效（命令入口）
 *   ③ 分屏双组各一脏文件 → 快捷键 → 两组文件都落盘（getUnsavedFiles 覆盖双组）
 * 自备临时仓库，afterAll 清理（含 git checkout 还原）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-save-all')
const PROJ = 'e2e-save-all'
const FILES = [
  { name: 'save-all-a.txt', content: 'save all alpha\n' },
  { name: 'save-all-b.txt', content: 'save all beta\n' },
  { name: 'save-all-c.txt', content: 'save all gamma\n' },
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
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 全部保存基线'])
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

/** 打开项目并经文件树打开全部 3 个文件（幂等：已开的只会被激活） */
async function openProjectAndAllFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name })).toBeVisible()
}

/** 在指定窗格的活跃编辑器末尾键入一行标记（点击定位行尾 → End → 回车 → 输入） */
async function appendLineInPane(page: import('@playwright/test').Page, pane: '.pane-primary' | '.pane-split', mark: string) {
  await page.locator(`${pane} .monaco-editor .view-lines`).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(mark)
  await expect(page.locator(`${pane} .monaco-editor .view-lines`)).toContainText(mark)
}

test('三个文件各自编辑 → Ctrl+Alt+S 全部保存：toast 汇总 + 三文件落盘', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 逐 tab 编辑三个文件（共享一组，切 tab 后同一编辑器换挂内容）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await appendLineInPane(page, '.pane-primary', 'appended-save-all-a')
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click()
  await appendLineInPane(page, '.pane-primary', 'appended-save-all-b')
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name }).click()
  await appendLineInPane(page, '.pane-primary', 'appended-save-all-c')

  // Ctrl+Alt+S 全部保存（焦点在 Monaco 隐藏输入区：inputarea 属编辑器本体放行）
  await page.keyboard.press('Control+Alt+s')
  await expect(page.locator('.n-message').filter({ hasText: '已保存 3 个文件' })).toBeVisible({ timeout: 8000 })

  // 三文件落盘（轮询：串行保存请求逐个异步落盘）
  for (const [i, mark] of ['appended-save-all-a', 'appended-save-all-b', 'appended-save-all-c'].entries()) {
    await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILES[i]!.name), 'utf8'), { timeout: 8000 })
      .toContain(mark)
  }
  const status = git(REPO_DIR, ['status', '--porcelain'])
  expect(status).toContain('save-all-a.txt')
  expect(status).toContain('save-all-b.txt')
  expect(status).toContain('save-all-c.txt')
})

test('命令面板「全部保存」命令同效落盘', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 只脏一个文件：本用例聚焦命令入口，落盘数 = 1
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await appendLineInPane(page, '.pane-primary', 'appended-palette-save')

  // 焦点移出 Monaco（Monaco 会吞 Ctrl+K 弦）→ 命令面板 → 命令模式检索
  await page.locator('.editor-tabs').first().click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>全部保存')
  const item = page.locator('.palette-item').filter({ hasText: '全部保存' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect(page.locator('.n-message').filter({ hasText: '已保存 1 个文件' })).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILES[0]!.name), 'utf8'), { timeout: 8000 })
    .toContain('appended-palette-save')
})

test('分屏双组各一脏文件 → Ctrl+Alt+S：两组文件都落盘', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 归零到 [a, b]：关掉可能残留的第三个标签（前序用例遗留）
  while (await page.locator('.pane-primary .editor-tab').count() > 2) {
    await page.locator('.pane-primary .editor-tab').last().locator('.tab-close').click()
    await page.waitForTimeout(200)
  }
  // 若上次会话恢复出分屏（空态占位或带文件），先关闭归到单组
  if (await page.locator('.pane-split').isVisible().catch(() => false)) {
    const emptyClose = page.locator('.split-empty-close')
    if (await emptyClose.isVisible().catch(() => false)) {
      await emptyClose.click()
    } else {
      await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '关闭分屏' }).click()
    }
    await expect(page.locator('.pane-split')).toHaveCount(0)
  }

  // 右键 b → 在右侧分屏打开：b 开进分屏组（与主组共享对象）
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })

  // 分屏组编辑 b，主组编辑 a：两组各一脏文件
  await appendLineInPane(page, '.pane-split', 'appended-split-b')
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click()
  await appendLineInPane(page, '.pane-primary', 'appended-split-a')

  // Ctrl+Alt+S：getUnsavedFiles 覆盖双组，汇总 = 2
  await page.keyboard.press('Control+Alt+s')
  await expect(page.locator('.n-message').filter({ hasText: '已保存 2 个文件' })).toBeVisible({ timeout: 8000 })

  for (const [name, mark] of [[FILES[0]!.name, 'appended-split-a'], [FILES[1]!.name, 'appended-split-b']] as const) {
    await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, name), 'utf8'), { timeout: 8000 })
      .toContain(mark)
  }
})
