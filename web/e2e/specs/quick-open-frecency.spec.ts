import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { FILE_USAGE_STORAGE_KEY } from '../../src/utils/paletteUsage'

/**
 * Quick Open 文件层「最近打开」加权 E2E（P-20261005-222）：
 *   - 打开成功即记 localStorage frecency（openFile 成功链 onPushRecent 同点位，
 *       safeStorage 持久、按项目隔离、键 `${projectId}:${path}`）
 *   - 空查询置顶段「继续上次工作」= frecency 前 5（条目须在当前清单内；有查询即消失）
 *   - 查询匹配分严格相等时以 frecency 破平（匹配语义优先，同分带内高频者在前）
 *
 * 自备临时仓库保证确定性：全新项目无 uiState 恢复签（boot 恢复走同一条
 * openFile 成功链计账，共享实例上会污染打开序）、文件清单受控（同分带成员
 * 完全可控——查询「util」对 util/ 下三个文件都是 0 位起连续命中，模糊分严格
 * 相等）；浏览器上下文每用例全新，frecency 从零起步
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-quickopen-frecency')
const PROJ = 'e2e-qo-frecency'
// util 目录三兄弟：对查询「util」路径连续命中位置同构 → 模糊分严格相等
const PLAIN_A = 'util/aaa.ts'
const USED_B = 'util/bbb.ts'
const PLAIN_C = 'util/ccc.ts'
const OPENED = 'docs/guide.md'
const ALL_FILES = [PLAIN_A, USED_B, PLAIN_C, OPENED]
const RESUME_LABEL = '继续上次工作'

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
  const res = await fetch(`${API_BASE}/api/projects`, { headers, method: 'POST', body: JSON.stringify({ name, path: serverPath(dir) }) })
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
  fs.mkdirSync(path.join(REPO_DIR, 'util'), { recursive: true })
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of ALL_FILES) fs.writeFileSync(path.join(REPO_DIR, f), `// ${f}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: quick open frecency 基线'])
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

async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

async function openQuickOpen(page: Page) {
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('空查询置顶段「继续上次工作」：打开过的文件置顶且只服务空查询', async ({ page }) => {
  await enterProject(page)

  // 无使用记录（全新项目无恢复签、上下文本地存储为空）：不渲染置顶段
  let input = await openQuickOpen(page)
  await expect(page.locator('.palette-group-label', { hasText: RESUME_LABEL })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-mask')).toBeHidden()

  // 经 Quick Open 真实打开链开文件——openFile 成功（内容装载完成）即记账
  input = await openQuickOpen(page)
  await input.fill('guide')
  const item = page.locator('.palette-item').filter({ hasText: 'guide.md' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.locator('.palette-mask')).toBeHidden({ timeout: 5000 })
  // 内容装载成功 = 记账点位（tab 占位先出现、记录在其后毫秒级落盘）
  await expect(page.locator('.editor-tab').filter({ hasText: 'guide.md' })).toBeVisible({ timeout: 5000 })
  await page.waitForTimeout(500)

  // 重开面板：空查询置顶段首位 = 刚打开的文件；输查询后置顶段消失（只服务空查询态）
  input = await openQuickOpen(page)
  await expect(page.locator('.palette-group-label').first()).toHaveText(RESUME_LABEL)
  await expect(page.locator('.palette-item').first()).toContainText('guide.md')
  await input.fill('util')
  await expect(page.locator('.palette-group-label', { hasText: RESUME_LABEL })).toHaveCount(0)
})

test('查询同分带 frecency 破平：路径分严格相等的兄弟文件高频者在前', async ({ page }) => {
  // 预置 bbb.ts 的使用记录（addInitScript 页面脚本前写 localStorage，面板打开
  // 时 loadFileUsage 读入；存储键为 `${projectId}:${path}` 前缀形态）；查询
  // 「util」对 aaa/bbb/ccc 的唯一命中面都是路径 0 位起连续段 → 模糊分严格
  // 相等，同分带内 bbb 浮到首位（无加权时按清单序 aaa 在前——断言红绿翻转
  // 即验证破平生效）
  const seedKey = `${projectId}:${USED_B}`
  await page.addInitScript(([key, usage]) => {
    localStorage.setItem(key, JSON.stringify(usage))
  }, [FILE_USAGE_STORAGE_KEY, { [seedKey]: { count: 3, lastAt: Date.now() } }])
  await enterProject(page)

  const input = await openQuickOpen(page)
  await input.fill('util')
  await expect(page.locator('.palette-item').first()).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-item').first()).toContainText('bbb.ts')
  // 同分带内序：bbb（有记录）→ aaa → ccc（无记录互不重排，稳定回落清单原序）
  const names = await page.locator('.palette-item .palette-item-title').allTextContents()
  expect(names.findIndex(n => n.includes('bbb.ts'))).toBeLessThan(names.findIndex(n => n.includes('aaa.ts')))
  expect(names.findIndex(n => n.includes('aaa.ts'))).toBeLessThan(names.findIndex(n => n.includes('ccc.ts')))
})
