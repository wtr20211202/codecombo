import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 审阅留言「交给智能体修复」（P-20261006-55）E2E：「交给智能体」动作族
 * 第五数据源——未解决留言批量装箱发起 agent 修复会话（留言状态零触碰）：
 *   1. 入口① DiffEditor 工具条：3 条未解决留言 → 钮出现（N=3）→ 点击 →
 *      POST /api/terminals kind=agent 且 launchArgs 含 文件:行/正文清单；
 *      docked 管理页打开；uiState 里留言仍 3 条且全部未解除（不自动翻转）
 *   2. 零未解决留言（全部已解除）→ 工具条钮不出现
 *   3. 入口② 变更面板文件行右键：该文件有留言 → 菜单项「把 N 条留言交给
 *      智能体」→ 点击发起同断言
 *   4. 全文超 500 字节走任务文件降级（P-20261006-44）：launchArgs 为短引用
 *      指令，全量清单落项目根 .sc-task.md
 * 留言数据经 PATCH /api/ui-state 直种（产出/持久化链路已由 diff-review-comments
 * 覆盖，本 spec 只测消费端）；launchArgs 断言取自 POST 请求体（todo-agent-fix
 * 同款）。beforeEach/afterEach 清空终端会话，afterAll 清理项目/夹具并清空
 * uiState（留言表归零，不给后续 spec 留状态）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-comments-to-agent')
const PROJ = 'e2e-diff-comments-to-agent'
const FILE = 'review.txt'

const C1_CONTENT = 'alpha\nbeta\ngamma\n'
const WT_CONTENT = 'alpha\nbeta EDITED in worktree\ngamma\n'

let projectId = ''

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

/** 直种留言表（PATCH /api/ui-state 的 diffComments 命名空间，实例 local）：
 *  覆盖本项目的留言数据（其余命名空间浅合并保留） */
async function seedComments(request: APIRequestContext, comments: Array<{ line: number; text: string; resolved?: boolean }>): Promise<void> {
  const headers = await unlockHeaders(request)
  const list = comments.map((c, i) => ({
    id: `seed-${i}`,
    line: c.line,
    text: c.text,
    lineText: '',
    createdAt: 1700000000000 + i,
    resolved: c.resolved === true,
  }))
  const res = await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { diffComments: { [projectId]: { [FILE]: list } } } },
  })
  expect(res.ok(), '直种留言表成功').toBeTruthy()
}

/** 读回本实例留言表（断言「发起动作不翻转留言状态」用）；GET 响应包 data 壳 */
async function readComments(request: APIRequestContext): Promise<Array<{ line: number; resolved: boolean }>> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ui-state`, { headers })
  const all = (await res.json()) as { data?: { local?: { diffComments?: Record<string, Record<string, Array<{ line: number; resolved: boolean }>>> } } }
  return all.data?.local?.diffComments?.[projectId]?.[FILE] || []
}

/** 清理全部终端会话：发起断言基于干净会话面，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false'])
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  // 工作区未提交修改（产出审阅对象）
  fs.writeFileSync(path.join(REPO_DIR, FILE), WT_CONTENT)

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 清空本实例 uiState（含直种的 diffComments），不给后续 spec 留状态
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

async function enterProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage，显式清一次避免 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

// rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-panel')).toBeVisible()
}

/** 打开变更面板工作区 diff（diff:HEAD:wt:<file>）：双击变更树文件行 */
async function openWorkspaceDiff(page: Page) {
  await enterProject(page)
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: FILE })).toBeVisible({ timeout: 10000 })
  await page.locator('.cp-node').filter({ hasText: FILE }).first().dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // 留言懒加载（ensureLoaded）→ 版本递增 → 工具条钮计算：留异步窗口一拍
  await page.waitForTimeout(800)
}

/** 断言 agent 会话创建 POST：kind=agent 且 launchArgs 含期望片段 */
async function expectAgentPost(
  reqPromise: Promise<import('@playwright/test').Request>,
  launchArgsParts: string[],
  launchArgsNotParts: string[] = [],
): Promise<Record<string, unknown>> {
  const req = await reqPromise
  expect(req.url()).toContain('/api/terminals')
  const body = req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  for (const part of launchArgsParts) {
    expect(body.launchArgs, `launchArgs 含「${part}」`).toContain(part)
  }
  for (const part of launchArgsNotParts) {
    expect(body.launchArgs, `launchArgs 不含「${part}」`).not.toContain(part)
  }
  return body
}

test('工具条入口：3 条未解决留言 → 钮显 N=3 → 发起 launchArgs 含清单，留言不翻转', async ({ page, request }) => {
  await seedComments(request, [
    { line: 1, text: '第一行也顺手统一格式' },
    { line: 2, text: '把编辑改回原始拼写' },
    { line: 3, text: 'gamma 保持不动' },
  ])
  await openWorkspaceDiff(page)

  const btn = page.locator('[data-testid="diff-comments-to-agent"]')
  await expect(btn, '有未解决留言 → 工具条钮出现').toBeVisible({ timeout: 8000 })
  await expect(btn).toHaveAttribute('aria-label', '把 3 条留言交给智能体')
  // 发起前基线：直种数据已就位（对「发起后不翻转」构成前后对照）
  expect((await readComments(request)), '发起前 3 条未解除').toHaveLength(3)

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await btn.click()
  await expectAgentPost(reqPromise, [
    '请修复以下 3 处 diff 审阅留言', // 批量头（n=3）
    'review.txt:1 第一行也顺手统一格式',
    'review.txt:2 把编辑改回原始拼写',
    'review.txt:3 gamma 保持不动',
  ])
  // docked 管理页打开
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })

  // 留言状态零触碰：uiState 里仍 3 条且全部未解除（resolved 由人复核翻转）
  const comments = await readComments(request)
  expect(comments, '留言条数不变').toHaveLength(3)
  expect(comments.every((c) => !c.resolved), '全部保持未解除').toBe(true)
})

test('零未解决留言：工具条钮不出现', async ({ page, request }) => {
  await seedComments(request, [
    { line: 2, text: '已由人工复核确认修完', resolved: true },
  ])
  await openWorkspaceDiff(page)
  // 已解除留言的行侧标记仍在（绿弱化），但「交给智能体」钮不出现
  await expect(page.locator('.monaco-diff-editor .editor.modified .sc-diff-comment-mark.is-resolved')).toHaveCount(1)
  await expect(page.locator('[data-testid="diff-comments-to-agent"]')).toHaveCount(0)
})

test('变更面板文件行右键：有留言出菜单项 → 发起 launchArgs 含清单', async ({ page, request }) => {
  await seedComments(request, [
    { line: 2, text: '改回原始拼写' },
    { line: 3, text: '补一行结尾换行说明' },
  ])
  await enterProject(page)
  await openCommitPanel(page)
  const row = page.locator('.cp-node').filter({ hasText: FILE }).first()
  await expect(row).toBeVisible({ timeout: 10000 })

  await row.click({ button: 'right' })
  const item = page.locator('.n-dropdown-option').filter({ hasText: '把 2 条留言交给智能体' })
  await expect(item, '该文件有未解决留言 → 右键菜单项出现（N=2）').toBeVisible({ timeout: 5000 })

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await item.click()
  await expectAgentPost(reqPromise, [
    '请修复以下 2 处 diff 审阅留言',
    'review.txt:2 改回原始拼写',
    'review.txt:3 补一行结尾换行说明',
  ])
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})

test('全文超 500 字节：launchArgs 为短引用指令，全量清单落项目根 .sc-task.md（P-20261006-44）', async ({ page, request }) => {
  const longText = `这里要重构：${'很'.repeat(400)}`
  await seedComments(request, [{ line: 2, text: longText }])
  await openWorkspaceDiff(page)

  const btn = page.locator('[data-testid="diff-comments-to-agent"]')
  await expect(btn).toBeVisible({ timeout: 8000 })
  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await btn.click()
  await expectAgentPost(reqPromise, [
    '.sc-task.md', // 短引用指令（不再是装箱 prompt）
    '请先完整阅读项目根',
  ], [longText.slice(0, 20)]) // 正文不再进 launchArgs

  // 任务文件已落项目根：自述头 + 全量清单
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects/${projectId}/file?path=.sc-task.md`, { headers })
  expect(res.status()).toBe(200)
  const doc = ((await res.json()) as { data?: string }).data || ''
  expect(doc).toContain('一次性任务载体')
  expect(doc).toContain('请修复以下 1 处 diff 审阅留言')
  expect(doc).toContain(`review.txt:2 ${longText}`)
})
