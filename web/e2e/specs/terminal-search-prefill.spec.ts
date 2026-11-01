import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端搜索的选中词预填（P-20261004-87）E2E：浏览器/VS Code「有选区 Ctrl+F 以
 * 选区为查询词直接首搜」惯例件。
 *   1. 终端输出含关键词 → 双击选词（xterm 原生词选）→ Ctrl+F → 查询框已填 +
 *      计数徽标即现（预填即首搜，不走 200ms 输入防抖）+ 输入框全选态（继续
 *      敲击即整体替换）
 *   2. 无选区 Ctrl+F → 空框打开（既有行为零回归）
 *   3. 跨行拖选 → 查询取首行截断（行内搜索语义），第二行内容不进查询词
 * 选区读取时机：Ctrl+F 在 xterm attachCustomKeyEventHandler 被拦截（返回 false
 * 不交 xterm 处理），打开动作不清选区——预填读到的就是按键瞬间的选区。
 * 自备临时空项目（终端对项目路径无 git 要求），afterEach 清理全部终端会话，
 * afterAll 清理项目与夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-search-prefill'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-search-prefill')

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

/** 清理全部终端会话：残留会话污染下一用例的新建 tab 定位 */
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

/** marker 文本的屏上矩形（DOM renderer 行内 Range 定位，terminal-ask-selection
 *  同款技术）。行带重试查询：echo 输出行渲染需百余毫秒，轮询至出现 */
async function waitForMarkerRect(page: Page, marker: string, timeout = 10000): Promise<{ left: number; right: number; centerY: number }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const rect = await markerRect(page, marker)
    if (rect) return rect
    if (Date.now() > deadline) throw new Error(`viewport 中找不到输出标记行: ${marker}`)
    await page.waitForTimeout(200)
  }
}
/** marker 文本的屏上矩形单次查询（DOM 内首个命中——同串多次出现时取 DOM 序靠前行） */
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

/** xterm 选区层当前渲染的选区带条数（跨行选区为多条带、词选为 1 条带） */
function selectionStripCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector('.xterm-selection')?.children.length ?? 0)
}

/** 等待 xterm 选区层形成 ≥n 条带（headless 下鼠标编舞偶发被合并成点击、选区不
 *  形成——后续预填断言以选区存在为前提，此前置守卫让值断言可靠） */
async function waitForSelectionStrips(page: Page, min: number, timeout = 2000): Promise<boolean> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await selectionStripCount(page) >= min) return true
    if (Date.now() > deadline) return false
    await page.waitForTimeout(100)
  }
}

test('双击选词 Ctrl+F：查询已填 + 计数徽标即现 + 输入框全选态（敲击即替换）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  // 双击词选触发 copy-on-select 写剪贴板：授权避免未处理拒绝干扰
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 输出含关键词的行（标记重复出现，保证命中计数 > 0）。纯字母数字标记：
  // xterm 默认 wordSeparator 不含字母数字，双击整词选中
  const marker = `SCSELWD${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker} ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })

  // 双击选词（xterm 原生词选）：headless 下双击偶发未成选区，出现选区带才继续
  const rect = await waitForMarkerRect(page, marker)
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.mouse.dblclick(rect!.left + 3, rect!.centerY)
    if (await waitForSelectionStrips(page, 1, 1000)) break
  }

  // Ctrl+F：查询框预填选中词 + 立即首搜（计数徽标即现，非 not found）
  await page.keyboard.press('Control+f')
  const searchBar = page.locator('.term-search-bar:visible')
  await expect(searchBar).toBeVisible()
  const searchInput = searchBar.locator('input')
  await expect(searchInput, '查询框预填双击选中的词').toHaveValue(marker)
  const counter = searchBar.locator('.term-search-counter')
  await expect(counter, '计数徽标即现（预填即首搜，非 not found）').toHaveText(/^\d+$/)

  // 预填后输入框内容全选态：焦点在框内且选区覆盖全值——继续敲击即整体替换
  await expect.poll(async () => searchInput.evaluate((el: HTMLInputElement) => ({
    focused: document.activeElement === el,
    start: el.selectionStart,
    end: el.selectionEnd,
  })), { timeout: 5000 }).toEqual({ focused: true, start: 0, end: marker.length })
  await page.keyboard.type('Z')
  await expect(searchInput, '敲击即替换预填词（浏览器同款细节），非词尾追加').toHaveValue('Z')

  // Esc 收口（既有行为不回归）
  await page.keyboard.press('Escape')
  await expect(searchBar).toBeHidden()
})

test('无选区 Ctrl+F：空框打开（既有行为零回归）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 纯点击聚焦（无选区）后 Ctrl+F：空框打开，无计数徽标
  await xterm.click()
  await page.keyboard.press('Control+f')
  const searchBar = page.locator('.term-search-bar:visible')
  await expect(searchBar).toBeVisible()
  await expect(searchBar.locator('input')).toHaveValue('')
  await expect(searchBar.locator('.term-search-counter')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(searchBar).toBeHidden()
})

test('跨行拖选 Ctrl+F：查询取首行截断（行内搜索语义）', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 两行输出：跨行拖选后预填只应含首行片段，第二行内容不进查询词
  const m1 = `SCSEL1A${Date.now()}`
  const m2 = `SCSEL2B${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${m1} tail-one\r`)
  await expect(xterm).toContainText(m1, { timeout: 10000 })
  await page.keyboard.type(`echo ${m2} tail-two\r`)
  await expect(xterm).toContainText(m2, { timeout: 10000 })

  // 从首行 marker 起点拖到第二行 marker 起点：选区跨 ≥2 行。
  // 拖选是三拍鼠标编舞（down → 跨行 move → up），headless 高载下 CDP 事件可能
  // 被合并成「点击」（xterm 侧选区不形成，getSelection 读到空/陈旧值——探针
  // 实测选中层与预填值可回退上一轮内容）。拖后显式校验选区层真实形成（跨行
  // 选区渲染为 ≥2 条带），Ctrl+F 后查询值 ≠ 预期首行逻辑行则整拍重拖——前置
  // 守卫「新鲜选区存在」后，值断言才是本提案语义（首行截断）的可靠检验
  const expected = `${m1} tail-one`
  let observed = ''
  for (let attempt = 1; attempt <= 3 && observed !== expected; attempt++) {
    await xterm.click() // 每拍起点归位：焦点回终端
    const r1 = await waitForMarkerRect(page, m1)
    const r2 = await waitForMarkerRect(page, m2)
    await page.mouse.move(r1!.left + 3, r1!.centerY)
    await page.mouse.down()
    await page.waitForTimeout(120)
    await page.mouse.move(r2!.left + 3, r2!.centerY, { steps: 15 })
    await page.waitForTimeout(80)
    await page.mouse.up()
    // 选区形成才按 Ctrl+F
    if (!(await waitForSelectionStrips(page, 2))) continue
    await page.keyboard.press('Control+f')
    const searchBar = page.locator('.term-search-bar:visible')
    await expect(searchBar).toBeVisible()
    const searchInput = searchBar.locator('input')
    try {
      // 预填发生在 openSearch 的 nextTick，poll 等待到位再取值做逐条断言
      await expect.poll(async () => {
        observed = await searchInput.evaluate((el: HTMLInputElement) => el.value)
        return observed
      }, { timeout: 3000 }).toBe(expected)
    } catch {
      // 值非预期（拖选未更新选区/读到陈旧选区）：收口后重拖
      observed = ''
      await page.keyboard.press('Escape')
      await expect(searchBar).toBeHidden()
    }
  }
  expect(observed, '预填=首行逻辑行（行内搜索语义，xterm 对 wrapped 行按逻辑行回传）').toBe(expected)
  const searchBar = page.locator('.term-search-bar:visible')
  await expect(searchBar).toBeVisible()
  expect(observed, '跨行部分不进查询词').not.toContain(m2)
  expect(observed, '多行选区不整段带入').not.toContain('\n')

  // Esc 收口（预填态下既有行为不回归）
  await page.keyboard.press('Escape')
  await expect(searchBar).toBeHidden()
})
