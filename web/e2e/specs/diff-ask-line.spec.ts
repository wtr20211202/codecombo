import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 行级追问「追问此改动」（P-20261003-208）E2E：diff 标签（DiffEditor）
 * 右键行 → 菜单项以 文件+行号+所在 hunk 摘要 发起新 agent 会话（P-122 发起
 * 链路复用）。断言经请求拦截读 create 请求体（launchArgs 即 prompt）：
 *   1. 变更面板工作区 diff（diff:HEAD:wt）右键（modified 侧）改动行 →
 *      launchArgs 含 文件+行号定位头 与 hunk 摘要（@@ 头 + -/+ 变更行），
 *      整体 ≤500 字节，会话创建并在 docked 管理页激活
 *   2. 同 diff 左侧（original 侧）右键 → 侧别闭包生效，同一变更块摘要
 *   3. 历史对比 diff（diff:<hash>:HEAD）→ 形态守卫（右侧非工作区版本）：
 *      scDiffAskable=false → 菜单项隐藏（precondition 编为菜单项 when，
 *      P-122 无选区隐藏同款），不发起会话
 * 交互沿 ask-selection.spec 实测口径：Monaco 菜单在 shadow DOM（locator 自动
 * 穿透），headless 下点击与聚焦+Enter 偶发无效，两者交替重试直至 create
 * POST 发出。自备临时仓库（c1 基线 + 工作区未提交修改），afterEach 清理全部
 * 终端会话，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-ask-line')
const PROJ = 'e2e-diff-ask-line'
const FILE = 'review.txt'
const MENU_LABEL = '追问此改动'

const C1_CONTENT = 'reviewed baseline\nsecond line\n'
const WT_CONTENT = 'reviewed baseline\nsecond line EDITED in worktree\n'

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

/** 捕获 POST /api/terminals（创建会话）请求体：断言 launchArgs 即 prompt 内容 */
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

let projectId = ''
let c1 = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  c1 = git(REPO_DIR, ['rev-parse', 'HEAD'])
  // 工作区未提交修改（产出审阅对象；第 2 行改动 → hunk 摘要断言的固定锚）
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
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
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

// rail git 面板提交列表（uiState 恢复态不定，同款 toggle 归一化）
async function openCommitLog(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

/** 打开变更面板工作区 diff（diff:HEAD:wt:<file>）：双击变更树文件行 */
async function openWorkspaceDiff(page: Page) {
  await enterProject(page)
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: FILE })).toBeVisible({ timeout: 10000 })
  await page.locator('.cp-node').filter({ hasText: FILE }).first().dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
}

/** 右键 diff 一侧第 2 行（夹具改动行）并返回「追问此改动」菜单项。菜单在
 *  shadow DOM，Playwright locator 自动穿透 */
async function openContextMenuAtChangedLine(page: Page, side: 'modified' | 'original') {
  await page.locator(`.monaco-diff-editor .editor.${side} .view-line`).nth(1).click({ button: 'right' })
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  return { menu, askItem: menu.first().locator('.action-item').filter({ hasText: MENU_LABEL }) }
}

/** 触发「追问此改动」并等 create 请求发出：headless 下 shadow DOM 菜单聚焦
 *  状态不定，鼠标点击与键盘 Enter 交替重试（ask-selection.spec 同款实测口径） */
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

test('工作区 diff 右键改动行「追问此改动」→ launchArgs 含文件行与 hunk 摘要', async ({ page }) => {
  await openWorkspaceDiff(page)
  const payloads = watchAgentCreate(page)

  const { askItem } = await openContextMenuAtChangedLine(page, 'modified')
  await expect(askItem, '右侧=工作区版本 → 菜单项出现（scDiffAskable 为真）').toBeAttached()
  await driveAskItem(page, askItem, payloads)

  // create 请求体：kind=agent、dir=项目根、launchArgs = 定位头 + hunk 摘要
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt, '文件+行号定位头').toContain('请解释 review.txt 第 2 行的这个改动为什么这样修改：')
  expect(prompt, 'hunk 头（两侧各 1 行）').toContain('@@ -2,1 +2,1 @@')
  expect(prompt, '原行样本').toContain('- second line')
  expect(prompt, '改后行样本').toContain('+ second line EDITED in worktree')
  // 服务端按字节计 500 上限（超限直接 400）：prompt 组装必须已内建裁剪
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现、恰好一个会话且激活
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)
})

test('左侧（original 侧）右键同改行：侧别闭包生效，同一变更块摘要', async ({ page }) => {
  await openWorkspaceDiff(page)
  const payloads = watchAgentCreate(page)

  const { askItem } = await openContextMenuAtChangedLine(page, 'original')
  await expect(askItem).toBeAttached()
  await driveAskItem(page, askItem, payloads)

  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const prompt = payloads[0]!.launchArgs || ''
  // 左侧行号同为 2（该块两侧同位），摘要同一变更块
  expect(prompt).toContain('请解释 review.txt 第 2 行的这个改动为什么这样修改：')
  expect(prompt).toContain('@@ -2,1 +2,1 @@')
  expect(prompt).toContain('- second line')
  expect(prompt).toContain('+ second line EDITED in worktree')
})

test('历史对比 diff：菜单项隐藏（形态守卫，右侧非工作区版本），不发起会话', async ({ page }) => {
  await openWorkspaceDiff(page)
  // 直接叠加打开提交历史对比（diff:<hash>:HEAD:<file>）——openDiffView 把新签
  // 置活，EditorGroupPane 仅挂载活跃签，此后 .monaco-diff-editor 即历史对比
  await openCommitLog(page)
  await page.locator('.commit-item').filter({ hasText: c1.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // P-100 热切下 .monaco-diff-editor 的可见是假信号——目标 diff tab 装载窗口
  // 内继续呈现上一个就绪 diff（工作区版本）。窗口内右键的 contextmenu 目标随
  // setModel 换装重建而丢失，菜单不弹。等右侧真正呈现历史版本内容（工作区第
  // 2 行含 EDITED、c1 历史版本不含）再交互——就绪判定收紧，断言语义不变
  const histLine = page.locator('.monaco-diff-editor .editor.modified .view-line').nth(1)
  await expect(histLine).not.toContainText('EDITED', { timeout: 15000 })

  const payloads = watchAgentCreate(page)
  const { menu, askItem } = await openContextMenuAtChangedLine(page, 'modified')
  // 菜单本体在（对照），「追问此改动」被 scDiffAskable=false 隐藏
  await expect(askItem, '历史对比右侧非工作区版本 → 菜单项隐藏').toHaveCount(0)
  await expect(menu.first()).toBeVisible()
  await page.keyboard.press('Escape')
  await expect.poll(() => payloads.length, { timeout: 3000 }).toBe(0)
})
