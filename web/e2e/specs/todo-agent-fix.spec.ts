import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * TODO 面板「交给智能体修」（P-20261003-159）E2E：
 *   1. 条目操作：行内「交给智能体修」→ POST /api/terminals {kind:'agent'} 且
 *      launchArgs 含 文件:行、标记文本与上下文行（±2 行带行号、目标行 > 前缀）；
 *      docked 管理页打开
 *   2. 批量勾选：勾两条 → 批量条出现（已选计数）→ 一次点击恰创建一个会话，
 *      launchArgs 同时含两条标记；成功后勾选清空
 *   3. 批量全文超 500 字节（P-20261006-44 任务文件降级）：launchArgs 为短引用
 *      指令（不再是装箱截断），全量清单落项目根 .sc-task.md（自述头 + 全部条目）
 *
 * launchArgs 断言取自 POST 请求体（服务端会话表不回显 launchArgs）；agent 会话
 * 会按设置拉起底层运行时，只断言创建链路不与 TUI 交互。beforeEach/afterEach
 * 清理全部终端会话（「恰一条 agent 会话」断言基于空白会话表），afterAll 清理
 * 项目与夹具（范式与 todo-panel / error-to-agent 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-todo-agent-fix')
const PROJ = 'e2e-todo-agent-fix'

let projId = ''

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

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  // 两组标记（行 3 FIXME / 行 5 TODO），行间留真实代码行供上下文断言
  fs.mkdirSync(REPO, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO })
  fs.writeFileSync(path.join(REPO, 'todo.js'), '// e2e fixture\nconst a = 1\n// FIXME: check null\nconst b = 2\n// TODO: implement parser\n')
  git(REPO, ['add', '.'])
  git(REPO, ['commit', '-m', 'root: todo agent fix 基线'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  projId = body.data?.id || ''
  expect(projId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const token = headers['X-Lock-Token']
  if (projId) {
    await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  } else {
    // beforeAll 早败（注册未达）兜底按名清残留
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      if (p.name === PROJ) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
      }
    }
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

// 面板开关是 toggle 语义（上次会话可能停在 todos）：点开不可见则再点一次
async function openTodoPanel(page: Page) {
  await page.locator('[data-testid="rail-todos"]').click()
  const panel = page.locator('[data-testid="todo-panel"]')
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-todos"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

/** 断言 agent 会话创建结果：POST 体 kind=agent 且 launchArgs 含期望片段，
 *  docked 管理页打开，服务端恰 n 条 agent 会话（beforeEach 已清空会话表） */
async function expectAgentSession(
  page: Page,
  request: APIRequestContext,
  reqPromise: Promise<import('@playwright/test').Request>,
  launchArgsParts: string[],
  wantCount = 1,
): Promise<Record<string, unknown>> {
  const req = await reqPromise
  expect(req.url()).toContain('/api/terminals')
  const body = req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind, '请求体 kind=agent').toBe('agent')
  for (const part of launchArgsParts) {
    expect(body.launchArgs, `launchArgs 含「${part}」`).toContain(part)
  }
  // docked 管理页打开且激活会话存在
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })
  // 服务端恰 wantCount 条 agent 会话
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  expect(list.filter(s => s.kind === 'agent'), `服务端恰 ${wantCount} 条 agent 会话`).toHaveLength(wantCount)
  return body
}

test('条目「交给智能体修」→ launchArgs 含文件:行 + 标记文本 + 上下文行', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = await openTodoPanel(page)
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('2', { timeout: 8000 })

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await panel.locator('[data-testid="todo-fix-3"]').click()
  await expectAgentSession(page, request, reqPromise, [
    '请修复此技术债标记：', // prompt 模板段（单条头）
    'todo.js:3 // FIXME: check null', // 文件:行 + 标记文本
    '上下文：', // 上下文标签（readFile 静默拉取成功）
    '> 3: // FIXME: check null', // 目标行 > 前缀
    '4: const b = 2', // 上下文行（+1）
  ])
})

test('批量勾选两条 → 一次点击恰创建一个会话，launchArgs 同时含两条标记，成功后清勾选', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = await openTodoPanel(page)
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('2', { timeout: 8000 })
  // 无勾选时批量条不出现
  await expect(panel.locator('[data-testid="todo-batch-bar"]')).toHaveCount(0)

  await panel.locator('[data-testid="todo-check-3"]').check()
  await panel.locator('[data-testid="todo-check-5"]').check()
  const bar = panel.locator('[data-testid="todo-batch-bar"]')
  await expect(bar).toBeVisible()
  await expect(bar.locator('[data-testid="todo-batch-count"]')).toHaveText('已选 2 条')

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await bar.locator('[data-testid="todo-batch-fix"]').click()
  const body = await expectAgentSession(page, request, reqPromise, [
    '请修复以下 2 处技术债标记：', // 批量头（n=2）
    'todo.js:3 // FIXME: check null', // 第一条
    'todo.js:5 // TODO: implement parser', // 第二条
  ])
  // 批量 prompt 不含上下文块（500 字节预算让位给条目数）
  expect(body.launchArgs as string).not.toContain('上下文：')
  // 创建成功即清勾选：批量条收起
  await expect(bar).toBeHidden({ timeout: 5000 })
})

test('批量全文超 500 字节：launchArgs 为短引用指令，全量清单落项目根 .sc-task.md（P-20261006-44）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  // 追加 7 条超长标记：填充注释把标记行垫到行号 10..70（勾选框 testid 按行号，
  // 与 todo.js 的 3/5 及彼此错开防 testid 撞车）
  const long = Array.from({ length: 7 }, (_, i) => `// TODO: ${'x'.repeat(90)} item-${i}`)
  const lines: string[] = []
  for (let i = 0; i < long.length; i++) {
    while (lines.length < (i + 1) * 10 - 1) lines.push('// padding')
    lines.push(long[i]!)
  }
  fs.writeFileSync(path.join(REPO, 'many.js'), `${lines.join('\n')}\n`)
  git(REPO, ['add', 'many.js'])
  try {
    git(REPO, ['commit', '-m', 'test: many todo marks'])
  } catch {
    // playwright retry 重入：内容相同已提交过（nothing to commit），幂等放行
  }

  const panel = await openTodoPanel(page)
  await panel.locator('[data-testid="todo-refresh"]').click()
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('9', { timeout: 15000 })
  for (let i = 0; i < long.length; i++) {
    await panel.locator(`[data-testid="todo-check-${(i + 1) * 10}"]`).check()
  }
  const bar = panel.locator('[data-testid="todo-batch-bar"]')
  await expect(bar).toBeVisible()

  const reqPromise = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await bar.locator('[data-testid="todo-batch-fix"]').click()
  const body = await expectAgentSession(page, request, reqPromise, [
    '.sc-task.md', // 短引用指令（不再是装箱截断 prompt）
    '请先完整阅读项目根',
  ])
  expect(body.launchArgs as string).not.toContain('item-6')

  // 任务文件已落项目根：自述头 + 全量清单（装箱必截的末条在场）
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/projects/${projId}/file?path=.sc-task.md`, { headers })
  expect(res.status()).toBe(200)
  const doc = ((await res.json()) as { data?: string }).data || ''
  expect(doc).toContain('一次性任务载体')
  expect(doc).toContain('任务完成即可删除')
  expect(doc).toContain('请修复以下 7 处技术债标记：')
  for (let i = 0; i < long.length; i++) {
    expect(doc).toContain(`many.js:${(i + 1) * 10}`)
    expect(doc).toContain(`item-${i}`)
  }
})
