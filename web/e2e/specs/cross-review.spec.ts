import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨智能体审查链（P-20261003-6）E2E：
 *   1. 会话行右键「交叉审查」→ 弹层选目标 runtime → 发起 → POST /terminals
 *      请求体 kind=agent、dir=源会话目录、launchArgs 含审查指令与产出文件名
 *   2. 产出视图操作区入口同链路（产出清单在场时发起）
 *   3. 主树归属边界（useAgentMarks 既有口径）：主树会话 prompt 按主树口径表述
 *      清单，worktree 会话按会话目录口径——不伪称主树
 * prompt 经 createAgentTerminal 既有链路注入（launchArgs），断言请求体即断言
 * 前端组装产物；会话创建断言终端链路真到达服务端。自备临时仓库 + worktree，
 * 每用例先清空会话表再 API 播种源会话（按设置拉起底层运行时，只断言创建链路
 * 不与 TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-cross-review')
const WT_DIR = `${REPO_DIR}-wt`
const PROJ = 'e2e-cross-review'
const F1 = 'alpha-review.ts' // 会话创建前已改（tracked → diff 命中）
const F2 = 'beta-review.ts' // 会话创建前已加（untracked → ls-files --others 命中）
const F3 = 'gamma-review.ts' // worktree 内已改
/** 会话行定位标签：fixture 目录尾段（cwd 标签，跨实例唯一防撞名） */
const ROW_MAIN = 'sc-e2e-cross-review'
const ROW_WT = 'sc-e2e-cross-review-wt'

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

/** 清空全部终端会话：用例断言基于「空白会话表」，残留会话会污染计数与活动会话 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** API 播种 agent 源会话（runtime=shell 纯终端，不拉智能体进程）：返回会话名 */
async function seedAgentSession(request: APIRequestContext, dir: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${API_BASE}/api/terminals`, {
    headers, data: { kind: 'agent', runtime: 'shell', dir: serverPath(dir) },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: { name?: string } }
  return body.data?.name || ''
}

/** 等服务端会话表出现指定路径的 agent 会话（播种异步落库对齐窗口）。
 *  按路径过滤而非全表计数：tmux 服务器机器级共享，并行 worktree 实例的
 *  会话会被本实例采纳混入全表（实测踩坑），只有本 spec 自备夹具的路径稳定 */
async function serverAgentsByPath(request: APIRequestContext, dir: string): Promise<number> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { kind?: string; path?: string }[] }).data || []
  return list.filter(s => s.kind === 'agent' && s.path === serverPath(dir)).length
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  try { fs.rmSync(WT_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'cross review baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, F1), 'export const a = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 交叉审查基线'])
  // 造产出：tracked 改动 + untracked 新文件（startHead..工作区 diff + ls-files --others）
  fs.writeFileSync(path.join(REPO_DIR, F1), 'export const a = 2 // reviewed\n')
  fs.writeFileSync(path.join(REPO_DIR, F2), 'export const b = 1\n')
  // worktree 夹具（主树归属边界用）：独立检出 + 改一个 tracked 文件
  git(REPO_DIR, ['worktree', 'add', WT_DIR, '-b', 'cross-review-wt'])
  fs.writeFileSync(path.join(WT_DIR, F3), 'export const g = 2 // wt change\n')

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
  try { fs.rmSync(WT_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
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

/** 进项目页并打开 docked 管理页（活动栏入口） */
async function openAgentDocked(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免 docked 管理页残留态影响入口点击
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 会话行右键 → 交叉审查 → 弹层选「自动」→ 确认；断言 POST /terminals 请求体。
 *  行定位按 cwd 标签（fixture 目录尾段，全仓唯一）而非会话名——服务端默认名
 *  「终端 N/Terminal N」跨实例撞名（并行实例采纳的外部会话同名实测踩坑） */
async function launchFromSessionRow(page: Page, view: ReturnType<Page['locator']>, rowText: string) {
  const row = view.locator('.ats-item').filter({ hasText: rowText })
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('交叉审查', { exact: true }).click()

  const dlg = page.locator('.n-modal').filter({ hasText: '交叉智能体审查' })
  await expect(dlg).toBeVisible({ timeout: 5000 })

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '自动' }).click()
  await dlg.locator('[data-testid="cross-review-confirm"]').click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; runtime?: string; launchArgs?: string }
  return body
}

/** docked 侧栏行数下限断言（外部残留会话可混入，只断不小于源+审查） */
async function expectRowCountAtLeast(view: ReturnType<Page['locator']>, n: number) {
  await expect.poll(() => view.locator('.ats-item').count(), { timeout: 15000 }).toBeGreaterThanOrEqual(n)
}

/** 打开 docked 页并确保夹具会话在侧栏可见。
 *  抗并行实例串扰：tmux 服务器机器级共享，邻接实例的 cleanupTerminals 会把
 *  本实例的会话一并杀掉（服务端列表随之对账消失）——侧栏不见该行时按需补种
 *  （表内没有才补，防重复播种），侧栏未跟上 WS 对账就整页重载重拉 */
async function openDockedWithSession(
  page: Page,
  request: APIRequestContext,
  dir: string,
  rowText: string,
) {
  const view = await openAgentDocked(page)
  const row = view.locator('.ats-item').filter({ hasText: rowText })
  for (let i = 0; i < 3; i++) {
    if (await row.isVisible().catch(() => false)) return view
    if ((await serverAgentsByPath(request, dir)) === 0) await seedAgentSession(request, dir)
    await expect(row).toBeVisible({ timeout: 8000 }).catch(() => { /* 下一轮重载兜底 */ })
    if (await row.isVisible().catch(() => false)) return view
    await page.reload()
    await expect(view).toBeVisible({ timeout: 10000 })
  }
  await expect(row, '夹具会话应出现在侧栏（补种+重载后）').toBeVisible({ timeout: 10000 })
  return view
}

test('会话行交叉审查：右键 → 弹层 → 发起 → 新会话 prompt 含审查指令与产出', async ({ page, request }) => {
  await seedAgentSession(request, REPO_DIR)
  const view = await openDockedWithSession(page, request, REPO_DIR, ROW_MAIN)

  // 源会话 cwd = 项目根（主树会话）：prompt 清单按主树口径表述
  const body = await launchFromSessionRow(page, view, ROW_MAIN)
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR)) // 审查会话 cwd = 源会话目录（② 回流归属机制）
  expect(body.runtime).toBeUndefined() // 选「自动」→ 服务端按可用性选型
  // prompt 组装产物：审查指令 + 产出清单逐文件在场（两文件场景不触发截断）
  expect(body.launchArgs).toContain('交叉审查')
  expect(body.launchArgs).toContain('相对项目主树根')
  expect(body.launchArgs).not.toContain('相对会话工作目录')
  expect(body.launchArgs).toContain(F1)
  expect(body.launchArgs).toContain(F2)

  // docked 管理页出现审查会话（≥ 源+审查；外部残留会话可混入计数）；服务端
  // 会话表按路径精确同步：源与审查同目录恰好两条
  await expectRowCountAtLeast(view, 2)
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents.filter(s => s.path === serverPath(REPO_DIR)), '源与审查会话同目录').toHaveLength(2)
})

test('产出视图操作区交叉审查：产出清单在场 → 入口发起', async ({ page, request }) => {
  const name = await seedAgentSession(request, REPO_DIR)
  const view = await openDockedWithSession(page, request, REPO_DIR, ROW_MAIN)
  // 先选中本夹具会话（面板跟随活动会话；外部采纳会话可能在表内排前）
  await view.locator('.ats-item').filter({ hasText: ROW_MAIN }).click()

  // 打开产出面板（B3）：两产出文件在场
  await view.locator('.atv-header-actions [title="会话产出"]').click()
  await expect(view.locator('.aap-root')).toBeVisible({ timeout: 5000 })
  await expect(view.locator('.aap-file').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
  await expect(view.locator('.aap-file').filter({ hasText: F2 })).toBeVisible()

  // 操作区交叉审查按钮 → 弹层 → 发起（同链路）
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await view.locator('[data-testid="cross-review-activity"]').click()
  const dlg = page.locator('.n-modal').filter({ hasText: '交叉智能体审查' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg).toContainText(name) // 源会话回显
  await dlg.locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '自动' }).click()
  await dlg.locator('[data-testid="cross-review-confirm"]').click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  expect(body.launchArgs).toContain(F1)
  expect(body.launchArgs).toContain(F2)
  await expectRowCountAtLeast(view, 2)
  expect(await serverAgentsByPath(request, REPO_DIR)).toBe(2)
})

test('worktree 会话交叉审查：清单按会话目录口径，不伪称主树（既有边界）', async ({ page, request }) => {
  await seedAgentSession(request, WT_DIR)
  const view = await openDockedWithSession(page, request, WT_DIR, ROW_WT)

  // 源会话 cwd = worktree（≠ 当前项目根）：prompt 清单按会话目录口径
  const body = await launchFromSessionRow(page, view, ROW_WT)
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(WT_DIR))
  expect(body.launchArgs).toContain('相对会话工作目录')
  expect(body.launchArgs).not.toContain('相对项目主树根')
  expect(body.launchArgs).toContain(F3)
})
