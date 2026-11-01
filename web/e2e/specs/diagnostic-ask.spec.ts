import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 诊断「问智能体：解释此错误」（P-20261006-2）E2E：
 *   1. 编辑器 code action 入口：打开含 TS2322 类型错误的 ts 文件 → 光标落进
 *      波浪线区间（Home + ArrowRight 定位到字面量首列）→ Ctrl+.（Monaco 内建
 *      quickFix 键位）弹 code action 菜单出现「问智能体：解释此错误」→ 触发后
 *      create 请求 launchArgs（prompt）含结构化载荷：错误消息全文 + 来源/错误码
 *      （typescript(2322)，ts.worker 的 marker source 缺省由 owner 兜底）+
 *      文件:行:列定位头，dir=项目根，agent 会话创建并在 docked 管理页激活
 *   2. 问题面板条目入口（聚合域同款动作）：问题面板条目行「问智能体」钮 →
 *      同链发起，载荷同构（消息全文 + typescript(2322) + 定位头）
 * 载荷断言经请求拦截读 create 请求体（ask-selection 同款口径）；prompt 服务端
 * 按 UTF-8 字节计 500 上限（超限直接 400），断言组装端已内建裁剪。
 * 自备临时仓库，afterEach 清理全部终端会话，afterAll 清理项目与夹具。
 * 注：Monaco code action 菜单在 shadow DOM，Playwright locator 自动穿透。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diagnostic-ask')
const PROJ_NAME = 'e2e-diagnostic-ask'
const FILE = 'broken.ts'
// TS2322 锚点行：`const topBad: number = 'top type error'`，波浪线覆盖字面量
// （首列 = 第 24 列，光标经 Home + 23×ArrowRight 精确落位，不依赖像素命中）
const BAD_LINE = 'const topBad: number = \'top type error\''
const LITERAL_START_COL = 24
const API = API_BASE

let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API}/api/terminals/${s.id}`, { headers })
  }
}

/** 捕获 POST /api/terminals（创建会话）请求体：断言 launchArgs 即 prompt 内容。
 *  pathname 精确到 /api/terminals 结尾——paste-image 等子路径不计 */
function watchAgentCreate(page: Page) {
  const payloads: { kind?: string; dir?: string; launchArgs?: string }[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    try {
      if (new URL(req.url()).pathname.endsWith('/api/terminals')) {
        payloads.push(req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string })
      }
    } catch { /* URL 解析失败非创建请求，忽略 */ }
  })
  return payloads
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), `${BAD_LINE}\n// filler\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add broken'])

  const res = await fetch(`${API}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并打开夹具文件，等 ts.worker 诊断落地（状态栏徽标 errors=1） */
async function openFileWithDiagnosis(page: Page) {
  await fixedLocale(page)
  // docked 管理页开合状态是 localStorage（每用例新 context 天然干净），显式清
  // 一次防未来 context 复用时盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  // ts.worker 冷启动 + 语义诊断异步产出（problems-panel 同款就绪口径）
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-errors')).toHaveText('1', { timeout: 60000 })
}

/** 光标精确落进波浪线首列（Home + N×ArrowRight，列定位不依赖像素命中）；
 *  首击有 EditContext 输入承载创建的吞键竞态（ask-selection 同款），带重试 */
async function placeCursorInSquiggle(page: Page) {
  const line1 = page.locator('.monaco-editor .view-line').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line1.click({ position: { x: 10, y: 8 } })
    await page.keyboard.press('Home')
    for (let i = 1; i < LITERAL_START_COL; i++) await page.keyboard.press('ArrowRight')
    // 光标态经位置徽标断言（P-20261004-141 Ln/Col 徽标随光标事件实时刷新）
    const badge = page.locator('[data-testid="cursor-pos-badge"]')
    const badgeText = await badge.textContent().catch(() => '')
    if (badgeText && badgeText.replace(/\s/g, '').includes(`Ln1,Col${LITERAL_START_COL}`)) return
  }
  throw new Error(`光标未落到第 ${LITERAL_START_COL} 列（位置徽标未确认）`)
}

/** 触发「问智能体：解释此错误」并等 create 请求发出：code action 菜单是
 *  Monaco actionWidget（.action-widget .action 行，0.55 非 .monaco-menu），点击
 *  行即接受（List onMouseClick→accept）；headless 下点击偶发无效，备选 Enter
 *  （菜单可见时 Monaco 内建 accept 键位）。每轮先确保菜单在开（失焦被关时重按
 *  Ctrl+.）——Enter 绝不在菜单关闭时发（否则落编辑器变插行，挪动诊断行）；
 *  直至 POST /api/terminals 发出（载荷已捕获即停手防重复建会话，发起链自身
 *  busy 让位双保险） */
async function driveDiagnosticAskItem(
  page: Page,
  menu: ReturnType<Page['locator']>,
  askItem: ReturnType<Page['locator']>,
  payloads: { kind?: string; dir?: string; launchArgs?: string }[],
) {
  for (let attempt = 0; attempt < 6 && payloads.length === 0; attempt++) {
    if (!(await menu.first().isVisible().catch(() => false))) {
      await page.keyboard.press('Control+.')
      await expect(menu.first()).toBeVisible({ timeout: 5000 }).catch(() => { /* 下一轮再试 */ })
    }
    if (attempt % 2 === 0) {
      await askItem.click({ timeout: 3000 }).catch(() => { /* 菜单瞬时失焦即关：下一轮键盘 */ })
    } else {
      await page.keyboard.press('Enter')
    }
    await expect
      .poll(() => payloads.length, { timeout: 2000, intervals: [200, 500, 1000] })
      .toBeGreaterThan(0)
      .catch(() => { /* 本轮未触发：换下一轮驱动方式 */ })
  }
}

/** 结构化载荷公共断言：kind/dir + 定位头 + 来源/错误码 + 消息全文 + 字节上限 */
function expectStructuredPayload(body: { kind?: string; dir?: string; launchArgs?: string }) {
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  // 定位头：文件 + 行:列（列取 marker 起点，字面量首列附近；用正则防脆）
  expect(prompt).toMatch(new RegExp(`请解释 ${FILE} 第 1 行第 \\d+ 列的诊断错误`))
  // 结构化来源/错误码：ts.worker marker source 缺省由 owner（typescript）兜底
  expect(prompt).toContain('（typescript(2322)）')
  // 错误消息全文（保头不裁——短消息整段在场）
  expect(prompt).toContain('is not assignable to type')
  // 服务端按字节计 500 上限（超限直接 400）：prompt 组装必须已内建裁剪
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)
}

test('诊断行 code action（Ctrl+.）→「问智能体：解释此错误」→ 结构化载荷入新会话', async ({ page }) => {
  await openFileWithDiagnosis(page)
  await placeCursorInSquiggle(page)
  const payloads = watchAgentCreate(page)

  // Ctrl+. = Monaco 内建 quickFix（Invoke 触发）→ code action 菜单出现本入口
  await page.keyboard.press('Control+.')
  const menu = page.locator('.action-widget')
  await expect(menu.first()).toBeVisible({ timeout: 5000 })
  const askItem = menu.first().locator('.action').filter({ hasText: '问智能体：解释此错误' })
  await expect(askItem, '诊断区间内 → code action 菜单出现「问智能体：解释此错误」').toBeAttached()
  await driveDiagnosticAskItem(page, menu, askItem, payloads)

  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  expectStructuredPayload(payloads[0]!)

  // docked 管理页出现、恰好一个会话且激活
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)
})

test('问题面板条目「问智能体」钮（聚合域入口）→ 同链结构化载荷', async ({ page }) => {
  await openFileWithDiagnosis(page)
  const payloads = watchAgentCreate(page)

  // 开问题面板（状态栏徽标点击，problems-panel 同款链）
  await page.locator('[data-testid="statusbar-problems"]').click()
  const panel = page.locator('[data-testid="problems-panel"]')
  await expect(panel).toBeVisible()
  const askBtn = panel.locator('[data-testid="problems-ask-1"]')
  await expect(askBtn, '诊断条目行出现「问智能体」动作钮').toBeVisible()
  await askBtn.click()

  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  expectStructuredPayload(payloads[0]!)

  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
})
