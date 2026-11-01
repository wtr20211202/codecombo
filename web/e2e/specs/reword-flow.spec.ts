import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Git 提交历史「修改提交信息（Reword）」E2E：
 * 改写非 HEAD 的历史提交（走 rebase reword 路径而非 HEAD amend，覆盖价值更高）：
 * 提交右键 → prompt 预填旧消息 → 改写 → toast + CLI 校验：
 *   - 新 subject 生效且只改目标一条
 *   - 根提交哈希不变、提交总数不变、HEAD 树内容不变（纯消息改写）
 * 自备临时仓库，afterAll 清理（范式与 stash-flow/tag-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-reword')
const PROJ = 'e2e-reword'
const FILE = '.e2e-reword.tmp'
const ROOT_MSG = 'root: reword 基线提交'
const C1_MSG_OLD = 'c1: 待改写的历史提交'
const C1_MSG_NEW = 'c1: 改写后的新消息 (reworded)'

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

let rootHash = ''
let oldHeadTree = ''

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'reword e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', ROOT_MSG])
  rootHash = git(REPO_DIR, ['rev-parse', 'HEAD'])
  fs.appendFileSync(path.join(REPO_DIR, FILE), 'reword e2e v2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', C1_MSG_OLD])
  oldHeadTree = git(REPO_DIR, ['rev-parse', 'HEAD^{tree}'])
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

test('历史提交 reword：prompt 预填 → 改写 → 只动目标一条且树不变', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 展开底部面板 Git 页签（uiState 跨用例恢复态不定 → 归一化）
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  // 日志倒序：首行 = HEAD（c1，待改写目标），第二行 = root（hash 应保持不变）
  const rows = page.locator('.commit-item')
  await expect(rows).toHaveCount(2, { timeout: 5000 })

  await rows.first().click({ button: 'right' })
  const menuItem = page.locator('.n-dropdown-menu').getByText('修改提交信息', { exact: true })
  await expect(menuItem).toBeVisible({ timeout: 3000 })
  await menuItem.click()

  // prompt 预填旧消息 → 改写为新消息 → 确认
  const dialogInput = page.locator('.n-dialog input')
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await expect(dialogInput).toHaveValue(C1_MSG_OLD)
  await dialogInput.fill(C1_MSG_NEW)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  await expect(page.locator('.n-message').filter({ hasText: '提交信息已修改' })).toBeVisible({ timeout: 5000 })

  // CLI：subjects = [新消息, 原根消息]；根哈希不变；提交数不变；HEAD 树不变（纯消息改写）
  await expect.poll(async () => {
    const headers = await unlockHeaders()
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/log?limit=2`, { headers })
    const body = (await res.json()) as { data?: Array<{ message?: string }> }
    return body.data?.[0]?.message || ''
  }, { timeout: 10000 }).toBe(C1_MSG_NEW)

  const subjects = git(REPO_DIR, ['log', '--format=%s']).split('\n')
  expect(subjects).toEqual([C1_MSG_NEW, ROOT_MSG])
  expect(git(REPO_DIR, ['rev-list', '--count', 'HEAD']), '提交总数应不变').toBe('2')
  expect(git(REPO_DIR, ['rev-parse', 'HEAD^{tree}']), '纯消息改写不应动树内容').toBe(oldHeadTree)
  expect(git(REPO_DIR, ['rev-parse', 'HEAD~1']), '根提交哈希应保持不变').toBe(rootHash)
})
