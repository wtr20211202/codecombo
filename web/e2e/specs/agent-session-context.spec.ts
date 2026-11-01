import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话启动上下文的用户配置面（P-20261006-47）E2E：
 *   1. 设置切「无」（sessionContext=none）→ 新建会话对话框默认全不勾，创建
 *      launchArgs 即指令原文（不含 git 状态行）——P-176 一刀切的关闭口
 *   2. 设置勾笔记（sessionContext=notes）→ 对话框默认勾笔记不勾 git，创建
 *      launchArgs 含笔记首段行（projnotes 工作台记忆通道）
 *   3. 对话框临时覆选不改设置持久值：设置 notes 下临时加勾 git → 本次创建
 *      git+笔记齐附；GET /settings 复核 sessionContext 仍为 notes
 *   4. ask 发起族读同一设置：none 下右键「在此目录新建 agent 会话」launchArgs
 *      即定位前言原文（无 git 状态行）
 * 断言直接对 POST /api/terminals 请求体（launchArgs 内容），不与 TUI 交互；
 * sessionContext 是服务端全局设置，workers=1 串行 + 每例显式设值 + afterAll
 * 还原 git（P-176 默认语义，邻位 agent-git-status-summary.spec 依赖）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-session-context')
const PROJ_NAME = 'e2e-agent-session-context'
const BRANCH = 'e2e-sc-main'
const COMMIT_SUBJECT = 'c1: seed commit'
// 出厂预置「解释当前文件」：未打开文件时 {file} 原样保留 → launchArgs 首行确定
const EXPLAIN_TPL = '解释当前文件'
const DIR_PROMPT = '请先熟悉当前目录的代码结构，然后等待我的具体任务。'
const NOTES_CONTENT = 'E2E project notes first paragraph for agent context.\n\nSecond paragraph must not be injected.'

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 设置 sessionContext（每例显式设值保证确定性；none 为全关档） */
async function setSessionContext(request: APIRequestContext, value: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.put(`${API_BASE}/api/settings`, { headers, data: { sessionContext: value } })
  expect(res.status()).toBe(200)
}

async function getSessionContext(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/settings`, { headers })
  return (((await res.json()) as { data?: { sessionContext?: string } }).data?.sessionContext) || ''
}

/** 清理全部终端会话（断言基于请求体，仍清理防运行时被拉起占住夹具目录） */
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

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 还原默认档：本 spec 的全局设置改动不能泄给后续 spec（P-176 默认 git 语义）
  await request.put(`${API_BASE}/api/settings`, { headers, data: { sessionContext: 'git' } })
  if (projectId) await request.delete(`${API_BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`])
  git(REPO_DIR, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', COMMIT_SUBJECT])
  // 1 个未提交修改（tracked Modified）→ git 摘要的变更计数 = 1（覆选用例断言的事实）
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 2\n')

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''

  // 项目笔记（projnotes 人机共享便签层）：首段注入的事实源，第二段不得外泄
  const notesRes = await request.put(`${API_BASE}/api/projects/${projectId}/notes`, {
    headers, data: { content: NOTES_CONTENT },
  })
  expect(notesRes.status()).toBe(200)
})

/** 进项目页并打开 docked 管理页 */
async function gotoAgentView(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
}

/** 打开新建会话对话框（「本次上下文」折叠区随任务指令非空才渲染——模板选中
 *  后由各用例自行断言） */
async function openDialog(page: Page) {
  await page.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  return dlg
}

/** 选出厂预置模板（prompt 出现且已替换），返回指令文本（首行断言的事实源） */
async function selectTemplate(page: Page, dlg: ReturnType<Page['locator']>) {
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: EXPLAIN_TPL }).click()
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toHaveValue(/请解释 \{file\}/, { timeout: 5000 })
  return promptBox.inputValue()
}

test('设置切「无」：对话框默认全不勾，创建 launchArgs 即指令原文（无 git 行）', async ({ page, request }) => {
  await setSessionContext(request, 'none')
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  const promptValue = await selectTemplate(page, dlg)
  await expect(dlg.locator('[data-testid="agent-context-section"]')).toBeVisible()

  for (const id of ['agent-attach-git-status', 'agent-attach-notes', 'agent-attach-todos', 'agent-attach-env-profile']) {
    await expect(dlg.locator(`[data-testid="${id}"]`)).toHaveAttribute('aria-checked', 'false')
  }

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.launchArgs).toBe(promptValue)
  expect(body.launchArgs).not.toContain('git 状态')
})

test('设置勾笔记：默认勾笔记不勾 git，launchArgs 含笔记首段行', async ({ page, request }) => {
  await setSessionContext(request, 'notes')
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  const promptValue = await selectTemplate(page, dlg)
  await expect(dlg.locator('[data-testid="agent-context-section"]')).toBeVisible()

  await expect(dlg.locator('[data-testid="agent-attach-notes"]')).toHaveAttribute('aria-checked', 'true')
  await expect(dlg.locator('[data-testid="agent-attach-git-status"]')).toHaveAttribute('aria-checked', 'false')

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  // 首行恒为任务（promptSessionName 派生语义），笔记首段随其后；第二段不外泄、git 不附
  expect(body.launchArgs?.split('\n')[0]).toBe(promptValue)
  expect(body.launchArgs).toContain(`项目笔记（${PROJ_NAME}）：E2E project notes first paragraph for agent context.`)
  expect(body.launchArgs).not.toContain('Second paragraph')
  expect(body.launchArgs).not.toContain('git 状态')
  expect(new TextEncoder().encode(body.launchArgs || '').length).toBeLessThanOrEqual(500)
})

test('对话框临时覆选不改设置持久值：设置 notes 下加勾 git → 本次双附，设置仍 notes', async ({ page, request }) => {
  await setSessionContext(request, 'notes')
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  const promptValue = await selectTemplate(page, dlg)
  await expect(dlg.locator('[data-testid="agent-context-section"]')).toBeVisible()

  // 临时加勾 git：勾选即预取（log limit=1 现查），等摘要返回再提交消除竞态
  const gitFetch = page.waitForResponse(
    r => r.url().includes('/api/projects/') && r.url().includes('/log') && r.url().includes('limit=1'),
  )
  await dlg.locator('[data-testid="agent-attach-git-status"]').click()
  await gitFetch

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  expect(body.launchArgs?.split('\n')[0]).toBe(promptValue)
  // 本次创建：git 状态 + 笔记首段双附（git 殿后 = 弃段阶梯的保留优先级）
  expect(body.launchArgs).toContain(`项目笔记（${PROJ_NAME}）：`)
  expect(body.launchArgs).toContain('git 状态')
  expect(body.launchArgs).toContain(`分支 ${BRANCH}`)
  // 覆选只作用于本次：设置持久值未被对话框改动
  expect(await getSessionContext(request)).toBe('notes')
})

test('ask 发起族读同一设置：none 下右键目录新建会话 launchArgs 即定位前言原文', async ({ page, request }) => {
  await setSessionContext(request, 'none')
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})

  // 工具栏轮询重渲染会让元素瞬时失效：右键一律带重试（dir-agent-session 同款口径）
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout, button: 'right' }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }

  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  const row = page.locator('.tree-item').filter({ hasText: 'app.ts' })
  await clickRetry(row.first())
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible({ timeout: 10000 })
  await menu.getByText('在此目录新建 agent 会话', { exact: true }).click()

  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  // 根目录会话不附定位前言（P-102 既有），none 档连 git 状态也不附——launchArgs 即任务原文
  expect(body.launchArgs).toBe(DIR_PROMPT)
  expect(body.launchArgs).not.toContain('git 状态')
})
