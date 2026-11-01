import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * split 取消拆分的运行中进程保全 E2E（P-20261004-145）：
 *   - secondary 闲 pane：× 直拆无弹层（布局撤销语义不劣化）
 *   - secondary 有命令在跑（OSC 133 C 点亮 runningMap）：× / Ctrl+Shift+W →
 *     两选弹层（终止 / 转独立 tab），Esc 关闭不动现场
 *   - 转独立 tab：拆分变并列，进程未被处决——新 tab 接上运行点并跑完产出
 *     标记（sleep+echo 尾标记 = 进程存活的结构性证明，被杀则永无标记）
 *   - 弹层「关闭」：进程处决（服务端会话 2→1）
 *
 * running 判定依赖服务端 shell integration（创建会话恒注入，bash/zsh/
 * PowerShell 支持）；命令串 `sleep 8; echo …` 在 bash 与 PowerShell 同串可用。
 * 无集成的裸 shell running 恒 false 直拆，是提案声明的降级行为（不在 e2e 面）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
// 12s 观察窗：覆盖 弹层交互(~2s) + 转 tab 重挂连接重放(~2s) + 尾标记落屏
// 断言余量——窗口内全程 running，转 tab 后 is-running 断言不受重放快慢影响。
// START 标记是 C 帧到达的确定性信号（见 splitAndRunWatchCommand 门 3）
const WATCH_CMD = 'echo SC-P145-START; sleep 12; echo SC-P145-DONE'
// 热身命令：无副作用 echo，用于把 shell 集成钩子「焐热」（见门 2）；
// WARMUP_OUT 是它的回显输出行（短、不折行，作为屏面锚点）
const WARMUP_CMD = 'echo SC-P145-WARMUP'
const WARMUP_OUT = 'SC-P145-WARMUP'
const DIALOG_TITLE = '分屏中有命令正在运行'
const KEEP_BTN = '转为独立 tab 保留'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

/** 该项目在服务端的存活会话数（split 态 = 2：primary + secondary） */
async function projectSessionCount(request: APIRequestContext, projectId: string): Promise<number> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  return list.filter(s => s.projectId === projectId).length
}

async function openTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
}

async function closeAllTerminalTabs(page: Page) {
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

/** 打开 split 下拉并选方向 */
async function pickSplit(page: Page, direction: 'horizontal' | 'vertical') {
  await page.locator('.term-toolbar .term-tool-btn[title="水平拆分"]').click()
  const label = direction === 'horizontal' ? '水平拆分' : '垂直拆分'
  await page.locator('.n-dropdown:visible').getByText(label, { exact: true }).click()
}

/**
 * 活跃 tab 的布局根：TerminalPanesArea 对全部已知会话（含他项目/后台 tab）
 * 都渲染 `.term-pane-layout`（v-show 隐藏非活跃），全局会话表有残留会话时
 * 裸定位会 strict violation——断言锚定可见（=活跃）tab 的布局根。
 */
function activeLayout(page: Page) {
  return page.locator('.term-tab-content:visible .term-pane-layout')
}

/** 建 split 并在 secondary pane 里跑观察命令（点击 = 焦点 + activePaneId 落位）。
 *
 * 三个确定性时序门（此前「split 断言后立即键入 + 盲等 1.5s」在本机 e2e 上
 * 4/4 假红、加输出门后 Ctrl+Shift+W 用例仍 flaky 的根因）：
 *  1. WS 连接门：useTerminalSession.onData 仅在 readyState===OPEN 时 send，
 *     未连接期间键入的字符被静默丢弃——split 渲染断言通过时 secondary 的 WS
 *     可能仍在建立。首屏输出（banner/prompt）落地 = 连接完成（首帧必经 WS）。
 *  2. 集成热身门：服务端以 `-NoExit -File <集成脚本>` 启动 PowerShell，banner
 *     先于脚本执行完成出现——真实命令的 Enter 可能落进 PSReadLine 尚未接管
 *     的原生读取窗口：命令照常执行、但 133;C 不发（C 由 Enter 键处理器发出），
 *     弹层判定信号缺失。热身 echo 执行完且提示符回归（集成 prompt 函数已跑、
 *     Enter 钩子确定生效）后才发真实命令。
 *  3. C 帧门：shell 集成的 133;C 在 Enter 键处理期发出、先于命令体执行——
 *     START 标记上屏 = C 必已抵达前端（同条 PTY→WS→xterm 管道有序），
 *     此后点 × / Ctrl+Shift+W 弹层判定才必然命中。 */
async function splitAndRunWatchCommand(page: Page) {
  await pickSplit(page, 'horizontal')
  const layout = activeLayout(page)
  await expect(layout).toHaveClass(/split/, { timeout: 8000 })
  await expect(layout.locator('.term-pane')).toHaveCount(2, { timeout: 8000 })
  const secondary = layout.locator('.term-pane').last()
  // 门 1：secondary WS 连接完成（首屏输出落地）后才键入
  await expect
    .poll(
      async () =>
        (await secondary.locator('.xterm-rows').innerText().catch(() => '')).trim().length,
      { timeout: 15000 },
    )
    .toBeGreaterThan(0)
  await secondary.click()
  // 门 2：热身 + 提示符回归。锚定 WARMUP 的回显【输出】行（lastIndexOf）而非
  // 键入行——窄 pane 下键入行会被 xterm 折行打断（'echo SC-P145-' + 换行 +
  // 'WARMUP'），整串 substring 匹配不到；输出行 14 字符单行完整。WARMUP 输出
  // 之后最后一个非空字符是提示符尾字符（PowerShell `PS …>`、bash `…$ `），
  // 可控（WARMUP 输出本身不含这些字符）
  await page.keyboard.type(WARMUP_CMD)
  await page.keyboard.press('Enter')
  await expect(secondary.locator('.xterm-rows')).toContainText(WARMUP_OUT, { timeout: 15000 })
  await expect
    .poll(async () => {
      const text = await secondary.locator('.xterm-rows').innerText().catch(() => '')
      const idx = text.lastIndexOf(WARMUP_OUT)
      if (idx < 0) return ''
      return text.slice(idx + WARMUP_OUT.length).trimEnd().slice(-1)
    }, { timeout: 15000 })
    .toMatch(/[>$#]/)
  // 门 3：真实观察命令 + START 上屏 = C 帧已落 runningMap
  await page.keyboard.type(WATCH_CMD)
  await page.keyboard.press('Enter')
  await expect(secondary.locator('.xterm-rows')).toContainText('SC-P145-START', { timeout: 10000 })
}

function paneCloseDialog(page: Page) {
  return page.locator('.n-modal').filter({ hasText: DIALOG_TITLE })
}

test.describe('split 取消拆分的运行中进程保全', () => {
  let projectId = ''

  test.beforeEach(async ({ page, request }) => {
    projectId = await getSimpleCodingProjectId(request)
    await cleanupProjectTerminals(request, projectId)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')
    await openTerminalPanel(page)
    await closeAllTerminalTabs(page)
    await expect(page.locator('.term-tab')).toHaveCount(0, { timeout: 5000 })

    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
    // xterm 断言取 last（CLAUDE.md「测试」节）：多 tab 时旧屏 DOM 序在前，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content .xterm').last()).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
  })

  test('闲 pane ×：直拆无弹层（布局撤销语义不变）', async ({ page }) => {
    await pickSplit(page, 'horizontal')
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2, { timeout: 8000 })

    await page.locator('.term-tab .term-close-btn').first().click()
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(1, { timeout: 8000 })
    await expect(paneCloseDialog(page)).toHaveCount(0)
    await expect(page.locator('.term-tab')).toHaveCount(1)
  })

  test('running secondary ×：弹层出现，取消不动现场', async ({ page, request }) => {
    await splitAndRunWatchCommand(page)

    await page.locator('.term-tab .term-close-btn').first().click()
    const dialog = paneCloseDialog(page)
    await expect(dialog).toBeVisible({ timeout: 5000 })
    // 弹层期间不处决：布局与会话都原样
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2)
    await expect(await projectSessionCount(request, projectId)).toBe(2)

    await dialog.locator('.n-base-close').click()
    await expect(dialog).toHaveCount(0, { timeout: 5000 })
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2)
    await expect(await projectSessionCount(request, projectId)).toBe(2)
  })

  test('弹层「转为独立 tab」：进程存活跑完，拆分变并列', async ({ page, request }) => {
    await splitAndRunWatchCommand(page)

    await page.locator('.term-tab .term-close-btn').first().click()
    await expect(paneCloseDialog(page)).toBeVisible({ timeout: 5000 })
    await paneCloseDialog(page).getByRole('button', { name: KEEP_BTN }).click()

    // 拆分变并列：secondary 成为独立 tab，插到原 tab 之后（最近邻），布局回单 pane
    await expect(page.locator('.term-tab')).toHaveCount(2, { timeout: 5000 })
    await expect(page.locator('.term-tab').nth(1).locator('.term-tab-name')).toContainText('-split')
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(1)
    await expect(activeLayout(page)).not.toHaveClass(/split/)
    // 服务端两会话都在（转 tab 不新建不处决）
    await expect(await projectSessionCount(request, projectId)).toBe(2)

    // 新 tab 接上运行点（重放 C 帧 → is-running），命令跑完尾标记落屏——
    // 进程从未被处决的结构性证明
    await page.locator('.term-tab').nth(1).click()
    await expect(page.locator('.term-tab.is-running')).toHaveCount(1, { timeout: 8000 })
    await expect(page.locator('.term-tab-content:visible .xterm-rows')).toContainText('SC-P145-DONE', { timeout: 15000 })
    await expect(page.locator('.term-tab.is-running')).toHaveCount(0, { timeout: 15000 })
  })

  test('弹层「关闭」：进程处决，回单 pane', async ({ page, request }) => {
    await splitAndRunWatchCommand(page)

    await page.locator('.term-tab .term-close-btn').first().click()
    const dialog = paneCloseDialog(page)
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await dialog.getByRole('button', { name: '关闭（终止' }).click()

    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(1, { timeout: 8000 })
    await expect(page.locator('.term-tab')).toHaveCount(1)
    await expect(await projectSessionCount(request, projectId)).toBe(1)
  })

  test('Ctrl+Shift+W 关 pane：同判弹层（键路径收口）', async ({ page }) => {
    await splitAndRunWatchCommand(page)

    // 焦点仍在 secondary pane（splitAndRunWatchCommand 键入后未移），直击键位
    await page.keyboard.press('Control+Shift+w')
    const dialog = paneCloseDialog(page)
    await expect(dialog).toBeVisible({ timeout: 5000 })
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2)

    await dialog.locator('.n-base-close').click()
    await expect(activeLayout(page).locator('.term-pane')).toHaveCount(2)
  })
})
