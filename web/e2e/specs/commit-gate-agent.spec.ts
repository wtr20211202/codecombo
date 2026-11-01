import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 提交信息门禁失败「交给智能体修」（P-20261003-273）E2E：
 *   1. 违规提交 → 门禁弹层（失败原因清单）出现且提交未落库
 *   2. 弹层「交给智能体修」→ POST /terminals 请求体 launchArgs 含失败原因与
 *      原提交信息（kind=agent、dir=项目根）→ docked 管理页出现且会话创建
 *   3. 弹层「仍要提交」旁路 → 提交照常落库（非规范项目的显式豁免）
 *   4. 合规信息零弹层直过（既有提交流程不回归）
 * 门禁规则前端化自 scripts/check-commit-msg.cjs（P-20261002-92），服务端 git
 * commit 不感知（纯前端预检）。自备临时仓库，afterEach 清理全部终端会话，
 * afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-gate-agent')
const PROJ = 'e2e-commit-gate-agent'
const F1 = 'alpha-gate.txt'
/** 违规消息：类型「combo」不在白名单（原因行含「不在白名单」） */
const BAD_MSG = 'combo: 门禁违规测试消息'
/** 合规消息：feat 在白名单，直过闸 */
const GOOD_MSG = 'feat: 门禁合规测试消息'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  // 仓库本地身份：旁路/合规两用例的提交走服务端 git CLI，本机无全局身份时会
  // 500「Author identity unknown」（commit-push-combo 同款前置）
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'commit gate agent baseline\n')
  git(REPO_DIR, ['add', '.'])
  // CLI 侧播种不经前端门禁（门禁只在 CommitPanel 提交预检），消息形态不受限
  git(REPO_DIR, ['commit', '-m', 'root: 门禁基线提交'])
  // 造 1 个 staged 变更（提交按钮可用）
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged content\n`)
  git(REPO_DIR, ['add', '.'])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(1)

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住变更面板
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
}

/** 填消息并点主提交按钮（commit-amend 同款定位器） */
async function fillAndClickCommit(page: Page, message: string) {
  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill(message)
  const commitBtn = page.locator('.cp-commit-actions').getByRole('button', { name: /提交 \(/ })
  await expect(commitBtn).toBeEnabled({ timeout: 10000 })
  await commitBtn.click()
}

/** 服务端 HEAD 主题行（落库断言口径） */
function headSubject(): string {
  return git(REPO_DIR, ['log', '-1', '--format=%s'])
}

/** 服务端 status 的暂存计数：CLI 侧 git 改状态后 /status 走 3s TTL 缓存
 *  （server/api/gitops/status_cache.go 应用外变更自愈口径）——先等服务端收敛
 *  再进面板，不让用例间共享的暂存面撞缓存窗口（commit-msg-agent 同款前置） */
async function serverStagedCount(request: APIRequestContext): Promise<number> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/status`, { headers })
  const files = ((await res.json()) as { data?: { staged?: boolean }[] }).data || []
  return files.filter(f => f.staged).length
}

test('违规提交 → 门禁弹层含失败原因，提交不落库', async ({ page }) => {
  await enterProject(page)
  await fillAndClickCommit(page, BAD_MSG)

  // 弹层出现：失败原因行（类型不在白名单）+ 两动作钮
  const dlg = page.locator('[data-testid="commit-gate-dialog"]')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg).toContainText('不在白名单')
  await expect(page.locator('[data-testid="commit-gate-agent"]')).toBeVisible()
  await expect(page.locator('[data-testid="commit-gate-anyway"]')).toBeVisible()

  // 门禁失败 = 提交未发：HEAD 仍是基线（弹层停留期间落库面不变）
  expect(headSubject()).toBe('root: 门禁基线提交')
})

test('弹层「交给智能体修」→ agent 会话创建且 launchArgs 含失败原因与原信息', async ({ page, request }) => {
  await enterProject(page)
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await fillAndClickCommit(page, BAD_MSG)
  await expect(page.locator('[data-testid="commit-gate-dialog"]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="commit-gate-agent"]').click()

  // 发起链路断言（commit-msg-agent P-138 同款口径）：kind=agent、dir=项目根、
  // prompt（launchArgs）带失败原因行与原提交信息
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  expect(body.launchArgs).toContain('不在白名单')
  expect(body.launchArgs).toContain(BAD_MSG)

  // docked 管理页出现、恰好一个 agent 会话
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })

  // 门禁失败且走了修 = 提交仍未落库
  expect(headSubject()).toBe('root: 门禁基线提交')

  // 服务端会话表：恰好一个 agent 会话，工作目录 = 项目根
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0]!.path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
})

test('弹层「仍要提交」旁路 → 提交照常落库', async ({ page }) => {
  await enterProject(page)
  await fillAndClickCommit(page, BAD_MSG)
  await expect(page.locator('[data-testid="commit-gate-dialog"]')).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="commit-gate-anyway"]').click()

  // 旁路 = 放行：成功 toast + HEAD 变为违规消息原样落库
  await expect(page.locator('.n-message').filter({ hasText: '提交成功' })).toBeVisible({ timeout: 15000 })
  await expect.poll(() => headSubject(), { timeout: 10000 }).toBe(BAD_MSG)
})

test('合规信息零弹层直过：提交成功不出现门禁弹层', async ({ page, request }) => {
  // 前例「仍要提交」已把 beforeAll 的暂存文件提交落库——本例自备新暂存变更
  //（CLI 侧改状态 → 等服务端 status 收敛 → 进项目，见 serverStagedCount 注；
  // 内容带时间戳：重试时上轮已提交同内容，固定内容会 git add no-op 暂存 0）
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged content ${Date.now()}\n`)
  git(REPO_DIR, ['add', '.'])
  await expect.poll(() => serverStagedCount(request), { timeout: 15000 }).toBe(1)
  await enterProject(page)
  await fillAndClickCommit(page, GOOD_MSG)
  await expect(page.locator('.n-message').filter({ hasText: '提交成功' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('[data-testid="commit-gate-dialog"]')).toHaveCount(0)
  await expect.poll(() => headSubject(), { timeout: 10000 }).toBe(GOOD_MSG)
})
