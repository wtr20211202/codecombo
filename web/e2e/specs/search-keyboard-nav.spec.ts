import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索面板命中遍历键位 E2E（P-20261006-23）：替换前走查的键盘流。
 * ① ↓/Enter/Shift+Enter 结果列表导航（Enter 开当前命中、Shift+Enter 反向开
 *    上一命中，开 = 面板关 + 编辑器落到对应文件行）；
 * ② F3/Shift+F3 面板态全局跳下/上一命中（窗口级监听，面板保持开启连续走查，
 *    末行钳住不越界）；
 * ③ 折叠行按需展开（命中越过 30 行折叠线渲染出活动行，ps-more 计数同步）+
 *    活动行滚动跟随 + 键位提示行。
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。命中行序在后端
 * rg（逐处）与 git grep（逐行）间可能不同——行断言一律先读活动行文本再对
 * 编辑器/面板态断言，不写死文件序；组内行序两后端一致（升序）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-kbd-nav')
const PROJ = 'e2e-search-kbd-nav'

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
  // *.md 两文件各 1 命中（↓/Shift+Enter 走查面，行序后端无关——内容可鉴别）；
  // c.txt 40 行逐行 1 命中（折叠线展开 + 滚动跟随面，单组行序两后端一致）
  fs.writeFileSync(path.join(REPO_DIR, 'a.md'), 'foo alpha\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.md'), 'foo beta\n')
  fs.writeFileSync(path.join(REPO_DIR, 'c.txt'), Array.from({ length: 40 }, (_, i) => `foo ${String(i + 1).padStart(2, '0')}`).join('\n') + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 键盘走查基线'])
  await registerProject(headers, PROJ, REPO_DIR)
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

async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

async function searchPanel(page: import('@playwright/test').Page, query: string, glob: string) {
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  if (glob) await card.locator('.ps-glob input').fill(glob)
  await card.locator('input').first().fill(query)
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 30000 })
  return card
}

/** 活动行内容（剥行号）：断言「打开的命中 = 活动行」用，行序后端无关 */
async function activeRowContent(card: ReturnType<typeof import('@playwright/test').Locator>): Promise<string> {
  const text = await card.locator('.ps-line.is-active').textContent() || ''
  return text.replace(/^\s*\d+/, '').trim()
}

test('结果列表走查：↓ 逐命中移动，Shift+Enter 反向打开上一命中，Enter 打开活动命中', async ({ page }) => {
  await openProject(page)
  const card = await searchPanel(page, 'foo', '*.md')

  // 键位提示行随结果出现
  await expect(card.getByTestId('ps-kbd-hint')).toBeVisible()

  // ↓ 高亮首个命中（恰好一行活动），↓ 移到下一命中
  await card.locator('input').first().press('ArrowDown')
  await expect(card.locator('.ps-line.is-active')).toHaveCount(1, { timeout: 3000 })
  const first = await activeRowContent(card)
  await card.locator('input').first().press('ArrowDown')
  await expect(card.locator('.ps-line.is-active')).toHaveCount(1)
  const second = await activeRowContent(card)
  expect(second).not.toEqual(first)

  // Shift+Enter 反向：打开上一命中（= 第一个活动过的行），面板关 + 编辑器落文件
  await card.locator('input').first().press('Shift+Enter')
  await expect(card).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(first, { timeout: 8000 })

  // 重开面板：Enter 打开活动命中（↓ 后即活动行）
  const card2 = await searchPanel(page, 'foo', '*.md')
  await card2.locator('input').first().press('ArrowDown')
  await expect(card2.locator('.ps-line.is-active')).toHaveCount(1, { timeout: 3000 })
  await card2.locator('input').first().press('Enter')
  await expect(card2).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 8000 })
})

test('F3/Shift+F3 面板态全局跳转：焦点在输入框外仍走查，面板保持开启，末行钳住', async ({ page }) => {
  await openProject(page)
  const card = await searchPanel(page, 'foo', '*.md')

  // 焦点移出输入框（blur 收起历史下拉，同 search-replace 惯例）：F3 走窗口级监听
  await card.locator('input').first().blur()
  await page.keyboard.press('F3')
  await expect(card.locator('.ps-line.is-active')).toHaveCount(1, { timeout: 3000 })
  const first = await activeRowContent(card)

  await page.keyboard.press('F3')
  const second = await activeRowContent(card)
  expect(second).not.toEqual(first)

  // 末行钳住：再按不越界（活动行不变，clamp 不回绕）
  await page.keyboard.press('F3')
  expect(await activeRowContent(card)).toEqual(second)

  // Shift+F3 反向退回上一命中
  await page.keyboard.press('Shift+F3')
  expect(await activeRowContent(card)).toEqual(first)

  // F3 只移动高亮不打开：面板全程保持开启（连续走查）
  await expect(card).toBeVisible()
})

test('折叠行按需展开 + 滚动跟随：走查越过折叠线渲染出活动行并滚入可视区', async ({ page }) => {
  await openProject(page)
  const card = await searchPanel(page, 'foo', '*.txt')

  // 单组 40 命中：初始 30 行折叠线，+10 更多
  await expect(card.locator('.ps-line')).toHaveCount(30)
  await expect(card.locator('.ps-more').first()).toContainText('+10')

  // F3 ×31：活动命中越过折叠线，渲染上限抬到活动行为止（31 行），余量 -1
  for (let i = 0; i < 31; i++) await page.keyboard.press('F3')
  await expect(card.locator('.ps-line.is-active')).toContainText('foo 31', { timeout: 3000 })
  await expect(card.locator('.ps-line')).toHaveCount(31)
  await expect(card.locator('.ps-more').first()).toContainText('+9')

  // 滚动跟随：活动行滚入 .ps-results 可视区（nextTick 落定后取几何）
  await page.waitForTimeout(200)
  const inView = await card.locator('.ps-results').evaluate((el) => {
    const active = el.querySelector('.ps-line.is-active')
    if (!active) return false
    const box = el.getBoundingClientRect()
    const r = active.getBoundingClientRect()
    return r.top >= box.top - 1 && r.bottom <= box.bottom + 1
  })
  expect(inView).toBe(true)
})
