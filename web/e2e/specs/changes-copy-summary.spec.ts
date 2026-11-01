import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树「复制变更摘要」E2E（P-20261003-219）：树头按钮与右键菜单同名项把
 * 可见变更集转述为行式摘要入剪贴板——头部总计数行（N 个文件 +A / -D）+ 每文件
 * 一行 `- <状态字母> <path> +n -m`。核心守护：
 *   1. 头部按钮复制：剪贴板全文 = 总计数行 + 四文件 stat 行（含已暂存、
 *      未暂存、未跟踪补计与二进制标注四形态），数字与服务端 numstat 逐文件一致；
 *   2. 右键菜单项：同一摘要同一内容（树级动作经文件行菜单触发）；
 *   3. 数据面直测：GET /api/projects/:id/numstat 逐文件增删行数（含未跟踪
 *      行数补计与 binary 标注）。
 * 自备临时仓库（1 基线提交 + 确定性增删），afterAll 清理（与 changes-tree-expand 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-change-summary')
const PROJ = 'e2e-change-summary'
const BRANCH = 'e2e-cs-main'
// 夹具：tracked 基线两文件 + 四形态变更（已暂存改 / 未暂存改 / 未跟踪文本 / 未跟踪二进制）
const F_ONE = 'src/one.txt'
const F_GUIDE = 'docs/guide.md'
const F_README = 'README.md'
const F_NOTES = 'notes.txt' // untracked，3 行
const F_BIN = 'img.bin' // untracked，首字节含 NUL → 二进制不数行

// 期望摘要全文（zh 固定语；行序 = 全路径字典序）
const EXPECTED_SUMMARY = [
  `变更摘要（${BRANCH}）：4 个文件，+6 / -1`,
  '- M docs/guide.md +1 -0',
  '- ? img.bin (二进制)',
  '- ? notes.txt +3 -0',
  '- M src/one.txt +2 -1',
].join('\n')

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', BRANCH], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，行数三平台一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  const write = (rel: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, rel)), { recursive: true })
    fs.writeFileSync(path.join(REPO_DIR, rel), content)
  }
  write(F_README, 'change summary e2e baseline\n')
  write(F_ONE, 'one v1\n')
  write(F_GUIDE, 'guide v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 变更摘要基线'])
  // 四形态变更（注册项目前造好：注册使 status 缓存失效，首拉即含全量）
  //   src/one.txt  +2 -1（随后暂存——已暂存侧也在 numstat HEAD 口径内）
  //   docs/guide.md +1 -0（未暂存）
  write(F_ONE, 'one v1 line A\nline B\n')
  write(F_GUIDE, 'guide v1\nappended\n')
  git(REPO_DIR, ['add', F_ONE])
  write(F_NOTES, 'n1\nn2\nn3\n') // 未跟踪 +3（服务端 ls-files 补计）
  fs.writeFileSync(path.join(REPO_DIR, F_BIN), Buffer.from([0x89, 0x50, 0x00, 0x4e])) // 未跟踪二进制
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(4)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: 'one.txt' })).toBeVisible({ timeout: 10000 })
}

/** 读剪贴板并归一 CRLF：Windows 下 Chromium 剪贴板往返会把 LF 规范成 CRLF
 *  （writeText('a\nb') → readText() 得 'a\r\nb'，实测探针证实）——被复制内容
 *  本身是 LF，断言前归一回 LF 才能全文比对 */
async function readClipboard(page: import('@playwright/test').Page): Promise<string> {
  const raw = await page.evaluate(() => navigator.clipboard.readText())
  return raw.replace(/\r\n/g, '\n')
}

test('树头「复制变更摘要」：剪贴板 = 总计数行 + 四文件 stat 行（未跟踪补计/二进制标注在列）', async ({ page }) => {
  await enterProject(page)
  await page.locator('[data-testid="cp-copy-summary"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '变更摘要已复制' })).toBeVisible({ timeout: 5000 })
  expect(await readClipboard(page)).toBe(EXPECTED_SUMMARY)
})

test('右键菜单「复制变更摘要」：同一摘要同一内容（树级动作经文件行菜单触发）', async ({ page }) => {
  await enterProject(page)
  // 文件行右键 → 菜单「复制变更摘要」（紧邻既有「复制路径」项）
  await page.locator('.cp-node').filter({ hasText: 'guide.md' }).click({ button: 'right' })
  await page.locator('.n-dropdown-option').filter({ hasText: '复制变更摘要' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '变更摘要已复制' })).toBeVisible({ timeout: 5000 })
  expect(await readClipboard(page)).toBe(EXPECTED_SUMMARY)
})

test('numstat 数据面直测：逐文件增删行数 + 未跟踪补计 + binary 标注', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/numstat`, { headers })
  expect(res.status()).toBe(200)
  const body = await res.json() as { data?: { path: string; additions: number; deletions: number; binary?: boolean }[] }
  const byPath = new Map((body.data || []).map(f => [f.path, f]))
  // 基线未动的 README 不出现
  expect(byPath.has(F_README)).toBe(false)
  expect(byPath.get(F_ONE)).toMatchObject({ path: F_ONE, additions: 2, deletions: 1 })
  expect(byPath.get(F_GUIDE)).toMatchObject({ path: F_GUIDE, additions: 1, deletions: 0 })
  expect(byPath.get(F_NOTES)).toMatchObject({ path: F_NOTES, additions: 3, deletions: 0 })
  expect(byPath.get(F_BIN)).toMatchObject({ path: F_BIN, binary: true, additions: 0, deletions: 0 })
})
