import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 批量替换前自动备份补丁 E2E（P-20261003-76）：
 * ① 备份勾选默认开 → 确认替换 → 下载事件触发，.patch 内容 = 替换前工作区差异
 *   （基线特意保持脏态：干净基线的前置 diff 为空，无从断言「替换前」），
 *   成功通知附「备份补丁已下载」提示；
 * ② 取消勾选 → 替换照常执行但无下载事件。
 * 自备临时仓库，afterAll 清理（范式与 search-replace-preview 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-replace-backup')
const PROJ = 'e2e-replace-backup'

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

function resetBaseline() {
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'id-001 alpha\nid-002 beta\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'id-003 gamma\n')
  fs.writeFileSync(path.join(REPO_DIR, 'c.txt'), 'nothing relevant\n')
}

// 备份内容断言需要非空前置 diff：给 c.txt（不参与替换命中）追加一行未提交改动
function makeWorktreeDirty() {
  fs.appendFileSync(path.join(REPO_DIR, 'c.txt'), 'uncommitted-mark\n')
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
  resetBaseline()
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 替换备份基线'])
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

/** 打开搜索面板（regex 模式）→ 搜索 → 展开替换行并填替换值 → 预览弹层可见 */
async function openRegexReplace(page: Page, needle: string, replacement: string) {
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(needle)
  // fill 聚焦输入框，300ms 防抖搜索执行后 needle 随即入查询历史（P-20261003-48
  // 全局域环形表）→ 历史下拉弹出。历史上其 absolute 悬浮盖住下方选项 chips、
  // regex 勾选点击被 ps-history-item 拦截（search-replace-preview/search-replace
  // 同款根因，本用例连红非下载链问题），P-20261006-32 已改锚头部件下缘不再遮挡；
  // 显式 blur 收下拉照旧保留作双保险：@blur 即 historyFocused=false，与产品
  // Esc 分层「先收下拉」同语义
  await card.locator('input').first().blur()
  await card.locator('.opt-chip').filter({ hasText: '.*' }).locator('.n-checkbox').click()
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill(replacement)
  await card.getByRole('button', { name: '全部替换' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  return { card, preview }
}

test('备份勾选默认开：确认替换触发下载，.patch 含替换前工作区差异，通知附备份提示', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBaseline()
  makeWorktreeDirty()

  // ERE 语法（git grep -E 兼容）而非 \d：POSIX ERE 无 \d，rg/git grep 两后端须同语义
  const { preview } = await openRegexReplace(page, 'id-[0-9]+', 'ID')

  // 默认勾选：备份永远默认在场（每次打开重置）
  const backupToggle = preview.locator('[data-testid="replace-backup-toggle"] .n-checkbox')
  await expect(backupToggle).toHaveClass(/n-checkbox--checked/)

  const dlPromise = page.waitForEvent('download')
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  const download = await dlPromise
  expect(download.suggestedFilename()).toMatch(/^replace-backup-\d{8}-\d{6}\.patch$/)
  const dlPath = path.join(os.tmpdir(), `sc-e2e-backup-${Date.now()}.patch`)
  await download.saveAs(dlPath)
  const patch = fs.readFileSync(dlPath, 'utf8')
  fs.rmSync(dlPath, { force: true })
  // 备份 = 替换前工作区差异：含预置未提交改动、不含替换结果（a.txt 未动时尚无 ID 行）
  expect(patch).toContain('+uncommitted-mark')
  expect(patch).not.toContain('+ID alpha')

  // 替换生效 + 成功通知附「备份已下载」提示（a.txt 2 处 + b.txt 1 处，全选执行）
  await expect(page.locator('.n-message').filter({ hasText: '已在 2 个文件中完成 3 处替换' })).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.n-message').filter({ hasText: '备份补丁已下载' })).toBeVisible()
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('ID alpha\nID beta\n')
})

test('取消勾选：替换照常执行但无备份下载事件', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBaseline()
  makeWorktreeDirty()

  const { preview } = await openRegexReplace(page, 'id-[0-9]+', 'ID')

  const backupToggle = preview.locator('[data-testid="replace-backup-toggle"] .n-checkbox')
  await expect(backupToggle).toHaveClass(/n-checkbox--checked/)
  await backupToggle.click()
  await expect(backupToggle).not.toHaveClass(/n-checkbox--checked/)

  // 下载若会发生必在确认点击后的备份先行阶段（先于任何写盘）——成功通知可见
  // 后仍未发生即为确证不下载
  const dlRace = page.waitForEvent('download', { timeout: 4000 })
    .then(() => 'downloaded' as const)
    .catch(() => 'none' as const)
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已在 2 个文件中完成 3 处替换' })).toBeVisible({ timeout: 20000 })
  expect(await dlRace).toBe('none')
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('ID alpha\nID beta\n')
})
