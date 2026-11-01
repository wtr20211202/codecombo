import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 拆分建议「逐组执行」（P-20261003-278）E2E（commit-split-suggest.spec.ts 同款
 * 结构 + git-activity-tui.spec.ts 的 broadcast-write/scrollback 注入手法）：
 *
 * agent 会话在 e2e 环境无运行时产出，结构化分组方案经 broadcast-write 原样写
 * 入会话 PTY（不带 \r 不执行——终端回显即落在 scrollback，与真实 agent 输出
 * 同一读取面：GET /terminals/:id/scrollback 原始捕获字节），前置 prompt 污染
 * （行首提示符）与终端宽度折行都由前端解析面兜住。
 *
 *   1. 拆分建议发起（launchArgs 含文件名 + ```json 输出格式约定）→ 注入两组
 *      方案 → 「逐组执行」确认弹层逐组预览 → 确认 → 服务端逐组 stage/commit，
 *      两组提交按序落库、各组恰好含自己文件
 *   2. 失败中断报告：第二组文件不存在 → 首组落库后中断，报告弹层呈现失败组/
 *      步骤（暂存失败）与剩余组不执行
 * 自备临时仓库，beforeEach/afterEach 清空终端会话，afterAll 清理项目与夹具
 */

// 仓库目录带运行唯一后缀：上一轮进程的 rmSync 撞存活句柄（Windows 下 e2e
// 服务端对注册项目路径的打开句柄）会留下陈旧仓库，固定名复用会踩
// 「nothing to commit」——唯一目录从根上消除跨运行状态
const REPO_DIR = path.join(os.tmpdir(), `sc-e2e-commit-split-execute-${process.pid}-${Date.now()}`)
const PROJ = 'e2e-commit-split-execute'
const F1 = 'alpha-split.txt'
const F2 = 'beta-split.txt'
const F3 = 'gamma-split.txt'

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

/** 清理全部终端会话：会话锚点按 id 记账，残留会话会污染 */
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
  // repo 级身份（commit-actions.spec 同款）：逐组提交在服务端进程执行，读不到
  // CLI 侧 -c 身份，不落 config 会 "Author identity unknown" 全组中断
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'commit split execute baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 逐组执行基线'])
  // 造 2 个 staged 变更（注册项目使服务端 status 缓存失效，进项目首拉即含）
  fs.writeFileSync(path.join(REPO_DIR, F1), `${F1} staged content\n`)
  fs.writeFileSync(path.join(REPO_DIR, F2), `${F2} staged content\n`)
  git(REPO_DIR, ['add', '.'])
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
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略（唯一目录名无跨运行污染） */ }
  // 显式 await：进程退出时在途 fetch 会触发 libuv win 断言（async.c）崩掉 worker
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  }).catch(() => {})
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
  // agent 终端开合状态是 localStorage（每用例新 context 天然干净），显式清一次
  // 防未来 context 复用时 docked 管理页盖住变更面板
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
}

function splitBtn(page: Page) {
  return page.locator('.commit-panel [data-testid="suggest-commit-split"]')
}
function execBtn(page: Page) {
  return page.locator('.commit-panel [data-testid="execute-commit-split"]')
}

/** 剥 CSI 与 OSC 转义序列（与终端搜索 StripANSI 同语义的用例内实现） */
function stripAnsi(s: string) {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/** 服务端唯一的 agent 会话（id 取列表——create 响应形状不对用例承诺） */
async function onlyAgentSessionId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  return agents[0]!.id
}

/** 向建议会话原样写入结构化方案（PTY 原始输入、不带 \r 不执行——终端回显即
 *  落 scrollback）。回显就绪判定用「注入文本唯一尾段」且对折行归一（换行剥除
 *  后 contains）——prompt 回显天然含 "groups"，按弱标记会过早放行；标记命中后
 *  再给回显落定宽限（ConPTY/tmux 分帧重渲染的中间态不作为解析面） */
async function injectSuggestion(request: APIRequestContext, sessionId: string, suggestion: string): Promise<void> {
  const headers = await unlockHeaders(request)
  const w = await request.post(`${API_BASE}/api/terminals/broadcast-write`, { headers, data: { ids: [sessionId], data: suggestion } })
  expect(w.status()).toBe(200)
  const tail = suggestion.slice(-12)
  const deadline = Date.now() + 20000
  let text = ''
  while (Date.now() < deadline) {
    const r = await request.get(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers })
    if (r.ok) {
      text = stripAnsi(await r.text())
      if (text.replace(/\r?\n/g, '').includes(tail)) {
        await new Promise(r2 => setTimeout(r2, 800)) // 回显落定宽限
        return
      }
    }
    await new Promise(r2 => setTimeout(r2, 400))
  }
  throw new Error(`方案注入失败（scrollback 未含方案尾段），末尾内容：${text.slice(-300)}`)
}

/** 拆分建议发起（断言 launchArgs 携带文件与 ```json 输出格式约定）→ 注入方案
 *  → 收起 docked 管理页回变更面板（rail toggle，会话锚点在内存不丢） */
async function suggestAndInject(page: Page, request: APIRequestContext, suggestion: string): Promise<void> {
  const createReq = page.waitForRequest(r => r.url().includes('/api/terminals') && r.method() === 'POST')
  await splitBtn(page).click()
  const body = (await createReq).postDataJSON() as { kind?: string; dir?: string; launchArgs?: string }
  expect(body.kind).toBe('agent')
  expect(body.dir).toBe(serverPath(REPO_DIR))
  expect(body.launchArgs).toContain('勿执行 git add/commit')
  // 结构化输出约定（P-20261003-278）：```json 代码块 + groups wire 形态
  expect(body.launchArgs).toContain('"groups"')
  expect(body.launchArgs).toContain('```json')

  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
  const sessionId = await onlyAgentSessionId(request)
  await injectSuggestion(request, sessionId, suggestion)
  // docked 管理页盖住变更面板：rail 按钮再点一次即收起（toggle 语义），内存
  // 会话锚点保留——「逐组执行」入口仍可见
  await page.locator('[data-testid="rail-agent-terminal"]').click()
  await expect(page.locator('.commit-panel')).toBeVisible()
}

test('确认后逐组 stage/commit：注入两组方案 → 预览确认 → 两组提交按序落库', async ({ page, request }) => {
  await enterProject(page)
  // 未发起过拆分建议时执行入口隐藏（模块级会话锚点）
  await expect(execBtn(page)).toHaveCount(0)
  await expect(splitBtn(page)).toBeEnabled()

  await suggestAndInject(page, request,
    '```json{"groups":[{"name":"界面","files":["' + F1 + '"],"subject":"feat: alpha"},{"name":"文档","files":["' + F2 + '"],"subject":"docs: beta"}]}```')

  // 入口出现（会话锚点在位）→ 点击读会话输出 → 确认弹层逐组预览
  await expect(execBtn(page)).toBeEnabled()
  await execBtn(page).click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '确认逐组执行' })
  await expect(dialog).toBeVisible({ timeout: 15000 })
  await expect(dialog).toContainText('将按以下 2 组')
  await expect(dialog).toContainText('feat: alpha')
  await expect(dialog).toContainText(F1)
  await expect(dialog).toContainText('docs: beta')
  await expect(dialog).toContainText(F2)

  const execRes = page.waitForResponse(r => r.url().includes('/commit-split-execute') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '确认执行' }).click()
  const res = await execRes
  expect(res.status()).toBe(200)
  const report = ((await res.json()) as { data?: { total: number; executed: unknown[]; failed: unknown } }).data
  expect(report?.executed).toHaveLength(2)
  expect(report?.failed).toBeNull()

  // 两组提交按组序落库，每组恰好含自己的文件（git commit 提交整个 index，
  // 组间不混入靠逐组 stage 后立即提交）
  await expect.poll(() => git(REPO_DIR, ['log', '-1', '--format=%s'])).toBe('docs: beta')
  expect(git(REPO_DIR, ['log', '--format=%s', '-3']).split('\n')).toEqual(['docs: beta', 'feat: alpha', 'root: 逐组执行基线'])
  expect(git(REPO_DIR, ['show', '--name-only', '--format=', 'HEAD']).split('\n').filter(Boolean)).toEqual([F2])
  expect(git(REPO_DIR, ['show', '--name-only', '--format=', 'HEAD~1']).split('\n').filter(Boolean)).toEqual([F1])
  // 成功提示（toast）+ 无残留弹层
  await expect(page.locator('.n-message').filter({ hasText: '已按 2 组完成逐组提交' })).toBeVisible({ timeout: 10000 })
})

test('失败中断报告：第二组文件不存在 → 首组落库后中断并如实呈现', async ({ page, request }) => {
  // 确定性基线（与上例成败无关）：工作区/暂存区归位到 HEAD、清未跟踪，再构造
  // 「F1 追加改动 + 新文件 F3」两组暂存
  git(REPO_DIR, ['reset'])
  git(REPO_DIR, ['checkout', '--', '.'])
  try { git(REPO_DIR, ['clean', '-fd']) } catch { /* 无未跟踪即非零退出，忽略 */ }
  fs.appendFileSync(path.join(REPO_DIR, F1), 'more alpha\n')
  fs.writeFileSync(path.join(REPO_DIR, F3), `${F3} staged content\n`)
  git(REPO_DIR, ['add', '.'])
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(2)

  await enterProject(page)
  await suggestAndInject(page, request,
    '```json{"groups":[{"name":"阿尔法","files":["' + F1 + '"],"subject":"fix: alpha"},{"name":"缺文件","files":["no-such-file.txt"],"subject":"fix: missing"}]}```')

  await expect(execBtn(page)).toBeEnabled()
  await execBtn(page).click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '确认逐组执行' })
  await expect(dialog).toBeVisible({ timeout: 15000 })

  const execRes = page.waitForResponse(r => r.url().includes('/commit-split-execute') && r.request().method() === 'POST')
  await dialog.getByRole('button', { name: '确认执行' }).click()
  const res = await execRes
  expect(res.status()).toBe(200)
  const report = ((await res.json()) as { data?: { executed: { subject: string }[]; failed: { step: string; error: string } | null; remaining: number } }).data
  expect(report?.executed.map(e => e.subject)).toEqual(['fix: alpha'])
  expect(report?.failed?.step).toBe('stage')
  expect(report?.failed?.error).toContain('no-such-file.txt')
  expect(report?.remaining).toBe(0)

  // 中断报告弹层：失败组、步骤（暂存失败）、git 错误原文；无成功提示
  const reportDialog = page.locator('.n-dialog').filter({ hasText: '逐组执行中断报告' })
  await expect(reportDialog).toBeVisible({ timeout: 15000 })
  await expect(reportDialog).toContainText('fix: alpha')
  await expect(reportDialog).toContainText('中断于')
  await expect(reportDialog).toContainText('暂存 失败')
  await expect(reportDialog).toContainText('no-such-file.txt')
  await expect(page.locator('.n-message').filter({ hasText: '已按' })).toHaveCount(0)

  // 首组已落库且不回滚；失败组之后不再执行
  expect(git(REPO_DIR, ['log', '-1', '--format=%s'])).toBe('fix: alpha')
  expect(git(REPO_DIR, ['status', '--porcelain', F3]).trim()).not.toBe('')
  await reportDialog.getByRole('button', { name: '确认', exact: true }).click()
})
