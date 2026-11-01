import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 选区内联 AI 编辑入口（P-20261005-206）E2E：
 *   1. 键位：选区后 Ctrl+K 触发就地 prompt 浮层（Monaco addAction 编辑器域，
 *      precondition editorHasSelection；无选区不接管——内建 chord 前缀/命令面板
 *      既有行为不变）
 *   2. 主链：浮条（选区即浮）→ 浮层输入指令 → 发送组装结构化指令（文件路径+
 *      行号区间+选区内容+指令，单行）入活跃会话指令队列（POST /terminals/:id/queue）
 *      → toast + 跳 docked 会话面板
 *   3. 无活跃会话：发送 → 引导打开新建会话对话框、指令预填（指令暂存），不入队
 *   触发口径沿用 ask-selection.spec 的选区/右键重试经验：键盘选区经「重试点选 +
 *   选区渲染轮询」收敛。结构化指令断言经请求拦截读 queue 请求体。
 *   自备临时仓库，afterEach 清理全部终端会话，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-inline-edit')
const PROJ_NAME = 'e2e-inline-edit'
const FILE = 'app.ts'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

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

/** 清理全部终端会话：无会话引导态断言基于空白会话表，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 建一个 agent 会话（发送链的目标：活跃会话）。API 直建不经 UI（shared 层
 * createAgentSession 是对话框 UI 驱动面，语义不同） */
async function createAgentSessionViaApi(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent' },
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

/** 捕获 POST /terminals/:id/queue（指令入队）请求体：断言结构化指令 */
function watchQueuePost(page: Page) {
  const payloads: { id: string; text: string }[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    const m = new URL(req.url()).pathname.match(/\/api\/terminals\/([^/]+)\/queue$/)
    if (m) payloads.push({ id: m[1]!, text: (req.postDataJSON() as { text?: string }).text || '' })
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

/** 进入项目页并打开夹具文件（ask-selection 同款就绪等待/重试口径） */
async function openFile(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage，显式清一次防 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  // 整词锚定 .project-name（CLAUDE.md 测试纪律：整卡 hasText 子串匹配禁用）
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
  // uiState 存在服务端且跨用例共享：邻域 spec 关过侧栏时进项目页文件树不可见
  // （restoreLayoutOnly 恢复 showSidePanel:false）。rail「项目文件」是 toggle
  // （core-workflow ensureFilesView 同款）：树未加载完探测会假阴性，最多 3 次
  // 奇数点击保证最终停在打开态
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
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

/** 键盘选中前两行（ask-selection 同款重试口径：EditContext 接线竞态 + 渲染帧竞态） */
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
    } catch { /* 选区未渲染/键盘被吞：重试点选 */ }
  }
  throw new Error('键盘选区未落上（.selected-text 未出现）')
}

test('选区浮条 + Ctrl+K 触发就地浮层（无选区不接管命令面板键）', async ({ page }) => {
  await openFile(page)
  // 无选区：浮条不出现
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 10, y: 8 } })
  await expect(page.getByTestId('inline-edit-bar')).toHaveCount(0)

  // 选区 → 浮条浮出；点编辑器他处（选区塌缩）→ 浮条消失
  await selectFirstTwoLines(page)
  await expect(page.getByTestId('inline-edit-bar')).toBeVisible({ timeout: 5000 })
  await page.locator('.monaco-editor .view-line').first().click({ position: { x: 10, y: 8 } })
  // content widget 隐藏 = display:none（DOM 常驻），断言可见性而非元素数
  await expect(page.getByTestId('inline-edit-bar')).toBeHidden()
  await selectFirstTwoLines(page)

  // Ctrl+K：有选区 → 浮层浮出且输入聚焦（编辑器域键位接管）
  await page.keyboard.press('Control+k')
  const prompt = page.getByTestId('inline-edit-prompt')
  await expect(prompt).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('inline-edit-input')).toBeFocused()
  // 命令面板未被误开（Ctrl+K 在布局注册表也是 commandPalette 默认键）
  await expect(page.locator('.palette-mask')).toHaveCount(0)

  // Esc 关浮层，浮条因选区塌缩（浮层打开时点击塌缩选区）不再出现——浮层独占收口
  await page.keyboard.press('Escape')
  await expect(prompt).toBeHidden({ timeout: 3000 })
})

test('浮层发送 → 结构化指令入活跃会话队列 + toast + 跳会话面板', async ({ page, request }) => {
  await createAgentSessionViaApi(request)
  await openFile(page)
  const payloads = watchQueuePost(page)

  await selectFirstTwoLines(page)
  await expect(page.getByTestId('inline-edit-bar')).toBeVisible({ timeout: 5000 })
  // 浮条按钮入口（与 Ctrl+K 并列的发现面）
  await page.getByTestId('inline-edit-open').click()
  await expect(page.getByTestId('inline-edit-prompt')).toBeVisible({ timeout: 5000 })
  const input = page.getByTestId('inline-edit-input')
  await expect(input).toBeFocused()
  await input.fill('给这段代码加上空值保护')
  await page.keyboard.press('Enter')

  // queue 请求：结构化指令 = 指令 + 文件路径 + 行号区间 + 选区代码，单行
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const { id, text } = payloads[0]!
  const headers = await unlockHeaders(request)
  const listRes = await request.get(`${BASE}/api/terminals`, { headers })
  const sessions = ((await listRes.json()) as { data?: { id: string }[] }).data || []
  expect(sessions.some(s => s.id === id), '发送目标 = 存量会话').toBe(true)
  expect(text).toContain('给这段代码加上空值保护')
  expect(text).toContain('app.ts')
  expect(text).toContain('1-2')
  expect(text).toContain('export function hello(name: string): string {')
  expect(text).not.toContain('\n', '排队指令单行语义（服务端 sanitizeInstruction 同款）')

  // toast（已发送/已排队两态）+ docked 会话面板承接过程可见性
  await expect(page.locator('.n-message').filter({ hasText: '会话' }).first()).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 15000 })
})

test('无活跃会话发送 → 引导打开新建会话对话框且指令预填（指令暂存），不入队', async ({ page }) => {
  await openFile(page)
  const payloads = watchQueuePost(page)

  await selectFirstTwoLines(page)
  await expect(page.getByTestId('inline-edit-bar')).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+k')
  await expect(page.getByTestId('inline-edit-prompt')).toBeVisible({ timeout: 5000 })
  await page.getByTestId('inline-edit-input').fill('重构这段循环')
  await page.keyboard.press('Enter')

  // 不入队 + 引导对话框预填结构化指令（NewSessionDialog prefillPrompt 面）
  await expect.poll(() => payloads.length, { timeout: 10000 }).toBe(0)
  const dialogPrompt = page.getByTestId('agent-template-prompt').locator('textarea')
  await expect(dialogPrompt).toBeVisible({ timeout: 15000 })
  await expect(dialogPrompt).toHaveValue(/重构这段循环/)
  expect(await dialogPrompt.inputValue(), '预填含文件定位（指令暂存完整结构化指令）').toContain('app.ts')
  await expect(page.locator('.n-message').filter({ hasText: '未发现活跃会话' }).first()).toBeVisible({ timeout: 8000 })
})
