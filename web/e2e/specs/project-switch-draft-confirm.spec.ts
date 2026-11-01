import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 切项目丢弃草稿的确认 E2E（P-20261003-105）：有未保存内容的草稿（文件脏 tab /
 * untitled 草稿）时经顶栏选择器切项目 → 确认弹窗「有 N 份未保存的草稿」——
 * 取消留在原项目且草稿原样；确认则切换并清空打开集；干净态直接切不弹窗。
 * 自备双临时仓库，afterAll 清理（含 uiState 复位防残留串扰后续 spec）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-switch-draft-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-switch-draft-b')
const PROJ_A = 'e2e-switch-draft-a'
const PROJ_B = 'e2e-switch-draft-b'
const SEED_FILE = 'seed.txt'
const DIRTY_TEXT = 'unsaved before switching project'

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
}

function makeRepo(dir: string, commitMsg: string) {
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, SEED_FILE), 'seed line\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', commitMsg])
}

async function cleanupProjects(headers: Record<string, string>) {
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await cleanupProjects(headers)
  makeRepo(REPO_A, 'root: 切项目草稿确认 A')
  makeRepo(REPO_B, 'root: 切项目草稿确认 B')
  await registerProject(headers, PROJ_A, REPO_A)
  await registerProject(headers, PROJ_B, REPO_B)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await cleanupProjects(headers)
  try { fs.rmSync(REPO_A, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(REPO_B, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 复位：本 spec 留下的打开集/项目指向不得串扰后续 spec 的恢复链
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

/** 进入指定项目页 */
async function enterProject(page: import('@playwright/test').Page, name: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: name }).first().click()
  await page.waitForURL('**/project')
}

/** 顶栏选择器切到目标项目（点选后由调用方断言落点/弹窗） */
async function pickProject(page: import('@playwright/test').Page, name: string) {
  await page.locator('.header-project-select').click()
  const menu = page.locator('.n-base-select-menu')
  await expect(menu).toBeVisible({ timeout: 5000 })
  await menu.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

/** 进入项目并打开 seed.txt 打出脏内容 */
async function enterWithDirtySeed(page: import('@playwright/test').Page) {
  await enterProject(page, PROJ_A)
  await page.locator('.file-tree .item-name', { hasText: SEED_FILE }).first().click()
  const tab = page.locator('.editor-tab').filter({ hasText: SEED_FILE }).first()
  await expect(tab).toBeVisible({ timeout: 8000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.type(DIRTY_TEXT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DIRTY_TEXT)
  await expect(tab.locator('.tab-dot')).toBeVisible()
}

test('有内容草稿切项目：确认弹窗出现，取消留在原项目且草稿原样', async ({ page }) => {
  await enterWithDirtySeed(page)

  // 切到 B → 守卫弹窗（标题 + N 计数）
  await pickProject(page, PROJ_B)
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('切换项目')
  await expect(dialog).toContainText('1 份未保存的草稿')

  // 取消：留在 A，脏 tab 与内容原样
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.header-project-select')).toContainText(PROJ_A)
  const tab = page.locator('.editor-tab').filter({ hasText: SEED_FILE }).first()
  await expect(tab).toBeVisible()
  await expect(tab.locator('.tab-dot')).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DIRTY_TEXT)
})

test('确认丢弃后切换：落 B 且打开集清空；切回干净 A 不再弹窗', async ({ page }) => {
  await enterWithDirtySeed(page)

  // 确认切换 → 落 B，A 的打开集清空
  await pickProject(page, PROJ_B)
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await dialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.header-project-select')).toContainText(PROJ_B, { timeout: 5000 })
  await expect(page.locator('.editor-tab')).toHaveCount(0)

  // B 无脏 → 切回 A 直接切（无确认弹窗）
  await pickProject(page, PROJ_A)
  await expect(page.locator('.header-project-select')).toContainText(PROJ_A, { timeout: 5000 })
  await expect(page.locator('.n-dialog')).toHaveCount(0)
})

test('untitled 草稿计入确认：取消后草稿 tab 保留', async ({ page }) => {
  await enterProject(page, PROJ_A)

  // Ctrl+Alt+N 新建草稿（bootstrap 期间监听可能未挂载，重试兜底同 untitled-draft.spec）
  const draftTab = page.locator('.editor-tab').filter({ hasText: '草稿' }).first()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('Control+Alt+n')
    try {
      await expect(draftTab).toBeVisible({ timeout: 2000 })
      break
    } catch { /* 监听未挂载，重试 */ }
  }
  await expect(draftTab).toBeVisible({ timeout: 5000 })
  await page.locator('.monaco-editor').click()
  await page.keyboard.type(DIRTY_TEXT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DIRTY_TEXT)

  // 切项目 → 确认弹窗计入草稿 → 取消：草稿 tab 与内容保留
  await pickProject(page, PROJ_B)
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 5000 })
  await expect(dialog).toContainText('1 份未保存的草稿')
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('.header-project-select')).toContainText(PROJ_A)
  await expect(draftTab).toBeVisible()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(DIRTY_TEXT)
})
