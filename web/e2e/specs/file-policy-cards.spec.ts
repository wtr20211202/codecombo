import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件策略元信息卡 E2E（perf-report 落地特性的 UX 覆盖）：
 *   - >10MB 文本文件 → 413 + 元信息卡「文件过大，已停止内容预览」（全文不进编辑器）
 *   - 二进制类型（.zip 扩展名命中清单）→ 415 + 元信息卡「二进制文件」
 * 自备临时仓库，afterAll 清理（范式与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-file-policy')
const PROJ = 'e2e-file-policy'
const BIG_TEXT = 'big.txt'
const BINARY = 'archive.zip'
const TOO_LARGE_TEXT = '该文件大小为'

let projectId = ''

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // 正常小文件入库（保证树可渲染）；超大文本与二进制留在工作区未跟踪
  fs.writeFileSync(path.join(REPO_DIR, 'readme.md'), 'file policy e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: file policy 基线'])
  // 11MB 文本（> 10MB 阈值 → too-large）
  const chunk = `${'x'.repeat(1023)}\n`
  const fd = fs.openSync(path.join(REPO_DIR, BIG_TEXT), 'w')
  for (let i = 0; i < 11 * 1024; i++) fs.writeSync(fd, chunk)
  fs.closeSync(fd)
  // 二进制：.zip 扩展名命中 filepolicy 扩展名清单
  fs.writeFileSync(path.join(REPO_DIR, BINARY), Buffer.from([0x50, 0x4b, 0x03, 0x04, ...Buffer.alloc(64 * 1024, 0)]))
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

async function enterAndShowTree(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.file-tree .item-name').first()).toBeVisible()
}

test('超大文本：打开 11MB 文本 → 元信息卡而非全文加载', async ({ page }) => {
  await enterAndShowTree(page)
  const item = page.locator('.file-tree .item-name', { hasText: BIG_TEXT }).first()
  await item.click()
  const card = page.locator('.file-meta-card')
  await expect(card).toBeVisible({ timeout: 8000 })
  await expect(card).toContainText('文件过大，已停止内容预览')
  await expect(card).toContainText(TOO_LARGE_TEXT)
  // 全文未加载：编辑器里不应出现该文件的首行内容
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
})

test('二进制文件：打开 .zip → 二进制元信息卡', async ({ page }) => {
  await enterAndShowTree(page)
  const item = page.locator('.file-tree .item-name', { hasText: BINARY }).first()
  await item.click()
  const card = page.locator('.file-meta-card')
  await expect(card).toBeVisible({ timeout: 8000 })
  await expect(card).toContainText('二进制文件')
  await expect(page.locator('.monaco-editor')).toHaveCount(0)
})
