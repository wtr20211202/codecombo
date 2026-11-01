import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 终端搜索查询历史（P-20261004-109）E2E：useSearchHistory 终端域二次兑现。
 *   搜两词（Enter 承诺）→ 清空重聚焦出全量下拉（最近在上）→ 输入前缀过滤 →
 *   点选回填即搜（计数徽标即现）→ Esc 分层（先收下拉再关搜索条）→
 *   尾部清空归零（再开无下拉）。
 * 历史存 localStorage `terminal-search-history`（环形 5 条），Playwright 每用例
 * 独立 context 天然隔离；自备临时项目 + 真实终端会话（echo 标记词保证计数 ≥1），
 * afterAll 清理。helpers 沿 terminal-search-prefill 同款（本目录按 spec 自备惯例）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-search-history'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-search-history')
const HISTORY_KEY = 'terminal-search-history'

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
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': '' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 注册路径按服务端形态交接（dualpath 纪律：linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 面板开合/分区都是 uiState 持久态，跑序而异：循环归一化到「面板开 + 终端 tab +
  // 新建钮可见」基线（terminal-output-search 同款；不盲点 rail——toggle 语义已开再点即关）
  const panel = page.locator('.bottom-panel')
  const railTerminal = page.locator('.rail-btn[title="终端"]')
  const terminalTab = page.locator('.bottom-tabs button').filter({ hasText: '终端' })
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  for (let i = 0; i < 10; i++) {
    if (await newBtn.isVisible().catch(() => false)) break
    if (!(await panel.isVisible().catch(() => false))) {
      await railTerminal.click()
    } else {
      await terminalTab.click({ timeout: 3000 }).catch(() => { /* 面板瞬闭：下轮走 rail 分支 */ })
    }
    await page.waitForTimeout(500)
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await expect(newBtn).toBeVisible({ timeout: 5000 })
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows PowerShell（PS ...）/ Linux bash（$ 或 #）
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  return xterm
}

/** 点入 xterm 并确保焦点落在该 pane 的隐藏输入 textarea 后再键入（重绘夺焦重试） */
async function typeViaXterm(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  const textarea = xterm.locator('.xterm-helper-textarea')
  for (let i = 0; i < 5; i++) {
    await xterm.click()
    try {
      await expect(textarea).toBeFocused({ timeout: 500 })
      break
    } catch { /* 焦点未落到目标 pane（重绘夺焦），重点 */ }
    await page.waitForTimeout(300)
  }
  await expect(textarea).toBeFocused()
  await page.keyboard.type(text)
}

/** 搜索框就位 helper：清残留 + 按键逐字输入承诺词 + Enter 记账。
 *  逐字敲入沿用户真实输入路径（watch(searchQuery) 每键复位补全可用态） */
async function commitTerm(page: Page, term: string) {
  const searchBar = page.locator('.term-search-bar:visible')
  const searchInput = searchBar.locator('input')
  await searchInput.fill('')
  await searchInput.pressSequentially(term)
  await expect(searchBar.locator('.term-search-counter')).toHaveText(/^[1-9]\d*$/, { timeout: 8000 })
  await searchInput.press('Enter')
}

test('查询历史：搜两词→重聚焦出全量→前缀过滤→回填即搜→Esc 分层→清空归零', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 屏上备两个可搜标记词（互不为对方前缀）：保证回填后计数徽标 ≥1 的断言有据
  const wordA = `SCSHISTA${Date.now()}`
  const wordB = `SCSHISTB${Date.now()}`
  await typeViaXterm(page, xterm, `echo ${wordA}\r`)
  await expect(xterm).toContainText(wordA, { timeout: 10000 })
  await typeViaXterm(page, xterm, `echo ${wordB}\r`)
  await expect(xterm).toContainText(wordB, { timeout: 10000 })

  // 搜第一词：Ctrl+F 空框打开（无历史不下拉）→ 输入即实时搜 → Enter 承诺入历史
  await xterm.click()
  await page.keyboard.press('Control+f')
  let searchBar = page.locator('.term-search-bar:visible')
  await expect(searchBar).toBeVisible()
  await expect(page.getByTestId('term-search-history')).toHaveCount(0)
  await commitTerm(page, wordA)
  // 承诺后输入仍聚焦且查询词前缀命中历史 → 下拉开着（P-48 同款状态）
  await expect(page.getByTestId('term-search-history-item-0')).toHaveText(wordA)

  // Esc 分层第一层：只收下拉，搜索条保留
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('term-search-history')).toBeHidden()
  await expect(searchBar).toBeVisible()

  // 搜第二词（搜索条粘滞复用，fill 清残留）：最近在上
  await commitTerm(page, wordB)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('term-search-history')).toBeHidden()

  // 落盘核对：独立通道键 terminal-search-history，最近在前
  const stored = await page.evaluate((k) => window.localStorage.getItem(k), HISTORY_KEY)
  expect(stored).toContain(wordA)
  expect(stored).toContain(wordB)
  expect(stored!.indexOf(`"${wordB}"`)).toBeLessThan(stored!.indexOf(`"${wordA}"`))

  // 重聚焦出全量下拉（最近在上）：清空输入即全量（前缀过滤空前缀）
  const searchInput = searchBar.locator('input')
  await searchInput.fill('')
  const dropdown = page.getByTestId('term-search-history')
  await expect(dropdown).toBeVisible()
  await expect(page.getByTestId('term-search-history-item-0')).toHaveText(wordB)
  await expect(page.getByTestId('term-search-history-item-1')).toHaveText(wordA)

  // 前缀过滤（补全式）：敲 A 词前缀只剩 A；无匹配前缀给空态提示
  await searchInput.fill('')
  await searchInput.pressSequentially(wordA)
  await expect(page.getByTestId('term-search-history-item-0')).toHaveText(wordA)
  await expect(page.locator('.term-search-history-item')).toHaveCount(1)
  await searchInput.fill('')
  await searchInput.pressSequentially('SCSHISTZ')
  await expect(page.getByTestId('term-search-history-empty')).toBeVisible()
  await expect(page.locator('.term-search-history-item')).toHaveCount(0)

  // 回填即搜：点选 A 词 → 查询框回填 + 计数徽标即现（不走输入防抖）+ 下拉收起
  await searchInput.fill('')
  await searchInput.pressSequentially(wordA.slice(0, 8))
  await page.getByTestId('term-search-history-item-0').click()
  await expect(searchInput).toHaveValue(wordA)
  await expect(dropdown).toBeHidden()
  await expect(searchBar.locator('.term-search-counter')).toHaveText(/^[1-9]\d*$/, { timeout: 5000 })

  // Esc 第二层：下拉已收，Esc 关搜索条。点选后 headless 指针焦点链可能把焦点
  // 漂到 body（实测 ~70ms 延迟的原生漂移）——条开着的窗级捕获 Esc 兜底接管，
  // 只关搜索条不触发布局级退链，底部面板保留（两种焦点落点断言等价）
  await page.keyboard.press('Escape')
  await expect(searchBar).toBeHidden()
  await expect(page.locator('.bottom-panel')).toBeVisible()

  // 尾部清空入口归零：再开下拉可见（历史 2 条）→ 点清空 → 下拉收起 + 通道键移除。
  // 搜索条关闭后焦点落 body，终端 Ctrl+F 拦截器（xterm 级）需先点回终端再按
  await xterm.click()
  await page.keyboard.press('Control+f')
  searchBar = page.locator('.term-search-bar:visible')
  await expect(searchBar).toBeVisible()
  await expect(dropdown).toBeVisible({ timeout: 3000 })
  await page.getByTestId('term-search-history-clear').click()
  await expect(dropdown).toBeHidden()
  expect(await page.evaluate((k) => window.localStorage.getItem(k), HISTORY_KEY)).toBeNull()

  // 清空查询框再关条：closeSearch 只落账框内词——带着残留查询词关条会把刚清掉的
  // 词重新记回（记录语义正确工作），先清框保证「清空历史」归零到底
  await searchInput.fill('')

  // 清空后再开无历史下拉（无历史不弹空壳）；Esc 关搜索条照旧（既有行为零回归）
  await page.keyboard.press('Escape')
  await expect(searchBar).toBeHidden()
  await xterm.click()
  await page.keyboard.press('Control+f')
  await expect(page.locator('.term-search-bar:visible')).toBeVisible()
  await expect(page.getByTestId('term-search-history')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.locator('.term-search-bar:visible')).toBeHidden()
})
