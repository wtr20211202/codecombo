import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 编辑器「发送选中到终端」（P-20261004-21）E2E：
 *   1. 选中两行 → 右键「发送选中到终端」→ 多行确认弹层（行数文案 + 预览含两行）
 *      → 「仍要发送」→ 活跃终端收到回车执行（两条 echo 标记落屏）
 *   2. 弹层取消 → 终端无标记（不落 PTY）
 *   3. 单行选区（无确认面）→ 直发 → 无活跃终端时自动开项目默认终端并执行
 *      （createIfMissing 链：开底部终端面板 → createTerminal → sendText）
 * 菜单触发口径：真实菜单项鼠标点击即动作；headless 下 shadow DOM 菜单聚焦状态
 * 不定（ask-selection 同款实测），driveSendItem 点击失败即重开右键菜单交替重试，
 * 直至 until() 信号（弹层可见 / 标记落屏）。重入安全由组合式 sending 锁兜底
 * （链中重复触发直接短路，不会叠出第二张确认卡）。
 * 自备临时项目 + 夹具文件（两行 echo 标记命令）；afterEach 清理全部终端会话
 * （服务端会话表是 tab 恢复源，清空后新页面天然「无终端」），afterAll 清理项目
 * 与夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-editor-send2term'
const FILE = 'run.sh'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-editor-send2term')
const MARK_A = 'SC2T_MARK_A_7Q4'
const MARK_B = 'SC2T_MARK_B_9Z2'
const FILE_BODY = `echo ${MARK_A}\necho ${MARK_B}\n`
const MENU_LABEL = '发送选中到终端'

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

/** 清理全部终端会话：服务端会话表即前端 tab 恢复源，残留会污染「无终端」前置 */
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
  fs.writeFileSync(path.join(REPO_DIR, FILE), FILE_BODY)
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

/** 进项目页并打开夹具文件（ask-selection 同款就绪等待/重试口径） */
async function openFile(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
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

/** 键盘选中前两行（第 1 行首 → 第 2 行尾）并断言选区真实落上：EditContext 首击
 *  接线竞态 + 渲染帧滞后两处实测竞态靠「重试点选 + expect 轮询」收敛
 *  （ask-selection 同款） */
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

/** 打开编辑器右键菜单并返回「发送选中到终端」菜单项（菜单在 shadow DOM，
 *  Playwright locator 自动穿透；无选区时该项被 precondition 隐藏不渲染）。
 *  菜单可见后先落定 ~500ms 再交触发器：Monaco 菜单行在初开瞬间仍会被上下文键
 *  解析重渲染，紧贴 visible 的瞬时点击会被吞（库级探针 600ms 间隔恒过、runner
 *  零间隔恒吞的实测差异；ask-selection 的 2s 轮询间隔同理天然落定） */
async function openContextMenuAndGetSendItem(page: Page) {
  await page.locator('.monaco-editor .view-line').first().click({ button: 'right' })
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  await page.waitForTimeout(500)
  const sendItem = menu.first().locator('.action-item').filter({ hasText: MENU_LABEL })
  return { menu, sendItem }
}

/** 触发「发送选中到终端」直至 until() 信号成立：headless 下 shadow DOM 菜单
 *  聚焦状态不定，真实菜单项单击实测偶发无效（ask-selection 同款取证，trace
 *  开启时因动作放慢而稳定、无 trace 时高频复现）——点击与「聚焦+Enter」交替
 *  重试，点击失败（菜单瞬时失焦即关）即重开右键菜单。选区覆盖 1-2 行，选区内
 *  右键不塌缩选区；重入安全由组合式 sending 锁兜底（链中重复触发直接短路） */
async function driveSendItem(
  page: Page,
  until: () => Promise<boolean>,
  attempts = 8,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (await until()) return
    try {
      const { sendItem } = await openContextMenuAndGetSendItem(page)
      if (attempt % 2 === 0) {
        await sendItem.click({ timeout: 3000 })
      } else {
        await sendItem.focus()
        await page.keyboard.press('Enter')
      }
    } catch { /* 菜单未开出/项不在（选区竞态）：下一轮重试 */ }
    await expect.poll(until, { timeout: 4000, intervals: [200, 500, 1000] }).toBe(true)
      .catch(() => { /* 本轮未触发：重开菜单再试 */ })
  }
  expect(await until(), '重试上限内未观察到发送信号').toBe(true)
}

/** 可见 xterm 屏是否已出现标记（无可见终端返回 false） */
async function xtermHas(page: Page, marker: string): Promise<boolean> {
  const xt = page.locator('.xterm:visible').last()
  if ((await xt.count()) === 0) return false
  const txt = await xt.textContent().catch(() => '')
  return !!txt && txt.includes(marker)
}

/** 在底部面板先备好一个活跃终端（uiState/服务端会话已由 beforeEach 清空，
 *  新建即唯一 tab）；返回可见 xterm */
async function ensureActiveTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端"]').click()
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  // 先前用例可能把底部面板留在 Git/控制台分区：归一化到终端分区再点新建
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows PowerShell / Linux bash(#$)
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

const multilineDialog = (page: Page) =>
  page.locator('.n-dialog').filter({ hasText: '多行内容发送确认' })

test('选中两行右键发送 → 多行确认弹层 → 确认后终端收到执行', async ({ page }) => {
  test.setTimeout(180000)
  await openFile(page)
  const xterm = await ensureActiveTerminal(page)

  await selectFirstTwoLines(page)
  await driveSendItem(page, async () => multilineDialog(page).isVisible().catch(() => false))

  // 多行确认弹层：行数文案 + 预览含两行 + 「不再提示」勾选在（多行档可豁免）
  const dialog = multilineDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('选中内容包含 2 行')
  await expect(dialog).toContainText(MARK_A)
  await expect(dialog).toContainText(MARK_B)
  await expect(dialog.locator('.n-checkbox')).toHaveCount(1)

  await dialog.locator('.n-dialog__action button').filter({ hasText: '仍要发送' }).click()
  await expect(dialog).toHaveCount(0)
  // 两条 echo 经尾部 \r 依次执行，标记行落屏
  await expect(xterm).toContainText(MARK_A, { timeout: 30000 })
  await expect(xterm).toContainText(MARK_B, { timeout: 30000 })
})

test('多行确认弹层取消 → 终端不落任何内容', async ({ page }) => {
  test.setTimeout(180000)
  await openFile(page)
  const xterm = await ensureActiveTerminal(page)

  await selectFirstTwoLines(page)
  await driveSendItem(page, async () => multilineDialog(page).isVisible().catch(() => false))

  const dialog = multilineDialog(page)
  await expect(dialog).toBeVisible()
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  // 等一拍终端渲染后仍无标记（取消 = 不落 PTY）
  await page.waitForTimeout(2000)
  await expect(xterm).not.toContainText(MARK_A)
  await expect(xterm).not.toContainText(MARK_B)
})

test('单行选区直发：无活跃终端时自动开项目默认终端并执行', async ({ page }) => {
  test.setTimeout(180000)
  await openFile(page)
  // 前置：无任何终端 tab（beforeEach 已清服务端会话，本用例不建终端）
  await expect(page.locator('.term-tab')).toHaveCount(0)

  // 单行选区（第 1 行）：无多行/大文本确认面，菜单项直接可触发
  const line1 = page.locator('.monaco-editor .view-line').first()
  const selected = page.locator('.monaco-editor .selected-text').first()
  for (let attempt = 0; attempt < 4; attempt++) {
    await line1.click({ position: { x: 10, y: 8 } })
    await page.keyboard.press('Home')
    await page.keyboard.down('Shift')
    await page.keyboard.press('End')
    await page.keyboard.up('Shift')
    try {
      await expect(selected).toBeVisible({ timeout: 2000 })
      break
    } catch { /* 选区未落上：重试 */ }
  }

  await driveSendItem(page, () => xtermHas(page, MARK_A))

  // 自动开链收尾面：底部面板在、项目默认终端 tab 已建、标记执行落屏
  await expect(page.locator('.bottom-panel')).toBeVisible()
  await expect(page.locator('.term-tab').first()).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.xterm:visible').last()).toContainText(MARK_A, { timeout: 30000 })
})
