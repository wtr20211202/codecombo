import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器选区「询问智能体选中代码」（P-20261002-122）E2E：
 *   1. 选中两行代码 → 编辑器右键菜单出现「询问智能体选中代码」→ 触发后
 *      create 请求 launchArgs（prompt）含行号头部 + 选中代码全文，agent
 *      会话创建并在 docked 管理页激活（服务端 dir=项目根）
 *   2. 无选区 → 菜单项不出现（descriptor.precondition 挂 Monaco 内建
 *      editorHasSelection，standaloneCodeEditor 把它编为菜单项 when——
 *      无选区隐藏而非置灰，任务书「置灰/隐藏按原文」取隐藏）
 * 触发口径：真实浏览器右键菜单项鼠标点击即动作；headless 下 shadow DOM
 * 菜单聚焦状态不定，点击与聚焦+Enter 都实测偶发无效（且先后顺序影响结果）——
 * driveAskItem 两者交替重试直至 create POST 发出。prompt 内容断言经请求拦截
 * 读 create 请求体（launchArgs 即 prompt，服务端原样追加在运行时命令后）。
 * 菜单在 shadow DOM，Playwright locator 自动穿透。
 * 自备临时仓库，afterEach 清理全部终端会话（会按设置拉起底层运行时，只断言
 * 创建链路不与 TUI 交互），afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-ask-selection')
const PROJ_NAME = 'e2e-ask-selection'
const FILE = 'app.ts'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

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
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
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
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), `export function hello(name: string): string {\n  return \`hello \${name}\`\n}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: add app'])

  // 注册项目：本地路径交服务端一律 serverPath() 包裹（跨拓扑双路径口径）
  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并打开夹具文件（editor-ask-agent 同款就绪等待/重试口径） */
async function openFile(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // 树加载就绪：加载指示消失且首个条目可见（而非盲目固定等待）
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 工具栏轮询重渲染会让元素瞬时失效：点击一律带重试
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await clickRetry(page.getByText(FILE).first(), 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

/** 键盘选中前两行（第 1 行首 → 第 2 行尾）并断言选区真实落上：两个实测竞态
 *  都靠「重试点选 + 轮询判定」收敛——(a) 首击创建 Monaco 输入承载（新版
 *  .native-edit-context/EditContext）瞬间接线未完成，键盘事件被吞（取证：
 *  activeElement 已是 native-edit-context 但方向键不产生选区）；(b) 选区已
 *  进模型/DOM（.selected-text 带尺寸）但渲染帧未落地，isVisible 瞬时判定为
 *  假——判定改 expect 轮询（toBeVisible 2s），未落上再点选重试 */
async function selectFirstTwoLines(page: Page) {
  const line1 = page.locator('.monaco-editor .view-line').first()
  const selected = page.locator('.monaco-editor .selected-text').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line1.click({ position: { x: 10, y: 8 } })
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('End')
    await page.keyboard.up('Shift')
    try {
      await expect(selected).toBeVisible({ timeout: 2000 })
      return
    } catch { /* 选区未渲染/键盘被吞：重试点选（EditContext 接线随时间完成） */ }
  }
  throw new Error('键盘选区未落上（.selected-text 未出现）')
}

/** 打开编辑器右键菜单并返回「询问智能体选中代码」菜单项（菜单在 shadow
 *  DOM，Playwright locator 自动穿透；无选区时该项被 when 隐藏不渲染） */
async function openContextMenuAndGetAskItem(page: Page) {
  // 右键第 1 行（选区覆盖 1-2 行，选区内右键不塌缩选区）
  await page.locator('.monaco-editor .view-line').first().click({ button: 'right' })
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  const askItem = menu.first().locator('.action-item').filter({ hasText: '询问智能体选中代码' })
  return { menu, askItem }
}

/** 触发「询问智能体选中代码」并等 create 请求发出：真实浏览器菜单项鼠标
 *  点击即动作；headless 下 shadow DOM 菜单的聚焦状态不定，实测鼠标点击与
 *  键盘 Enter（聚焦后）都偶发无效——两者交替重试直至 POST /api/terminals
 *  发出（载荷由 watchAgentCreate 捕获，一旦发出立即停手，防重复建会话） */
async function driveAskItem(
  page: Page,
  askItem: ReturnType<Page['locator']>,
  payloads: { kind?: string; dir?: string; launchArgs?: string }[],
) {
  for (let attempt = 0; attempt < 6 && payloads.length === 0; attempt++) {
    if (attempt % 2 === 0) {
      await askItem.click({ timeout: 3000 }).catch(() => { /* 菜单瞬时失焦即关：下一轮键盘 */ })
    } else {
      await askItem.focus()
      await expect(askItem).toBeFocused().catch(() => { /* 焦点被夺：下一轮重试 */ })
      await page.keyboard.press('Enter')
    }
    await expect
      .poll(() => payloads.length, { timeout: 2000, intervals: [200, 500, 1000] })
      .toBeGreaterThan(0)
      .catch(() => { /* 本轮未触发：换下一轮驱动方式 */ })
  }
}

test('选中两行右键「询问智能体选中代码」→ agent 会话创建且 prompt 含选中代码', async ({ page, request }) => {
  await openFile(page)
  const payloads = watchAgentCreate(page)

  await selectFirstTwoLines(page)

  const { askItem } = await openContextMenuAndGetAskItem(page)
  await expect(askItem, '有选区 → 菜单项出现（precondition editorHasSelection 为真）').toBeAttached()
  await driveAskItem(page, askItem, payloads)

  // create 请求体：kind=agent、dir=项目根、launchArgs = 行号头部 + 选中代码全文
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt).toContain('app.ts 第 1-2 行选中的代码：')
  expect(prompt, '选区第 1 行注入 prompt').toContain('export function hello(name: string): string {')
  expect(prompt, '选区第 2 行注入 prompt').toContain('return `hello ${name}`')
  // 服务端按字节计 500 上限（超限直接 400）：prompt 组装必须已内建裁剪
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现、恰好一个会话且激活；服务端会话表 dir=项目根
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string; path?: string }[] }).data || []
  const agents = list.filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0].path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
})

test('无选区右键：菜单项隐藏（precondition 经 standaloneCodeEditor 编为 when）', async ({ page }) => {
  await openFile(page)
  // 纯光标点击（无选区）后开右键菜单
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 10, y: 8 } })
  const { menu, askItem } = await openContextMenuAndGetAskItem(page)
  // 菜单本体在（对照：Git 组等无 precondition 项恒在），选区询问项被 when 隐藏
  await expect(menu.first().getByText('查看文件历史')).toBeAttached()
  await expect(askItem, '无选区 → editorHasSelection 假 → 菜单项隐藏').toHaveCount(0)
  await page.keyboard.press('Escape')
})
