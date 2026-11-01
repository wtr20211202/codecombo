import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话创建注入 git 状态摘要（P-20261003-176）E2E：
 *   1. 新建会话对话框「附带 git 状态」默认勾选：创建请求 launchArgs 在任务
 *      指令后追加分支行（分支名 + 未提交变更数 + 最近提交主题三事实齐备）
 *   2. 取消勾选：launchArgs 即任务指令原文（无摘要）
 *   3. 配额截断正确：指令 + 摘要超 500 字节时 UI 出「不附带」提示，提交
 *      launchArgs = 指令原文（放弃的是摘要，用户文本零截断）
 *   4. ask 发起族（文件树右键「在此目录新建 agent 会话」）默认注入：同一
 *      摘要行追加在定位前言之后（首行仍是任务——服务端按首行派生会话名）
 * 断言直接对 POST /api/terminals 请求体（launchArgs 内容），不与 TUI 交互；
 * 自备临时仓库（1 提交 + 1 个未提交修改 = 确定性三事实），afterEach 清理
 * 全部终端会话，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-agent-git-status')
const PROJ_NAME = 'e2e-agent-git-status'
const BRANCH = 'e2e-gs-main'
const COMMIT_SUBJECT = 'c1: seed commit'
// 出厂预置「解释当前文件」：未打开文件时 {file} 原样保留 → launchArgs 首行确定
const EXPLAIN_TPL = '解释当前文件'
const DIR_PROMPT = '请先熟悉当前目录的代码结构，然后等待我的具体任务。'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
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

/** 清理全部终端会话：断言基于请求体而非会话表计数，仍清理防运行时被拉起 */
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

// 会话残留会以 cwd 句柄占住夹具目录（Windows rmSync 静默失败）→ 下次 beforeAll
// 在残缺目录上重建即 git 报错——每例后清理与 editor-ask-agent 同纪律
test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
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
  // 显式定分支名：git init 默认分支名随本机配置漂移（master/main），断言要确定值
  git(REPO_DIR, ['symbolic-ref', 'HEAD', `refs/heads/${BRANCH}`])
  git(REPO_DIR, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', COMMIT_SUBJECT])
  // 1 个未提交修改（tracked Modified，无 untracked 噪音）→ 变更计数 = 1
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 2\n')

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
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

/** 打开新建会话对话框并等摘要预取（limit=1 的 log 请求）返回，消除取数竞态 */
async function openDialog(page: Page) {
  const summaryFetched = page.waitForResponse(
    r => r.url().includes('/api/projects/') && r.url().includes('/log') && r.url().includes('limit=1'),
  ).catch(() => null) // 已缓存命中时可能不发请求：不阻塞
  await page.locator('.atv-header-actions button').filter({ hasText: '新建会话' }).click()
  const dlg = page.locator('.n-modal').filter({ hasText: '新建智能体会话' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await summaryFetched
  return dlg
}

/** 选出厂预置模板（prompt 出现且已替换），返回指令文本（首行断言的事实源，
 *  不假设模板全文——出厂措辞可演进） */
async function selectTemplate(page: Page, dlg: ReturnType<Page['locator']>) {
  await dlg.locator('[data-testid="agent-template-select"] .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: EXPLAIN_TPL }).click()
  const promptBox = dlg.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(promptBox).toHaveValue(/请解释 \{file\}/, { timeout: 5000 })
  return promptBox.inputValue()
}

/** 摘要行断言（三事实 + 位于指令之后）：措辞改动只锚定事实值不锚全文 */
function expectSummaryFacts(launchArgs: string, firstLine: string) {
  expect(launchArgs.split('\n')[0]).toBe(firstLine)
  const summary = launchArgs.slice(firstLine.length + 1)
  expect(summary).toContain(`分支 ${BRANCH}`)
  expect(summary).toContain('1 处未提交变更')
  expect(summary).toContain(`最近提交：${COMMIT_SUBJECT}`)
  expect(new TextEncoder().encode(launchArgs).length).toBeLessThanOrEqual(500)
}

test('对话框默认勾选「附带 git 状态」：launchArgs 指令后追加分支行（分支+变更数+最近提交）', async ({ page }) => {
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  const promptValue = await selectTemplate(page, dlg)

  const checkbox = dlg.locator('[data-testid="agent-attach-git-status"]')
  await expect(checkbox).toBeVisible()
  // naive-ui n-checkbox 无真实 input 元素：勾选态走 aria-checked
  await expect(checkbox).toHaveAttribute('aria-checked', 'true')

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { kind?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expectSummaryFacts(body.launchArgs || '', promptValue)
})

test('取消勾选：launchArgs 即指令原文，无摘要行', async ({ page }) => {
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  const promptValue = await selectTemplate(page, dlg)

  await dlg.locator('[data-testid="agent-attach-git-status"]').click()
  await expect(dlg.locator('[data-testid="agent-attach-git-status"]')).toHaveAttribute('aria-checked', 'false')

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  expect(body.launchArgs).toBe(promptValue)
  expect(body.launchArgs).not.toContain('git 状态')
})

test('配额截断正确：指令+摘要超 500 字节 → 出「不附带」提示，提交为指令原文零截断', async ({ page }) => {
  await gotoAgentView(page)
  const dlg = await openDialog(page)
  await selectTemplate(page, dlg)

  // ~481 字节 ASCII 指令：单独 ≤500（预检放行），加摘要（fixture 摘要 ~113 字节
  // → 剩余配额 ~386）必超 → 摘要让位
  const longPrompt = 'Please review the following requirement and produce an implementation checklist: '
    + 'design review and code walkthrough for module X. '.repeat(8)
  expect(new TextEncoder().encode(longPrompt).length).toBeLessThanOrEqual(500)
  expect(new TextEncoder().encode(longPrompt).length).toBeGreaterThan(380)
  await dlg.locator('[data-testid="agent-template-prompt"] textarea').fill(longPrompt)

  const dropped = dlg.locator('[data-testid="agent-git-summary-dropped"]')
  await expect(dropped).toBeVisible()

  await dlg.locator('.n-form-item').filter({ hasText: '工作目录' }).locator('input').fill(serverPath(REPO_DIR))
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await dlg.locator('button').filter({ hasText: '创建' }).click()

  const body = (await createReq).postDataJSON() as { launchArgs?: string }
  // 对话框按既有口径 trim 指令后提交（promptText.value.trim()），尾随空格不外发
  expect(body.launchArgs).toBe(longPrompt.trim())
  expect(body.launchArgs).not.toContain('git 状态')
})

test('ask 发起族（右键在此目录新建 agent 会话）默认注入：摘要追加在定位前言之后', async ({ page }) => {
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

  // 摘要取数（log limit=1）与创建请求都在菜单项点击之后发生：监听先于点击挂上
  const summaryFetched = page.waitForResponse(
    r => r.url().includes('/api/projects/') && r.url().includes('/log') && r.url().includes('limit=1'),
  )
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')

  // 右键根文件行（app.ts）→ 父目录=项目根；文件树右键菜单是 NDropdown
  //（无 role=menuitem），走 .n-dropdown-menu + 文本定位
  const row = page.locator('.tree-item').filter({ hasText: 'app.ts' })
  await clickRetry(row.first())
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible({ timeout: 10000 })
  await menu.getByText('在此目录新建 agent 会话', { exact: true }).click()

  await summaryFetched
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expectSummaryFacts(body.launchArgs || '', DIR_PROMPT)
})
