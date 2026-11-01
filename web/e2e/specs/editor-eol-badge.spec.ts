import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器行尾（EOL）徽标与切换 E2E（P-20261004-140）：CRLF 播种文件 → Breadcrumb
 * 徽标显 CRLF → 菜单转 LF → 显式 Ctrl+S → 磁盘字节换行符变化且 git diff
 * --ignore-cr-at-eol 无内容级伪变更 → undo 可回退（脏态消失、磁盘未动）。
 * 核心动机 = 跨平台/远程协作防行尾伪 diff：正常编辑 CRLF 文件必须保持行尾
 * （git diff 只有真实内容行，不整文件红绿）。EOL 转换链（pushEOL 落撤销栈 +
 * isEolChange 事件回写）为纯前端行为，自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-eol')
const PROJ = 'e2e-editor-eol'
// CRLF fixture：中文内容行 + CRLF 行尾（win 开发者常态）
const CRLF_FILE = 'crlf-legacy.txt'
const CRLF_LINES = ['中文首行', '第二行']
const CRLF_TEXT = CRLF_LINES.join('\r\n') + '\r\n'
const CRLF_BYTES = Buffer.from(CRLF_TEXT, 'utf8')
// LF fixture：Unix 行尾（远端 Linux 文件常态）
const LF_FILE = 'lf-unix.txt'
const LF_LINES = ['unix one', 'unix two']
const LF_BYTES = Buffer.from(LF_LINES.join('\n') + '\n', 'utf8')

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

/** 每用例自归一：磁盘 fixture 重写为初始行尾（转换用例会改写磁盘，--repeat 重跑不串） */
function seedFixtures() {
  fs.writeFileSync(path.join(REPO_DIR, CRLF_FILE), CRLF_BYTES)
  fs.writeFileSync(path.join(REPO_DIR, LF_FILE), LF_BYTES)
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
  // 行尾语义由文件字节本身决定：git 不做任何 eol 转换（双路径 + 转换断言都以字节为准）
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  seedFixtures()
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: EOL 徽标基线'])
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

/** 进项目并从文件树打开指定文件（编辑器就绪：monaco 渲染出内容） */
async function openFileInEditor(page: import('@playwright/test').Page, file: string, sample: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(sample, { timeout: 8000 })
}

/** 编辑器聚焦（键位 Ctrl+S / Ctrl+Z 的宿主是 monaco textarea） */
async function focusEditor(page: import('@playwright/test').Page) {
  await page.locator('.monaco-editor .view-lines').click()
}

test('CRLF 文件：徽标显 CRLF → 转 LF → Ctrl+S 磁盘字节换行符变化且无内容级伪变更', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, CRLF_FILE, '中文首行')

  // 徽标展示模型 EOL（createModel 按内容猜测行尾，CRLF 播种文件 → CRLF）
  const badge = page.locator('[data-testid="eol-badge"]')
  await expect(badge).toHaveText('CRLF')

  // 点击徽标弹小菜单：转 LF / 转 CRLF 两项，当前项 CRLF 打勾
  await badge.click()
  const menu = page.locator('[data-testid="eol-menu"]')
  await expect(menu).toBeVisible()
  await expect(menu.locator('[data-testid="eol-to-lf"]')).toContainText('转为 LF')
  await expect(menu.locator('[data-testid="eol-to-crlf"]')).toContainText('转为 CRLF')
  await expect(menu.locator('[data-testid="eol-to-crlf"]')).toHaveClass(/current/)
  await expect(menu.locator('[data-testid="eol-to-lf"]')).not.toHaveClass(/current/)

  // 转 LF：徽标即时翻转 + tab 出现脏点（转换即脏，显式 Ctrl+S 落盘）
  await menu.locator('[data-testid="eol-to-lf"]').click()
  await expect(badge).toHaveText('LF')
  await expect(menu).toHaveCount(0)
  await expect(page.locator('.tab-dot')).toBeVisible()

  await focusEditor(page)
  await page.keyboard.press('Control+s')
  // 磁盘字节已换行尾：\r\n 全部消失，内容行不变（换行符差异是转换的全部产出）
  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, CRLF_FILE)).includes('\r\n'), { timeout: 5000 })
    .toBe(false)
  expect(fs.readFileSync(path.join(REPO_DIR, CRLF_FILE)).equals(
    Buffer.from(CRLF_LINES.join('\n') + '\n', 'utf8'),
  )).toBe(true)
  // 内容级零伪变更：忽略行尾的 diff 为空；同时字节级确实变更是真实的
  expect(git(REPO_DIR, ['diff', '--ignore-cr-at-eol'])).toBe('')
  expect(git(REPO_DIR, ['status', '--porcelain'])).toContain(CRLF_FILE)
  // 保存回净态：脏点消失，徽标保持 LF
  await expect(page.locator('.tab-dot')).toHaveCount(0)
  await expect(badge).toHaveText('LF')
})

test('CRLF → LF 转换可 undo 回退：脏态消失、磁盘未动、徽标回 CRLF', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, CRLF_FILE, '中文首行')
  const badge = page.locator('[data-testid="eol-badge"]')
  await expect(badge).toHaveText('CRLF')

  await badge.click()
  await page.locator('[data-testid="eol-menu"] [data-testid="eol-to-lf"]').click()
  await expect(badge).toHaveText('LF')
  await expect(page.locator('.tab-dot')).toBeVisible()

  // undo 精确回退 EOL 转换（pushEOL 落撤销栈 + 前后 undo stop 独占元素）
  await focusEditor(page)
  await page.keyboard.press('Control+z')
  await expect(badge).toHaveText('CRLF')
  await expect(page.locator('.tab-dot')).toHaveCount(0)
  // 磁盘自始至终未被转换动作改动（显式保存语义）
  expect(fs.readFileSync(path.join(REPO_DIR, CRLF_FILE)).equals(CRLF_BYTES)).toBe(true)
})

test('LF 文件：徽标显 LF → 转 CRLF → Ctrl+S 磁盘字节变 CRLF（跨平台协作方向）', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, LF_FILE, 'unix one')
  const badge = page.locator('[data-testid="eol-badge"]')
  await expect(badge).toHaveText('LF')

  await badge.click()
  await page.locator('[data-testid="eol-menu"] [data-testid="eol-to-crlf"]').click()
  await expect(badge).toHaveText('CRLF')

  await focusEditor(page)
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, LF_FILE)).equals(Buffer.from(LF_LINES.join('\r\n') + '\r\n', 'utf8')), { timeout: 5000 })
    .toBe(true)
  expect(git(REPO_DIR, ['diff', '--ignore-cr-at-eol'])).toBe('')
})

test('CRLF 文件正常编辑保存保持行尾：git diff 只有真实内容行（防行尾伪 diff 动机面）', async ({ page }) => {
  seedFixtures()
  await openFileInEditor(page, CRLF_FILE, '中文首行')
  const badge = page.locator('[data-testid="eol-badge"]')
  await expect(badge).toHaveText('CRLF')

  // 「第二行」行尾追加新行（Enter 产生模型 EOL = CRLF——键入换行即行尾语义
  // 的直接证明）：磁盘行尾保持 CRLF，diff 只有真实内容行
  await focusEditor(page)
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('End')
  await page.keyboard.type('\n新增末行')
  await page.keyboard.press('Control+s')

  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, CRLF_FILE), 'utf8').includes('新增末行'), { timeout: 5000 })
    .toBe(true)
  // 键入的换行落盘为 CRLF：第二行 与 新增末行 之间即该次 Enter 的产出
  //（原拖尾空行保留为文末空行）
  expect(fs.readFileSync(path.join(REPO_DIR, CRLF_FILE)).equals(
    Buffer.from(CRLF_LINES.join('\r\n') + '\r\n新增末行\r\n', 'utf8'),
  )).toBe(true)
  // 行尾未被改写：普通 git diff 只有 1 行真实新增（拖尾空行配对删除不计），
  // 不整文件红绿（整文件 = 行数级行尾伪 diff，即本提案要消除的排查成本）。
  // autocrlf=false 下 diff 行自带文件行尾 \r，逐行剥除再断言
  const diff = git(REPO_DIR, ['diff'])
  const lines = diff.split('\n').map(l => l.replace(/\r$/, ''))
  const added = lines.filter(l => l.startsWith('+') && !l.startsWith('+++'))
  const removed = lines.filter(l => l.startsWith('-') && !l.startsWith('---'))
  expect(added).toEqual(['+新增末行'])
  expect(removed.length).toBeLessThanOrEqual(1)
})
