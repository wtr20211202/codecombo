import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 tab 类型色点 E2E（P-20261002-147）：打开 .ts/.md 两个文件 →
 *   ① tab 色点与文件树同类型色点 background 一致（两面板同色系）
 *   ② 不同类型的色点颜色互异（真按扩展名取色而非统一色）
 *   ③ 无扩展名文件走回退色，tab 与树仍一致
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-type-dot')
const PROJ = 'e2e-tab-type-dot'
const TS_FILE = 'alpha.ts'
const MD_FILE = 'readme.md'
const NOEXT_FILE = 'Makefile'

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
  execFileSync('git', ['config', 'user.name', 'e2e'])
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, TS_FILE), 'export const alpha = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, MD_FILE), '# readme\n')
  fs.writeFileSync(path.join(REPO_DIR, NOEXT_FILE), 'all:\n\techo hi\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 类型色点基线'])
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

/** 打开项目并经文件树打开指定文件成 tab，返回取色函数：
 *  treeColor/tabColor 分别读文件树行色点与 tab 色点的计算 background */
async function openProjectAndFiles(page: import('@playwright/test').Page, names: string[]) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: names[0]! }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const n of names) {
    await page.locator('.file-tree .item-name', { hasText: n }).first().click()
    await expect(page.locator('.editor-tab', { hasText: n })).toBeVisible()
  }
  const treeColor = (name: string) =>
    page.locator('.file-tree .tree-item', { hasText: name }).locator('.file-icon-dot')
      .evaluate(el => getComputedStyle(el).backgroundColor)
  const tabColor = (name: string) =>
    page.locator('.editor-tab', { hasText: name }).locator('.tab-type-dot')
      .evaluate(el => getComputedStyle(el).backgroundColor)
  return { treeColor, tabColor }
}

test('.ts/.md 的 tab 色点与文件树同色，且类型间互异', async ({ page }) => {
  const { treeColor, tabColor } = await openProjectAndFiles(page, [TS_FILE, MD_FILE])

  // tab 色点与树同类型色点完全同色（同色系的核心断言）
  expect(await tabColor(TS_FILE)).toBe(await treeColor(TS_FILE))
  expect(await tabColor(MD_FILE)).toBe(await treeColor(MD_FILE))

  // 类型间互异：色点真按扩展名取色（防两边同落回退色的假一致）
  expect(await tabColor(TS_FILE)).not.toBe(await tabColor(MD_FILE))
})

test('无扩展名文件走回退色，tab 色点与树仍一致', async ({ page }) => {
  const { treeColor, tabColor } = await openProjectAndFiles(page, [NOEXT_FILE])
  expect(await tabColor(NOEXT_FILE)).toBe(await treeColor(NOEXT_FILE))
})
