import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * stash 应用到新分支（P-20261003-263 实验性应用）E2E：
 *   冲突拒绝（分支已存在 → 本地化报错 + 零副作用）→
 *   链路成功（应用到新分支 → 原分支指针不动「当前工作区不变」+ 新分支被检出且
 *   工作区含 stash 内容 + stash 条目按 git 语义移除）→
 *   前端分支名校验（非法名被 validate 拦下，弹窗不关、不发请求）。
 * 全程以 git CLI 校验仓库真实状态，UI 只负责驱动操作（stash-flow 同款范式）。
 * 自备临时仓库，afterAll 清理（项目/目录/uiState 归零，与 stash-flow 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-stash-branch')
const PROJ = 'e2e-stash-branch'
const FILE = '.e2e-stash-branch.tmp'
const STASH_MSG = 'e2e: 实验性应用消息'
const TRIAL_BRANCH = 'stash-trial'

let projectId = ''
let baseBranch = '' // git init 的默认分支名随 git 版本漂移（master/main），动态捕获

// 固定参数列表调用 git（无 shell 拼接），身份 -c 内联不依赖本机 git 配置
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
  // 清理历史残留（失败重跑时项目名会撞）
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
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'stash branch e2e v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: stash 实验性应用基线'])
  baseBranch = git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])
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
  // uiState 归零收尾（与 stash-flow 对称，防布局恢复污染后续 spec）
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
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

/** 经 API 写入工作区变更（服务端同路径写文件，status 面板可见） */
async function makeWorkingChange(headers: Record<string, string>, content: string) {
  const put = await fetch(`${API_BASE}/api/projects/${projectId}/file`, {
    method: 'PUT', headers, body: JSON.stringify({ path: FILE, content }),
  })
  expect(put.ok).toBeTruthy()
}

/** 切到 stash 页签（提交面板页签语义锚点） */
async function openStashTab(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="cp-tab-stash"]').click()
  await expect(page.locator('.cp-stash-toolbar')).toBeVisible({ timeout: 3000 })
}

/** 弹窗的消息输入框（弹窗只有一根 NInput，限定包装层防 strict mode 撞隐藏 input） */
function stashDialogInput(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog .n-input input')
}

/** 行内「应用到新分支」→ 填分支名 → 确认 */
async function applyToBranchViaUi(page: import('@playwright/test').Page, branchName: string) {
  await page.locator('.cp-stash-item').first().getByRole('button', { name: '应用到新分支' }).click()
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await dialogInput.fill(branchName)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
}

/** 用例开头清空 stash（stash-flow 同款惯例：跨用例共享的服务端域先归零） */
async function clearStashes(headers: Record<string, string>) {
  for (let i = 0; i < 10; i++) {
    const res = await fetch(`${API_BASE}/api/projects/${projectId}/stashes`, { headers })
    const list = ((await res.json()) as { data?: unknown[] }).data || []
    if (list.length === 0) return
    const del = await fetch(`${API_BASE}/api/projects/${projectId}/stash/0`, { method: 'DELETE', headers })
    expect(del.ok, '前置：清理遗留 stash 条目').toBeTruthy()
  }
}

/** 建一条 stash 的 API 便利封装（变更 → stash），返回前断言工作区已干净 */
async function stashWorkingChange(headers: Record<string, string>, content: string) {
  await makeWorkingChange(headers, content)
  expect(git(REPO_DIR, ['status', '--porcelain']), '前置：工作区应有变更').not.toBe('')
  const create = await fetch(`${API_BASE}/api/projects/${projectId}/stash`, {
    method: 'POST', headers, body: JSON.stringify({ message: STASH_MSG }),
  })
  expect(create.ok).toBeTruthy()
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
}

test('分支名冲突拒绝：目标分支已存在 → 本地化报错 + stash 与分支原样', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await stashWorkingChange(headers, 'stash branch e2e v2\n')

  await openStashTab(page)
  // 用已存在的基线分支名触发服务端冲突预检
  await applyToBranchViaUi(page, baseBranch)

  await expect(page.locator('.n-message').filter({ hasText: '已存在' })).toBeVisible({ timeout: 5000 })

  // 零副作用：stash 条目原样、工作区保持干净、分支未切换
  expect(git(REPO_DIR, ['stash', 'list'])).toContain(STASH_MSG)
  expect(git(REPO_DIR, ['status', '--porcelain'])).toBe('')
  expect(git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(baseBranch)
})

test('应用到新分支：原分支不动 + 新分支被检出且含 stash 内容 + 条目移除', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await stashWorkingChange(headers, 'stash branch e2e v3\n')
  const baseSha = git(REPO_DIR, ['rev-parse', baseBranch])

  await openStashTab(page)
  await applyToBranchViaUi(page, TRIAL_BRANCH)

  await expect(page.locator('.n-message').filter({ hasText: TRIAL_BRANCH })).toBeVisible({ timeout: 5000 })
  // stash 列表消费：条目按 git stash branch 语义移除
  await expect(page.locator('.cp-stash-item')).toHaveCount(0, { timeout: 5000 })

  // 仓库真实状态：
  // ①「当前工作区不变」——原分支指针未被 stash 内容污染
  expect(git(REPO_DIR, ['rev-parse', baseBranch])).toBe(baseSha)
  // ② 新分支被检出，且基于 stash 原基线（= 原分支同一提交）
  expect(git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(TRIAL_BRANCH)
  expect(git(REPO_DIR, ['rev-parse', TRIAL_BRANCH])).toBe(baseSha)
  // ③ 新分支工作区含 stash 内容（未提交，供实验/继续加工）
  expect(git(REPO_DIR, ['status', '--porcelain'])).not.toBe('')
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content.trimEnd()).toBe('stash branch e2e v3')
  // ④ stash 条目移除（refs/stash 更新在 Windows 文件层有可观测的短暂滞后 → poll）
  await expect.poll(async () => git(REPO_DIR, ['stash', 'list']), { timeout: 5000 }).toBe('')
})

test('前端分支名校验：非法名被拦下，弹窗不关、不发请求', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearStashes(headers)
  await enterProject(page)
  await stashWorkingChange(headers, 'stash branch e2e v4\n')

  await openStashTab(page)
  await page.locator('.cp-stash-item').first().getByRole('button', { name: '应用到新分支' }).click()
  const dialogInput = stashDialogInput(page)
  await expect(dialogInput).toBeVisible({ timeout: 3000 })
  await dialogInput.fill('bad name!')
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  // validate 拦截：错误文案就地提示，弹窗保持打开（确认未放行）
  await expect(page.locator('.n-message').filter({ hasText: '非法字符' })).toBeVisible({ timeout: 3000 })
  await expect(stashDialogInput(page)).toBeVisible()
  // 收尾取消，仓库零副作用
  await page.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  expect(git(REPO_DIR, ['stash', 'list'])).toContain(STASH_MSG)
  expect(git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe(TRIAL_BRANCH)
})
