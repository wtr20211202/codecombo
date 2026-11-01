import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端选中文本「询问智能体此输出」（P-20261003-7）E2E：
 *   1. echo 输出唯一标记行 → 鼠标拖选该行 → 右键菜单「询问智能体此输出」可用
 *      → 点击后 create 请求体断言：kind=agent、dir=项目根、launchArgs（prompt）
 *      含终端输出询问头 + 选中的标记行且 ≤500 字节（服务端上限）；agent 会话
 *      在 docked 管理页激活，服务端会话表 dir=项目根
 *   2. 无选区右键 → 菜单项在位但置灰（disabled），点击不发起 create
 *   3. docked agent 管理页（免项目绑定宿主，askable=false）右键 → 菜单项不展示
 * 选区口径：xterm 真实鼠标拖选（DOM renderer 行内 Range 定位，terminal-file-links
 * 同款技术）；prompt 内容断言经请求拦截读 create 请求体（launchArgs 即 prompt，
 * 服务端原样追加在运行时命令后）。自备临时空项目（终端对项目路径无 git 要求），
 * afterEach 清理全部终端会话（会按设置拉起底层运行时，只断言创建链路不与 TUI
 * 交互），afterAll 清理项目与夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-ask-selection'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-ask-selection')
const ASK_HEADER = '请分析以下终端输出，定位问题并给出修复建议：'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

/** 清理全部终端会话：agent 会话创建走同一会话表，残留会污染计数与载荷断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const unlockRes = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const res = await request.get(`${BASE}/api/terminals`, { headers: { 'X-Lock-Token': token } })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers: { 'X-Lock-Token': token } })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 注册路径按服务端形态交接（linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

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

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 用 rail 按钮精确定位：底部面板展开时 DOM 里还有面板切换钮/新建终端钮，
  // getByRole('终端') 会命中多个元素（strict violation）。
  // 面板可能已由 uiState 恢复为展开态：此时再点 rail 会把它收起，需幂等处理
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  // 项目切换的异步布局应用可能在上面的步骤之间把面板收起（新项目无持久化
  // 布局，apply 默认收起）：点新建前重验一次，收起则重开（幂等）
  await ensureOpen()
  // 先前用例可能把底部面板留在 Git/控制台分区且经 uiState 持久化（服务端
  // 状态跨 spec 存活）：面板开着 ≠ 终端分区，归一化到终端分区再点新建
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('[data-testid="bottom-tab-terminal"]').click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

/** xterm 视口中 marker 文本的屏上矩形（DOM renderer 行内 Range 定位，
 *  terminal-file-links needleBand 同款技术）。行带重试查询：echo 输出行渲染
 *  需百余毫秒，轮询至出现（含超时报错，terminal-file-links waitForBand 同款） */
async function waitForMarkerRect(page: Page, marker: string, timeout = 10000): Promise<{ left: number; right: number; centerY: number }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const rect = await markerRect(page, marker)
    if (rect) return rect
    if (Date.now() > deadline) throw new Error(`viewport 中找不到输出标记行: ${marker}`)
    await page.waitForTimeout(200)
  }
}
/** marker 文本的屏上矩形单次查询（DOM renderer 行内 Range），供 waitForMarkerRect 轮询 */
function markerRect(page: Page, marker: string): Promise<{ left: number; right: number; centerY: number } | null> {
  return page.evaluate((n) => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div')) as HTMLElement[]
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = node.textContent || ''
        const i = t.indexOf(n)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + n.length)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          return { left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 }
        }
      }
    }
    return null
  }, marker)
}

test('拖选输出行右键「询问智能体此输出」→ agent 会话创建且 prompt 含选中输出', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  // 拖选触发 copy-on-select（默认开启）写剪贴板：授权避免未处理拒绝干扰
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  const payloads = watchAgentCreate(page)

  // 跑一条 echo：输出唯一标记（同 run 内唯一，断言不受历史轮次污染）
  const marker = `SC-E2E-ASK-SEL-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })

  // 真实鼠标拖选标记行（行内 Range 定位起止点；选区含尾随定宽补空格也无妨，
  // 组装端已剥尾随空白）
  const rect = await waitForMarkerRect(page, marker)
  // 起止点都收进标记首/尾字符单元格内（left-1 会落到终端左边界外——长项目
  // cwd 下命令行换行、标记行是行首输出，起点越界则 mousedown 不落在 xterm 上，
  // 选区永不形成；+3 仍在首字符单元格内，cell 级选区含整个标记）
  await page.mouse.move(rect!.left + 3, rect!.centerY)
  await page.mouse.down()
  await page.mouse.move(rect!.right + 3, rect!.centerY, { steps: 5 })
  await page.mouse.up()

  // 右键开 pane 菜单：菜单项由可用（启用）反证选区真实落上——本功能的可用性
  // 门禁正是 selectionLength（getSelection()），比探 xterm v6 内部选区 DOM 稳
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const askItem = ctxMenu.locator('[data-testid="term-ask-agent"]')
  await expect(askItem).toBeVisible()
  await expect(askItem).toContainText('询问智能体此输出')
  await expect(askItem, '有选区 → 菜单项可用').toBeEnabled()
  await askItem.click()
  await expect(ctxMenu).toHaveCount(0)

  // create 请求体：kind=agent、dir=项目根、launchArgs = 询问头 + 选中的标记行
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt, 'prompt 以终端输出询问头开头').toContain(ASK_HEADER)
  expect(prompt, '选中的输出行注入 prompt').toContain(marker)
  // 服务端按字节计 500 上限（超限直接 400）：prompt 组装必须已内建裁剪
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现、创建的会话处于激活态。.ats-item 计数不设等值断言：
  // dir=项目根的会话会同时挂在侧栏系统列表与项目归属分组下（AgentSidebarProjectTree
  // 各渲染一条），条目数随归属分组演化；激活态与服务端会话表才是权威断言
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })
  const list = await api('GET', '/api/terminals')
  const agents = ((list.json?.data || []) as { kind?: string; path?: string }[]).filter(s => s.kind === 'agent')
  expect(agents, '服务端恰好一个 agent 会话').toHaveLength(1)
  expect(agents[0]!.path, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
})

test('无选区右键：菜单项置灰，点击不发起 create', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  const payloads = watchAgentCreate(page)

  // 纯点击聚焦（无选区）后开右键菜单
  await xterm.click()
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const askItem = ctxMenu.locator('[data-testid="term-ask-agent"]')
  await expect(askItem, '菜单项在位（对照：非隐藏而是置灰）').toBeVisible()
  await expect(askItem, '无选区 → 菜单项置灰').toBeDisabled()
  // 置灰项不可点（Playwright 对 disabled 元素点击会等待启用超时，正好是断言），
  // 点空白处收口菜单后断言无 create 请求
  await page.mouse.click(5, 5)
  await expect(ctxMenu).toHaveCount(0)
  await page.waitForTimeout(800)
  expect(payloads, '无选区路径不发起 create').toHaveLength(0)
})

test('docked agent 管理页右键：免项目绑定宿主不展示菜单项（askable=false）', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 先经终端链创建一个 agent 会话并落到 docked 管理页（用例 1 同款路径）
  const marker = `SC-E2E-ASK-HOST-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })
  const rect = await waitForMarkerRect(page, marker)
  await page.mouse.move(rect!.left + 3, rect!.centerY)
  await page.mouse.down()
  await page.mouse.move(rect!.right + 3, rect!.centerY, { steps: 5 })
  await page.mouse.up()
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  await ctxMenu.locator('[data-testid="term-ask-agent"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })

  // docked 管理页内右键 agent pane：菜单在（复制等项在位）但询问项不渲染
  const agentXterm = view.locator('.xterm:visible').last()
  await expect(agentXterm).toBeVisible({ timeout: 10000 })
  await agentXterm.click({ button: 'right' })
  const agentMenu = page.locator('.term-context-menu')
  await expect(agentMenu).toBeVisible()
  await expect(agentMenu.locator('.term-context-item').filter({ hasText: '复制' }).first(), '菜单本体在（对照）').toBeAttached()
  await expect(agentMenu.locator('[data-testid="term-ask-agent"]'), '免项目绑定宿主 → askable=false 整项隐藏').toHaveCount(0)
  await page.keyboard.press('Escape')
})
