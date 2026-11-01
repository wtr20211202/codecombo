import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器自动保存档位 E2E（P-20261002-129，files.autoSave）：
 *   ① afterDelay 档：键入停手 autoSaveDelayMs 后自动走既有保存链落盘（磁盘生效、
 *      无需 Ctrl+S）；
 *   ② off 档（默认）：键入后超延时磁盘不动，仅手动保存生效——存量行为不变；
 *   ③ 409 冲突熔断：外部改写磁盘后自动保存触发 409，弹既有三选对话框交用户裁决；
 *      熔断生效——继续键入不再自动重试（对话框不连弹、磁盘不被自动覆盖）。
 * 自备临时仓库，afterAll 清理（含 git checkout 还原）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-autosave')
const PROJ = 'e2e-editor-autosave'
const FILE = 'autosave-target.txt'
const ORIGINAL = 'autosave e2e baseline line1\n'
const APPEND_AUTO = 'appended-by-autosave'
const APPEND_MANUAL = 'appended-while-autosave-off'
const APPEND_CONFLICT = 'appended-before-conflict'
const APPEND_RESUME = 'resumed-after-overwrite'
const AGENT_LINE = 'external-agent-override'

function filePath(file: string): string {
  return path.join(REPO_DIR, file)
}

function diskContent(file: string): string {
  return fs.readFileSync(filePath(file), 'utf8')
}

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
  fs.writeFileSync(filePath(FILE), ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 编辑器自动保存基线'])
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

/** 打开项目并经文件树打开目标文件（幂等：已开只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('autosave e2e baseline', { timeout: 8000 })
}

/** 打开设置 → 外观分区，把「自动保存」档位切到指定档（off / afterDelay） */
async function setAutoSaveMode(page: import('@playwright/test').Page, mode: 'off' | 'afterDelay') {
  const optionText = mode === 'afterDelay' ? '延时自动保存' : '关闭'
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不再依赖导航序下标
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('.settings-content .slider-row', { hasText: '自动保存' })
  await expect(row).toBeVisible({ timeout: 3000 })
  await row.locator('.n-select').click()
  await page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: optionText }).click()
  // 档位写入 font-settings 即时生效（编辑器行为类选项直写 store）
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { autoSave?: string } }).editor?.autoSave).toBe(mode)
  if (mode === 'afterDelay') {
    // 顺带演练停手延时输入绑定（仅 afterDelay 档显示）：500ms 加速后续停手判定
    const delayRow = page.locator('.settings-content .slider-row', { hasText: '停手延时' })
    await expect(delayRow).toBeVisible({ timeout: 3000 })
    await delayRow.locator('input').fill('500')
    await page.keyboard.press('Enter')
    const savedDelay = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
    expect((savedDelay as { editor?: { autoSaveDelayMs?: number } }).editor?.autoSaveDelayMs).toBe(500)
  }
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
}

test('afterDelay 档：键入停手后自动落盘，无需 Ctrl+S', async ({ page }) => {
  await openProjectAndFile(page)
  await setAutoSaveMode(page, 'afterDelay')

  // 键入追加一行后停手（延时默认 1000ms，防抖尾沿到点即自动保存）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND_AUTO)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND_AUTO)

  // 磁盘生效（轮询：防抖到点 + 写请求异步落盘；全程未按 Ctrl+S）
  await expect.poll(() => diskContent(FILE), { timeout: 8000 }).toContain(APPEND_AUTO)

  // 自动保存走既有保存链：保存成功不再弹「文件已保存」toast（静默口径）
  await expect(page.locator('.n-message')).toHaveCount(0)
})

test('off 档（默认）：键入后超延时磁盘不动，仅手动保存生效', async ({ page }) => {
  await openProjectAndFile(page)
  // 全新浏览器上下文 localStorage 为空 = 默认 off，无需设置操作（存量行为不变）

  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND_MANUAL)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND_MANUAL)

  // 超过自动保存延时（>1s 取 2s 裕量）磁盘仍无该行：off 档不自动落盘
  await page.waitForTimeout(2000)
  expect(diskContent(FILE)).not.toContain(APPEND_MANUAL)

  // 手动保存照常生效
  await page.keyboard.press('Control+s')
  await expect.poll(() => diskContent(FILE), { timeout: 5000 }).toContain(APPEND_MANUAL)
})

test('afterDelay 档遇 409：弹冲突对话框裁决不自动覆盖；裁决解除后自动保存恢复', async ({ page }) => {
  await openProjectAndFile(page)
  await setAutoSaveMode(page, 'afterDelay')

  // 先键入（排程自动保存）再外部改写磁盘——真实冲突时序（agent 改盘）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND_CONFLICT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(APPEND_CONFLICT)
  fs.writeFileSync(filePath(FILE), `${AGENT_LINE}\n`)

  // 停手到点自动保存：baseHash 冲突 → 409 → 三选对话框（不自动覆盖）
  const dialog = page.locator('.n-dialog').filter({ hasText: '文件已被外部修改' })
  await expect(dialog).toBeVisible({ timeout: 8000 })
  expect(diskContent(FILE)).toBe(`${AGENT_LINE}\n`)

  // 用户裁决 [覆盖保存]：force 直写落盘，冲突解除（基线刷新，熔断解除）
  await dialog.locator('button').filter({ hasText: '覆盖保存' }).click()
  await expect.poll(() => diskContent(FILE), { timeout: 5000 }).toContain(APPEND_CONFLICT)
  await expect(dialog).toHaveCount(0)

  // 冲突解除后继续键入：自动保存恢复工作（不再弹冲突对话框）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(APPEND_RESUME)
  await expect.poll(() => diskContent(FILE), { timeout: 8000 }).toContain(APPEND_RESUME)
  await expect(page.locator('.n-dialog').filter({ hasText: '文件已被外部修改' })).toHaveCount(0)
})
