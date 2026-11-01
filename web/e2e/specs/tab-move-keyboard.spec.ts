import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 键盘重排 E2E（P-20261005-201）：Alt+Shift+←/→ 在活跃组内移动
 * 当前标签（拖拽重排的键盘对位，组内不越界、到头静默停）——
 *   ① 激活尾签 Alt+Shift+→（到头静默停）→ Alt+Shift+← 依序前移
 *   ② 激活首签 Alt+Shift+←（到头静默停）→ Alt+Shift+→ 依序后移
 *   ③ 快捷键备忘单编辑器组条目（键帽取 keymap 实时生效值）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-move-keyboard')
const PROJ = 'e2e-tab-move-keyboard'
const FILES = [
  { name: 'move-a.txt', content: 'move alpha content' },
  { name: 'move-b.txt', content: 'move beta content' },
  { name: 'move-c.txt', content: 'move gamma content' },
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
  git(REPO_DIR, ['commit', '-m', 'root: tab 键盘重排基线'])
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

/** 打开项目并经文件树按序打开全部 3 个文件（幂等：已开的只会被激活） */
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
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toBeVisible()
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
}

/** 组内标签名序（.tab-name 顺序 = 打开顺序，编辑器 tab 顺序的断言面） */
async function tabOrder(page: import('@playwright/test').Page): Promise<string[]> {
  return page.locator('.editor-tab .tab-name').allTextContents()
}

test('Alt+Shift+←/→ 活跃组内移动标签：到头静默停、依序前移', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // 打开序 a,b,c 激活 c；点尾签把焦点移出 Monaco 隐藏 textarea（同 linear-switch
  // spec 惯例：全局键不在 Monaco 隐藏输入区上断言）
  await page.locator('.editor-tab', { hasText: FILES[2]!.name }).click()

  // 尾签 c：Alt+Shift+→ 到头静默停（顺序不变）
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
  expect(await tabOrder(page)).toEqual(FILES.map(f => f.name))

  // Alt+Shift+← 依序前移：c 越过 b、再越过 a（c 保持激活）
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  await expect(page.locator('.editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
  expect(await tabOrder(page)).toEqual([FILES[0]!.name, FILES[2]!.name, FILES[1]!.name])
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  expect(await tabOrder(page)).toEqual([FILES[2]!.name, FILES[0]!.name, FILES[1]!.name])

  // 首签 c：Alt+Shift+← 到头静默停（不环绕、不越组）
  await page.keyboard.press('Alt+Shift+ArrowLeft')
  expect(await tabOrder(page)).toEqual([FILES[2]!.name, FILES[0]!.name, FILES[1]!.name])
})

test('Alt+Shift+→ 首签依序后移：移动后即时可见', async ({ page }) => {
  await openProjectAndAllFiles(page)

  await page.locator('.editor-tab', { hasText: FILES[0]!.name }).click()

  // 首签 a：Alt+Shift+→ 依序后移（a 保持激活）
  await page.keyboard.press('Alt+Shift+ArrowRight')
  await expect(page.locator('.editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  expect(await tabOrder(page)).toEqual([FILES[1]!.name, FILES[0]!.name, FILES[2]!.name])
  await page.keyboard.press('Alt+Shift+ArrowRight')
  expect(await tabOrder(page)).toEqual([FILES[1]!.name, FILES[2]!.name, FILES[0]!.name])

  // 尾签 a：再后移静默停
  await page.keyboard.press('Alt+Shift+ArrowRight')
  expect(await tabOrder(page)).toEqual([FILES[1]!.name, FILES[2]!.name, FILES[0]!.name])
})

test('快捷键备忘单：编辑器组移动标签条目展示键帽', async ({ page }) => {
  await openProjectAndAllFiles(page)

  // ? 单键不对输入框焦点响应：先点标签移出 Monaco 隐藏 textarea
  await page.locator('.editor-tab', { hasText: FILES[0]!.name }).click()
  await page.keyboard.press('?')

  const prevRow = page.locator('.sc-help-row').filter({ hasText: '左移当前标签' })
  await expect(prevRow).toBeVisible()
  await expect(prevRow.locator('kbd')).toHaveText(['Alt', 'Shift', '←'])
  const nextRow = page.locator('.sc-help-row').filter({ hasText: '右移当前标签' })
  await expect(nextRow).toBeVisible()
  await expect(nextRow.locator('kbd')).toHaveText(['Alt', 'Shift', '→'])

  await page.locator('.sc-help-close').click()
})
