import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更面板「交给智能体审查变更集」（P-20261005-2）E2E：
 *   1. 改 2 文件（1 staged + 1 unstaged）→ 点头部「交给智能体审查」→ POST
 *      /terminals 请求体 kind=agent、dir=项目根，launchArgs（小变更集全文
 *      直进 500 字节，不经任务文件降级）含两个文件名、staged/unstaged 分组、
 *      三问指令头、numstat 规模行与基线信息 → docked 管理页出现且服务端恰好
 *      一个 agent 会话
 *   2. 空变更按钮禁用：干净仓禁用 → 变更恢复后可用
 * 自备临时仓库，afterEach 清理全部终端会话（会按设置拉起底层运行时，只断言
 * 创建链路不与 TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-commit-ask-review')
const PROJ = 'e2e-commit-ask-review'
const F1 = 'a-review.txt'
const F2 = 'b-review.txt'

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
// init.defaultBranch 随环境漂移（master/main）：基线行断言按仓库实际分支取
let repoBranch = ''

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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'commit ask review baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} baseline\n`)
  fs.writeFileSync(path.join(REPO_DIR, F2), `${F2} baseline\n`)
  git(REPO_DIR, ['add', '.'])
  // 提交主题保持短 ASCII：基线行（分支+主题）随全文进 500 字节 launchArgs，
  // 长 CJK 主题会把小变更集挤进任务文件降级路径（launchArgs 断言面就变了）
  git(REPO_DIR, ['commit', '-m', 'root: review baseline'])
  repoBranch = git(REPO_DIR, ['rev-parse', '--abbrev-ref', 'HEAD'])
  // 造 2 处变更（tracked 修改）：F1 改后暂存、F2 只改——staged/unstaged 分组
  // 断言的夹具；tracked 形态下 checkout/reset 才能干净回到空变更态
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged change\n`)
  git(REPO_DIR, ['add', F1])
  fs.writeFileSync(path.join(REPO_DIR, F2), `${F2} unstaged change\n`)
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(2)

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

function reviewBtn(page: Page) {
  return page.locator('.commit-panel [data-testid="cp-ask-review"]')
}

/** 两处变更夹具（tracked 修改）：F1 改后暂存、F2 只改——可反复重建自归一 */
function restoreChanges() {
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged change\n`)
  git(REPO_DIR, ['add', F1])
  fs.writeFileSync(path.join(REPO_DIR, F2), `${F2} unstaged change\n`)
}

/** 回到干净仓：暂存还原 + 工作区还原（tracked 形态下即零变更） */
function clearChanges() {
  git(REPO_DIR, ['reset'])
  git(REPO_DIR, ['checkout', '--', '.'])
}

/** 服务端 status 的变更计数：CLI 侧 git 改状态后，/status 走 3s TTL 缓存
 *  （server/api/gitops/status_cache.go，应用外变更自愈口径）——先等服务端
 *  收敛到 CLI 现实再刷页面，不让 UI 断言撞缓存窗口 */
async function serverStatusCount(request: APIRequestContext): Promise<number> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/status`, { headers })
  const files = ((await res.json()) as { data?: unknown[] }).data || []
  return files.length
}

test('两处变更 → 审查 → agent 会话创建且 launchArgs 含文件清单/分组与三问指令', async ({ page, request }) => {
  await enterProject(page)
  await expect(reviewBtn(page)).toBeEnabled()

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await reviewBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  // 小变更集全文 ≤500 直进 launchArgs（不经 .sc-task.md 降级——断言的是组装产物本身）
  expect(body.launchArgs).toContain(F1)
  expect(body.launchArgs).toContain(F2)
  // 三问指令头（首行）+ staged/unstaged 分组
  expect(body.launchArgs).toContain('① 风险点（逻辑/安全/兼容）')
  expect(body.launchArgs).toContain('② 缺失的测试')
  expect(body.launchArgs).toContain('③ 与仓库规范一致性')
  expect(body.launchArgs).toContain('已暂存：')
  expect(body.launchArgs).toContain('未暂存/未跟踪：')
  // diff --stat 摘要（numstat）与基线信息（分支 + 最近提交，风格锚）+ 深查指引
  expect(body.launchArgs).toContain('规模：+')
  expect(body.launchArgs).toContain(`基线：分支 ${repoBranch} · 最近提交：root: review baseline`)
  expect(body.launchArgs).toContain('git diff')

  // docked 管理页出现、恰好一个会话且激活
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)

  // 服务端会话表：恰好一个 agent 会话，工作目录 = 项目根
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0]!.path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
})

test('空变更按钮禁用：干净仓禁用 → 变更恢复后可用', async ({ page, request }) => {
  // 自归一基线：先收敛到「两处变更」（tracked 修改形态）
  restoreChanges()
  await expect.poll(() => serverStatusCount(request), { timeout: 15000 }).toBe(2)
  await enterProject(page)
  await expect(reviewBtn(page)).toBeEnabled()

  // 全部还原（CLI 侧改状态）：等服务端 status 收敛后重进页面（不依赖 WS 推送
  // 时序，也不撞 3s TTL 缓存窗口）
  clearChanges()
  await expect.poll(() => serverStatusCount(request), { timeout: 15000 }).toBe(0)
  await page.reload()
  await openCommitPanel(page)
  await expect(reviewBtn(page)).toBeDisabled()

  // 重新造变更：按钮恢复可用（禁用态无从发起请求，此处只断言状态恢复）
  restoreChanges()
  await expect.poll(() => serverStatusCount(request), { timeout: 15000 }).toBe(2)
  await page.reload()
  await openCommitPanel(page)
  await expect(reviewBtn(page)).toBeEnabled()
})
