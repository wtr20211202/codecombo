import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨会话输出检索的会话内定位（P-20261005-9）E2E：
 *   1. 滚动落点：会话 A echo 独有标记后灌 50 行填充把标记顶出视口（xterm DOM
 *      只渲染视口行，标记在滚回缓冲但不在屏）→ 搜索点选 → 活跃 tab 切到 A 且
 *      视口含标记（scrollToLine 滚动定位真实发生）+ 选区高亮层可见
 *   2. 滚出缓冲降级：会话 echo 标记后灌 1500 行短填充——xterm scrollback 已由
 *      settings 钳到 1000 行（服务端 GetScrollbackLines 下限 1000，容量在会话
 *      创建时定格，beforeAll 写入后读回断言），标记被裁出前端缓冲（导出整缓冲
 *      数行直接验证）；服务端环形缓冲按字节计容（1000×80B=80KB），短行填充远未
 *      触顶仍命中 → 搜索点选 → toast「命中行已不在滚回缓冲」诚实提示
 * 前置（spec 内自备）：临时项目 + 真实终端会话；输出驱动走 broadcast-write
 * （服务端直写 PTY，免逐字键入的焦点/churn 干扰，terminal-disconnect-gap 同款；
 * ids 显式定址单会话，不串另会话）。标记词全仓唯一防跨 spec 串扰
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_NAME = 'e2e-tos-locate'
const MARK_A = 'E2ELOC-ALPHA-MARK'
const MARK_B = 'E2ELOC-BETA-MARK'
const MARK_C = 'E2ELOC-GAMMA-MARK'
const FILLER_PREFIX = 'E2ELOC-FILL-'
// 缓冲钳制值：服务端 GetScrollbackLines 合法域 [1000, 200000]，低于下限回落
// 默认 20000（实测踩坑：写 500 会被静默归一化，钳制形同虚设）。1000 行 =
// 80KB 服务端环形缓冲，1500 行 ~4B 短填充 ≈ 6KB 远未触顶——标记被 xterm 行数
// 上限裁出的同时服务端仍命中，降级场景成立
const SCROLLBACK_CAP = 1000
// 降级用灌行数：> 1000 + 视口行数（~24），标记（缓冲头部）必被裁出前端缓冲
const DEGRADE_FILLER_LINES = 1500

let unlockToken = ''
let originalLines: number | null = null
let isWin = true

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

/** 服务端直写指定会话 PTY（broadcast-write 显式 ids 定址；命令须自带 \r） */
async function writeInput(ids: string[], data: string) {
  const res = await api('POST', '/api/terminals/broadcast-write', { ids, data })
  expect(res.status).toBe(200)
}

/** 目标 shell 语义的 for 循环填充行命令（settings.platform 分支，两分支均可用） */
function fillerCommand(lines: number): string {
  if (isWin) return `for($i=1;$i -le ${lines};$i++){ "${FILLER_PREFIX}$i" }\r`
  return `for i in $(seq 1 ${lines}); do echo "${FILLER_PREFIX}$i"; done\r`
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  // 缓冲钳制必须先于建会话（容量在会话创建时定格，terminal-disconnect-gap 同款；
  // 读原值留 afterAll 恢复）。写入后读回断言——低于合法域的值会被服务端静默
  // 归一化，不显式对账钳制就形同虚设。platform 同时决定填充命令的 shell 分支
  const settings = await (await fetch(API_BASE + '/api/settings', {
    headers: { 'X-Lock-Token': unlockToken },
  })).json() as { data?: { terminalScrollbackLines?: number; platform?: string } }
  originalLines = settings.data?.terminalScrollbackLines ?? null
  isWin = (settings.data?.platform ?? 'win').startsWith('win')
  await api('PUT', '/api/settings', { terminalScrollbackLines: SCROLLBACK_CAP })
  const back = await (await fetch(API_BASE + '/api/settings', {
    headers: { 'X-Lock-Token': unlockToken },
  })).json() as { data?: { terminalScrollbackLines?: number } }
  expect(back.data?.terminalScrollbackLines).toBe(SCROLLBACK_CAP)

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-tos-locate')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  if (originalLines !== null) {
    await api('PUT', '/api/settings', { terminalScrollbackLines: originalLines })
  }
  // 删除项目级联关闭其终端会话（检索面只扫活会话，残留会扫到已删项目孤儿输出）
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-tos-locate'), { recursive: true, force: true }) } catch { /* shell 占用忽略 */ }
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 等 xterm 屏幕文本稳定（连续 500ms 不变且已出现提示符）：新建 pane 的 fit
 *  重绘 churn 期间 ConPTY 反复 resize 重绘横幅（terminal-output-search 同款） */
async function waitXtermSettled(xterm: ReturnType<Page['locator']>) {
  let prev = ''
  for (let i = 0; i < 24; i++) {
    const cur = await xterm.textContent().catch(() => '')
    if (cur && cur === prev && /[>$#] /.test(cur)) return
    prev = cur
    await sleep(500)
  }
}

/** 取项目当前全部会话 id（新建 tab 后 diff 求新会话 id 用） */
async function projectSessionIds(): Promise<string[]> {
  const list = await api('GET', '/api/terminals')
  const sessions = (list.json?.data || []) as { id: string; projectId?: string }[]
  const plist = await api('GET', '/api/projects')
  const proj = ((plist.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (!proj) return []
  return sessions.filter(s => s.projectId === proj.id).map(s => s.id)
}

/** 新建一个终端 tab，diff 求新会话 id 返回（输出驱动由调用方 writeInput 分步控制） */
async function newTerminalSession(page: Page): Promise<string> {
  const before = new Set(await projectSessionIds())
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  await expect(newBtn).toBeVisible({ timeout: 5000 })
  await newBtn.click()
  // diff 求新会话 id：轮询至出现（对账广播偶有延迟）
  let sid = ''
  for (let i = 0; i < 20 && !sid; i++) {
    await sleep(400)
    for (const id of await projectSessionIds()) {
      if (!before.has(id)) { sid = id; break }
    }
  }
  expect(sid).not.toBe('')
  return sid
}

/** 进项目页 + 底部终端面板基线归一化（terminal-output-search 同款循环——
 *  boot 布局恢复晚落地会覆盖此前的 rail/tab 操作，循环按实时状态收敛） */
async function openProjectTerminalPanel(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')

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

  // 清 uiState 恢复的历史 tab（output-sentinel 同款循环）
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
}

/** 命令面板命令模式 → 打开「搜索终端输出」浮层（terminal-output-search 同款：
 *  走顶栏搜索触发器，Ctrl+K 会被聚焦中的 xterm 吃成 ^K 输入） */
async function openOutputSearch(page: Page) {
  await page.locator('.header-search-trigger').click()
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>搜索终端输出')
  await expect(page.locator('.palette-item').first()).toContainText('搜索终端输出', { timeout: 5000 })
  await page.keyboard.press('Enter')
  const overlay = page.locator('[data-testid="terminal-output-search"]')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-mask')).toHaveCount(0)
  return overlay
}

/** 导出客户端 xterm 整缓冲为文本（导出为文本读 term.buffer——缓冲级证据，
 *  视口 DOM 只有视口行，证明「已裁出滚回缓冲」必须看整缓冲） */
async function exportScrollbackText(page: Page): Promise<string> {
  await page.locator('.term-tabbar button[title="更多操作"]').click()
  const exportOpt = page.locator('.n-dropdown-option').filter({ hasText: '导出为文本' }).first()
  await expect(exportOpt).toBeVisible({ timeout: 3000 })
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 8000 }),
    exportOpt.click(),
  ])
  const file = path.join(HERE, '../../test-results/locate-buffer.txt')
  await download.saveAs(file)
  return fs.readFileSync(file, 'utf8')
}

test('点选命中 → 落会话且视口滚到命中行 + 选区高亮（标记先被填充顶出视口）', async ({ page }) => {
  test.setTimeout(240000)
  await openProjectTerminalPanel(page)

  // 会话 A：echo 标记（先确认进屏）→ 灌 50 行填充把标记顶出视口。标记仍在 A 的
  // 滚回缓冲（50 ≪ 1000 上限）与服务端环形缓冲 → 两端均可检索
  const sidA = await newTerminalSession(page)
  const xtermA = page.locator('.xterm:visible').last()
  await expect(xtermA).toContainText(/[$#] |PS /, { timeout: 20000 })
  await writeInput([sidA], `echo ${MARK_A}\r`)
  await expect(xtermA).toContainText(MARK_A, { timeout: 15000 })
  await writeInput([sidA], fillerCommand(50))
  await waitXtermSettled(xtermA)
  // 基线（A 在屏）：填充已把标记顶出视口——可见视口 DOM 不含标记。后续点选后
  // 「视口含标记」才构成「滚动定位真实发生」（期间无任何用户滚动动作）
  await expect(xtermA).not.toContainText(MARK_A)

  // 会话 B：echo 独有标记（新建即激活，落点断言的目标态 = B 在屏、A 在后台）
  const sidB = await newTerminalSession(page)
  const xtermB = page.locator('.xterm:visible').last()
  await expect(xtermB).toContainText(/[$#] |PS /, { timeout: 20000 })
  await writeInput([sidB], `echo ${MARK_B}\r`)
  await expect(xtermB).toContainText(MARK_B, { timeout: 15000 })
  await waitXtermSettled(xtermB)
  const tabs = page.locator('.term-tablist .term-tab')
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')

  const overlay = await openOutputSearch(page)
  const searchInput = overlay.locator('input').first()
  await searchInput.fill(MARK_A)
  const rowA = overlay.locator('.tosearch-item').filter({ hasText: MARK_A }).first()
  await expect(rowA).toBeVisible({ timeout: 10000 })
  await rowA.click()

  // 浮层关闭 + 活跃 tab 切到 A + 视口滚到标记 + 选区高亮层可见
  await expect(overlay).toHaveCount(0)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true', { timeout: 10000 })
  const visibleXterm = page.locator('.xterm:visible').last()
  await expect(visibleXterm).toContainText(MARK_A, { timeout: 10000 })
  await expect(visibleXterm.locator('.xterm-selection div').first()).toBeVisible({ timeout: 5000 })
})

test('点选已被前端缓冲裁剪的命中 → toast「命中行已不在滚回缓冲」诚实降级', async ({ page }) => {
  test.setTimeout(240000)
  await openProjectTerminalPanel(page)

  // 会话：echo 标记 → 灌 1500 行短填充。xterm scrollback=1000（beforeAll 钳制），
  // 标记（缓冲头部）被裁出前端缓冲；服务端环形缓冲按字节计容（80KB）远未触顶
  // 仍命中——两端裁剪口径的不对称正是降级场景的成因
  const sid = await newTerminalSession(page)
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  await writeInput([sid], `echo ${MARK_C}\r`)
  await expect(xterm).toContainText(MARK_C, { timeout: 15000 })
  await writeInput([sid], fillerCommand(DEGRADE_FILLER_LINES))
  await waitXtermSettled(xterm)
  // 视口基线：标记不在可见视口
  await expect(xterm).not.toContainText(MARK_C)
  // 缓冲级基线（直接证据）：整缓冲导出不含标记，且行数在钳制量级
  // （~1000+视口行；未钳制时 20000 行上限会全量保留 ~1500 行含标记）
  const text = await exportScrollbackText(page)
  expect(text).not.toContain(MARK_C)
  expect(text.split(/\r?\n/).length).toBeLessThan(DEGRADE_FILLER_LINES)

  const overlay = await openOutputSearch(page)
  const searchInput = overlay.locator('input').first()
  await searchInput.fill(MARK_C)
  const rowC = overlay.locator('.tosearch-item').filter({ hasText: MARK_C }).first()
  // 服务端仍命中（环形缓冲未触顶）——命中行与前端缓冲的「已裁剪」并存
  await expect(rowC).toBeVisible({ timeout: 10000 })
  await rowC.click()

  // 定位缺席降级 toast（zh-CN 固定 locale 按「滚回缓冲」子串断言）
  await expect(overlay).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '滚回缓冲' }).first())
    .toBeVisible({ timeout: 10000 })
})
