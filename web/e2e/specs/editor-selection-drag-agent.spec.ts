import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器选区 Alt+拖拽到 agent 侧栏（P-20261003-162）E2E：
 *   ① Alt+拖选中代码 → 拖影出现 → 悬停 rail「终端会话管理」spring-open 展开
 *      docked 管理页 → 落会话行：选中该会话并把「定位头 + 选区原文」粘贴进
 *      其输入行（xterm paste，不发 Enter）；scrollback 只出现一次 marker
 *      （若被回车执行会多出输出行）——同时验证「不自动发送」
 *   ② 落「新建会话」区：新建对话框打开且指令预填选区上下文，不自动创建
 *   ③ 落空（拖到非落点松手）：不展开管理页、不弹对话框、无拖影残留
 * 注：编辑器与 docked 管理页互斥，源侧 spring-open 是拖拽中展开侧栏的唯一
 * 路径（见 views/editor/selectionDrag 头注）；shell 会话由 API 造（runtime=shell
 * 不拉起 TUI，断言只依赖 PTY scrollback 事实源）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-selection-drag')
const PROJ = 'e2e-selection-drag'
const FILE = 'drag.ts'
const MARK = 'SC_DRAG_MARKER_162'
const SESSION_NAME = 'e2e-selection-drag-sess'
const FILE_CONTENT = [
  '// selection drag fixture',
  `echo ${MARK}`,
  'export function run() {',
  '  return dragTarget',
  '}',
  '',
].join('\n')

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：侧栏行/scrollback 断言基于空白会话表 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
}

/** API 造纯终端系统会话（runtime=shell），返回 id */
async function createShellSession(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-selection-drag-sess-'))
  const created = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name: SESSION_NAME, runtime: 'shell', dir: serverPath(dir) },
  })
  expect(created.ok()).toBeTruthy()
  const list = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  const session = ((list?.data || []) as { id: string; name: string }[]).find(s => s.name === SESSION_NAME)
  expect(session, `会话 ${SESSION_NAME} 应出现在列表`).toBeTruthy()
  return session!.id
}

async function scrollbackOf(request: APIRequestContext, sessionId: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers })
  return (await res.body()).toString('utf-8')
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
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), FILE_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: selection drag fixture'])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(res.status)
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并打开夹具文件 */
async function openFixtureFile(page: Page) {
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.removeItem('sc.agentTerminal.openState'))
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  await page.getByText(FILE).first().click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

/** 键盘选中第 2-3 行并断言选区真实落上（ask-selection 同款重试收敛） */
async function selectFixtureLines(page: Page) {
  const line2 = page.locator('.monaco-editor .view-line').nth(1)
  const selected = page.locator('.monaco-editor .selected-text').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line2.click({ position: { x: 10, y: 8 } })
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

/** Alt+按住拖影起手：从选区内部按下并移过阈值，返回拖影 locator */
async function startAltDrag(page: Page) {
  const box = await page.locator('.monaco-editor .selected-text').first().boundingBox()
  expect(box, '选区应有可拖拽几何').toBeTruthy()
  await page.keyboard.down('Alt')
  await page.mouse.move(box!.x + 8, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + 60, box!.y + box!.height / 2, { steps: 5 })
  const ghost = page.locator('.sc-selection-drag-ghost')
  await expect(ghost, 'Alt+拖启动后出现拖影').toBeVisible({ timeout: 3000 })
  return ghost
}

/** 悬停 rail 入口触发 spring-open，等 docked 管理页出现 */
async function springOpenAgentManager(page: Page) {
  const rail = page.locator('[data-testid="rail-agent-terminal"]')
  await expect(rail).toBeVisible()
  const box = await rail.boundingBox()
  expect(box).toBeTruthy()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 6 })
  await expect(page.locator('.atv-root'), '悬停 rail 400ms 后展开 docked 管理页').toBeVisible({ timeout: 8000 })
}

/** 松开鼠标/Alt（无论断言成败都由用例末尾调用） */
async function releaseDrag(page: Page) {
  await page.mouse.up()
  await page.keyboard.up('Alt')
}

test('Alt+拖到会话行：追加到该会话输入框且不自动发送', async ({ page, request }) => {
  const sessionId = await createShellSession(request)
  await openFixtureFile(page)
  await selectFixtureLines(page)

  const ghost = await startAltDrag(page)
  await expect(ghost).toContainText(FILE)
  await springOpenAgentManager(page)

  const row = page.locator(`[data-sc-selection-drop="session:${sessionId}"]`)
  await expect(row, '会话行在场').toBeVisible({ timeout: 10000 })
  const box = await row.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 6 })
  await expect(row).toHaveClass(/sc-selection-drop-hover/)
  await releaseDrag(page)

  // 落点语义：该会话被选中，定位头 + 选区原文写入其输入行
  await expect(row).toHaveClass(/active/)
  await expect
    .poll(() => scrollbackOf(request, sessionId), { timeout: 15000, message: '选区应出现在会话 scrollback' })
    .toContain(MARK)
  await expect
    .poll(() => scrollbackOf(request, sessionId), { timeout: 15000 })
    .toContain('drag.ts')
  await page.waitForTimeout(800)
  const text = await scrollbackOf(request, sessionId)
  // 只追加不发送：粘贴回显的 marker 总在「定位头 + echo …」长行里；回车执行会
  // 多出一行**纯 marker 输出**。scrollback 含 ConPTY 重绘（启动横幅可重复出现），
  // 按次数断言会被重绘污染，故剥 ANSI 后按「整行等于 marker」判定执行面
  const plainLines = text
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map(l => l.trim())
  expect(text, '选区应已写入输入行').toContain(MARK)
  expect(plainLines, '未按 Enter：不应出现 echo 的执行输出行').not.toContain(MARK)
  await expect(page.locator('.sc-selection-drag-ghost')).toHaveCount(0)
})

test('Alt+拖到「新建会话」：对话框打开且指令预填上下文，不自动创建', async ({ page }) => {
  const posts: unknown[] = []
  page.on('request', (req) => {
    if (req.method() === 'POST' && new URL(req.url()).pathname.endsWith('/api/terminals')) {
      posts.push(req.postDataJSON())
    }
  })
  await openFixtureFile(page)
  await selectFixtureLines(page)

  await startAltDrag(page)
  await springOpenAgentManager(page)

  // 侧栏新建钮（头部新建钮同为落点，此处按侧栏语义锚定 .ats-new）
  const newBtn = page.locator('button.ats-new[data-sc-selection-drop="new-session"]')
  await expect(newBtn).toBeVisible()
  const box = await newBtn.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 5 })
  await expect(newBtn).toHaveClass(/sc-selection-drop-hover/)
  await releaseDrag(page)

  const prompt = page.locator('[data-testid="agent-template-prompt"] textarea')
  await expect(prompt, '新建对话框携带预填指令').toBeVisible({ timeout: 8000 })
  await expect(prompt).toHaveValue(new RegExp(MARK))
  await expect(prompt).toHaveValue(new RegExp('第 2-3 行的选区'))
  // 带上下文新会话 = 预填待确认，不自动发起创建
  expect(posts, '未点击创建前不得发 POST /api/terminals').toHaveLength(0)
  // 预填态有未提交输入：Esc 出「放弃这次输入？」确认，显式放弃关净
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '放弃' }).click()
})

test('Alt+拖落空：取消、不展开管理页、不弹对话框、拖影不残留', async ({ page }) => {
  await openFixtureFile(page)
  await selectFixtureLines(page)

  await startAltDrag(page)
  // 顶栏空白（非 rail/侧栏落点）
  const topbar = page.locator('.ide-header').first()
  await expect(topbar).toBeVisible()
  const box = await topbar.boundingBox()
  await page.mouse.move(box!.x + box!.width - 40, box!.y + box!.height / 2, { steps: 6 })
  await releaseDrag(page)

  await expect(page.locator('.sc-selection-drag-ghost')).toHaveCount(0)
  await expect(page.locator('.atv-root')).toBeHidden()
  await expect(page.locator('[data-testid="agent-template-prompt"]')).toHaveCount(0)
  // 编辑器仍在（落空不改主区视图）
  await expect(page.locator('.monaco-editor').first()).toBeVisible()
})
