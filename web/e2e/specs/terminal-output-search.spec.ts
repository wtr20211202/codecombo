import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨会话终端输出检索（P-20261003-290）E2E：
 *   1. 两个终端会话各打印独有关键词 → 命令面板「搜索终端输出」→ 浮层查询
 *      各自命中（会话名徽标 + 命中行）；q<2 字符显示下限提示（服务端 q≥2 的
 *      前端同门槛）
 *   2. 点击命中 → 走 activate-terminal 既有链路跳到对应会话（活跃 tab 切换 +
 *      活跃屏含目标关键词）；会话内定位链路另见 terminal-output-locate.spec.ts
 *      （P-20261005-9：滚动落点 + 选区高亮 + 滚出缓冲降级）
 *   3. 命中时间锚 + 时间档过滤 + 档外折叠计数（P-20261005-202）：挂载会话的
 *      命中标注所属命令记账时刻（HH:MM），时间档（今天/自定义）按该时刻缩范围，
 *      档外命中折叠计数不消失（点折叠行回「全部」）；API 直建的前端未挂载会话
 *      命中无命令区间账（未消费任何 C/D），时间锚如实显示「—」并随档折叠
 * 前置（spec 内自备）：临时项目 + 两个真实终端会话（echo 关键词走真 PTY 输出流，
 * native 环形缓冲/tmux capture-pane 均能捕获——与被检索的 scrollback 同源）。
 * 标记词全仓唯一防跨 spec 串扰
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ_NAME = 'e2e-tos'
// 双会话独有关键词：检索各命中各的会话；前缀公共段可一次搜出双命中
const MARK_A = 'E2EOS-ALPHA-MARK'
const MARK_B = 'E2EOS-BETA-MARK'
const MARK_PREFIX = 'E2EOS-'
// 未挂载会话（用例 3）独有关键词：与 MARK_A/B 共享子串 'MARK'，一次检索同出
// 有锚（挂载会话）与无锚（未挂载会话）两类命中
const MARK_GHOST = 'E2ETC-GHOST-MARK'

let unlockToken = ''
let projId = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-tos')
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(dir) })
  expect([200, 201]).toContain(proj.status)
  projId = String((proj.json?.data as { id?: string })?.id || '')
})

test.afterAll(async () => {
  // 删除项目级联关闭其终端会话（检索面只扫活会话，残留会扫到已删项目孤儿输出）
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-tos'), { recursive: true, force: true }) } catch { /* shell 占用忽略 */ }
})

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

/** 等 xterm 屏幕文本稳定（连续 500ms 不变且已出现提示符）：新建 pane 的 fit
 *  重绘 churn 期间 ConPTY 反复 resize 重绘横幅，实测早期键入会被 resize 冲掉 */
async function waitXtermSettled(xterm: ReturnType<Page['locator']>) {
  let prev = ''
  for (let i = 0; i < 24; i++) {
    const cur = await xterm.textContent().catch(() => '')
    if (cur && cur === prev && /[>$#] /.test(cur)) return
    prev = cur
    await sleep(500)
  }
}

/** 点入 xterm 并确保焦点落在该 pane 的隐藏输入 textarea 后再键入。
 *  新建 tab 后的 fit 重绘 churn 可能重建 textarea 夺焦——键入落进 body 即静默
 *  丢失，故键入前显式断言焦点，未中则重点（至多 5 轮） */
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

/** 进项目页 + 双终端会话就位：清 uiState 恢复的历史 tab，新建 A/B 两 tab，
 *  各 echo 独有关键词，结束时活跃 tab = B（后建即激活） */
async function setupTwoTerminals(page: Page) {
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')

  // 开底部终端面板 + 落在终端 tab（面板开合/bottomTab 都是 uiState 持久态，跨用例
  // 跑序而异；且项目页 boot 布局恢复（useLayoutBootstrap.restoreLayoutState）在
  // fetchProjects 等拉取之后才落地——晚到的恢复会整体覆盖此前已生效的 rail 点击/
  // tab 切换，分片负载下复现「点了 rail 面板仍收起」/「新建终端钮消失」。CLAUDE.md
  // 「面板开关是 toggle 语义」惯例：单发 isVisible+click 不够，循环按实时状态归一化
  // 到「面板开 + 终端 tab + 新建钮可见」基线——恢复每次挂载至多落地一次，循环必收敛）
  const panel = page.locator('.bottom-panel')
  const railTerminal = page.locator('.rail-btn[title="终端"]')
  const terminalTab = page.locator('.bottom-tabs button').filter({ hasText: '终端' })
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  for (let i = 0; i < 10; i++) {
    if (await newBtn.isVisible().catch(() => false)) break
    if (!(await panel.isVisible().catch(() => false))) {
      await railTerminal.click()
    } else {
      // 面板开着但非终端 tab（boot 恢复切走/上用例遗留）：切回终端 tab
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

  // 新建 tab A → 打印 ALPHA（newBtn 可见性已由上方归一化循环保证，此处仅兜底断言）
  await expect(newBtn).toBeVisible({ timeout: 5000 })
  await newBtn.click()
  const xtermA = page.locator('.xterm:visible').last()
  await expect(xtermA).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows PowerShell（PS ...）/ Linux bash（$ 或 #）
  await expect(xtermA).toContainText(/[$#] |PS /, { timeout: 20000 })
  await waitXtermSettled(xtermA)
  await typeViaXterm(page, xtermA, `echo ${MARK_A}\r`)
  await expect(xtermA).toContainText(MARK_A, { timeout: 15000 })

  // 新建 tab B（新建即激活）→ 打印 BETA
  await newBtn.click()
  const xtermB = page.locator('.xterm:visible').last()
  await expect(xtermB).toBeVisible({ timeout: 20000 })
  // shell 未就绪时键入会被吞、fit 重绘 churn 期键入会被 resize 冲掉——
  // 提示符可见且屏幕稳定后再点入键入
  await expect(xtermB).toContainText(/[$#] |PS /, { timeout: 20000 })
  await waitXtermSettled(xtermB)
  await typeViaXterm(page, xtermB, `echo ${MARK_B}\r`)
  await expect(xtermB).toContainText(MARK_B, { timeout: 15000 })

  // 活跃 tab = 第二个（tab B）：aria-selected 语义锚点断言
  const tabs = page.locator('.term-tablist .term-tab')
  await expect(tabs).toHaveCount(2)
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true')
  return tabs
}

/** 命令面板命令模式 → 打开「搜索终端输出」浮层。
 *  走顶栏搜索触发器按钮（Ctrl+K 会被聚焦中的 xterm 吃成 ^K 输入不达全局钩子） */
async function openOutputSearch(page: Page) {
  await page.locator('.header-search-trigger').click()
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>搜索终端输出')
  await expect(page.locator('.palette-item').first()).toContainText('搜索终端输出', { timeout: 5000 })
  await page.keyboard.press('Enter')
  const overlay = page.locator('[data-testid="terminal-output-search"]')
  await expect(overlay).toBeVisible({ timeout: 5000 })
  // 浮层打开、命令面板收起
  await expect(page.locator('.palette-mask')).toHaveCount(0)
  return overlay
}

test('两会话独有关键词各自命中（含 q<2 下限提示）', async ({ page }) => {
  test.setTimeout(180000)
  await setupTwoTerminals(page)
  const overlay = await openOutputSearch(page)

  const searchInput = overlay.locator('input').first()
  // q<2 字符：前端同门槛提示，不发起检索
  await searchInput.fill('E')
  await expect(overlay).toContainText('输入至少 2 个字符', { timeout: 5000 })

  // 公共前缀一次搜出双命中：两会话各打印的独有关键词各自成行。
  // 每会话≥2 行命中（PSReadLine 对键入行的分段回显 + 命令输出行同含标记词），
  // 行级断言取 first
  await searchInput.fill(MARK_PREFIX)
  const rowA = overlay.locator('.tosearch-item').filter({ hasText: MARK_A }).first()
  const rowB = overlay.locator('.tosearch-item').filter({ hasText: MARK_B }).first()
  await expect(rowA).toBeVisible({ timeout: 10000 })
  await expect(rowA).toContainText(MARK_A)
  await expect(rowB).toBeVisible({ timeout: 10000 })
  await expect(rowB).toContainText(MARK_B)
  // 命中行带会话名徽标（「哪个会话打的」是本功能的靶心信息）
  await expect(rowA.locator('.tosearch-item-session')).not.toBeEmpty()

  // 单关键词精确命中会话 A 的行；会话 B 的关键词无命中
  await searchInput.fill(MARK_A)
  await expect(overlay.locator('.tosearch-item').filter({ hasText: MARK_A }).first()).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('.tosearch-item').filter({ hasText: MARK_B })).toHaveCount(0)
})

test('点击命中跳到对应会话（活跃 tab 切换 + 活跃屏含目标关键词）', async ({ page }) => {
  test.setTimeout(180000)
  const tabs = await setupTwoTerminals(page)
  // 活跃 tab = B 基线上发起检索：点击 A 的命中必须把活跃 tab 切回 A
  const overlay = await openOutputSearch(page)
  const searchInput = overlay.locator('input').first()
  await searchInput.fill(MARK_A)
  const rowA = overlay.locator('.tosearch-item').filter({ hasText: MARK_A }).first()
  await expect(rowA).toBeVisible({ timeout: 10000 })
  await rowA.click()

  // 浮层关闭 + 活跃 tab 切到第一个（tab A）+ 活跃屏含 ALPHA 关键词
  await expect(overlay).toHaveCount(0)
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true', { timeout: 10000 })
  // xterm 取 last（CLAUDE.md「测试」节）：多 tab 时 last 即当前活跃屏
  await expect(page.locator('.xterm:visible').last()).toContainText(MARK_A, { timeout: 10000 })
})

test('命中时间锚 + 时间档过滤 + 档外折叠计数（未挂载会话命中显示 —）', async ({ page }) => {
  test.setTimeout(240000)
  await setupTwoTerminals(page)

  // API 直建第三会话（tab 是本地列表不随快照自增——前端无 pane 无区间账），
  // broadcast-write 让它打印独有标记（服务端 readLoop 无条件落环形缓冲，检索面
  // 照扫；前端从未消费其 C/D，命中行无所属命令时刻）。shell 未就绪时写入丢弃，
  // 轮询 scrollback 见标记为止
  expect(projId).not.toBe('')
  const createRes = await api('POST', '/api/terminals', { projectId: projId, name: 'e2e-tos-ghost' })
  expect([200, 201]).toContain(createRes.status)
  const ghostId = String((createRes.json?.data as { id?: string })?.id || '')
  expect(ghostId).not.toBe('')
  let ghostEchoed = false
  for (let i = 0; i < 30 && !ghostEchoed; i++) {
    await api('POST', '/api/terminals/broadcast-write', { ids: [ghostId], data: `echo ${MARK_GHOST}\r` })
    await sleep(1000)
    const sb = await fetch(`${API_BASE}/api/terminals/${ghostId}/scrollback`, {
      headers: { 'X-Lock-Token': unlockToken },
    })
    ghostEchoed = (await sb.text()).includes(MARK_GHOST)
  }
  expect(ghostEchoed).toBe(true)

  const overlay = await openOutputSearch(page)
  const searchInput = overlay.locator('input').first()
  // 公共子串 'MARK' 一次搜出两类命中：挂载会话（有账）+ 未挂载会话（无账）。
  // 锚定行定位 = 「带非 — 时间 chip 的 MARK_A 行」（PSReadLine 分段回显可能多行
  // 命中，锚定判定看任一行有锚即可；行界漂移时个别行落「—」属如实降级）
  await searchInput.fill('MARK')
  const anchoredA = overlay.locator('.tosearch-item')
    .filter({ hasText: MARK_A })
    .locator('.tosearch-item-time:not(.is-unknown)')
  const rowGhost = overlay.locator('.tosearch-item').filter({ hasText: MARK_GHOST }).first()
  await expect(anchoredA.first()).toBeVisible({ timeout: 10000 })
  await expect(rowGhost).toBeVisible({ timeout: 10000 })
  // 时间锚：挂载会话命中带 HH:MM（echo 命令的 D 记账时刻）；未挂载会话如实「—」
  await expect(anchoredA.first()).toHaveText(/^\d{2}:\d{2}$/, { timeout: 5000 })
  await expect(rowGhost.locator('.tosearch-item-time')).toHaveText('—')

  // 「今天」档：挂载会话命中（时刻=刚刚）仍在档内；无锚命中折叠计数不消失
  await overlay.locator('[data-testid="terminal-output-time-today"]').click()
  await expect(anchoredA.first()).toBeVisible()
  await expect(overlay.locator('.tosearch-item').filter({ hasText: MARK_GHOST })).toHaveCount(0)
  const collapsed = overlay.locator('[data-testid="terminal-output-search-collapsed"]')
  await expect(collapsed).toBeVisible()
  await expect(collapsed).toContainText(/\d+/)

  // 自定义档（昨天全天）：本批命中全部档外 → 列表清空但折叠计数如实回告
  // （保底不误导「搜不到」）
  await overlay.locator('[data-testid="terminal-output-time-custom"]').click()
  const yd = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  const ydLocal = `${yd.getFullYear()}-${pad(yd.getMonth() + 1)}-${pad(yd.getDate())}`
  await overlay.locator('[data-testid="terminal-output-time-start"]').fill(`${ydLocal}T00:00`)
  await overlay.locator('[data-testid="terminal-output-time-end"]').fill(`${ydLocal}T23:59`)
  await expect(overlay.locator('.tosearch-item')).toHaveCount(0)
  await expect(collapsed).toBeVisible()

  // 折叠行可点 = 回「全部」恢复全列表（失败可恢复）
  await collapsed.click()
  await expect(anchoredA.first()).toBeVisible()
  await expect(rowGhost).toBeVisible()
})
