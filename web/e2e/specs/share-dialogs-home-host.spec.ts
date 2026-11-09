import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'
import { serverIsLinux } from '../../tests/dualpath'

/**
 * 分享族弹层跨宿主（P-20261108-1）E2E：结果卡/创建/终端选项/片段四件弹层的
 * 宿主自 Layout 上提 App 层（ShareDialogsHost）——不经 Layout 的首页 `/` 同样
 * 弹得出。修复前首页入口把单例状态置 open 却无人渲染，弹层全程不出现（静默
 * 失效、无报错）：
 *   1. 首页工具条打开终端会话管理（全屏 overlay）→ 会话行右键「直播分享」→
 *      选项弹层（ShareTermOptionsDialog）可见 → 确认创建 → 结果卡
 *      （ShareResultDialog）同宿主可见 + 服务端直播记录锚定该会话 →
 *      「管理全部分享」走 ?view=shares 深链进项目页分享管理视图，且首页带入的
 *      docked 管理页让位（不与分享管理叠成双视图）
 *   2. 首页 overlay 会话 pane 终端选区 → 右键「分享选中文本」→ 片段弹窗
 *      （ShareSnippetDialog，选区预填）可见 → 创建 → 结果卡可见
 * 项目内原路径（宿主搬移不改语义）由 agent-session-share-actions /
 * share-terminal-live-tab / share-snippet / share 回归承担。
 */

const SESSION_NAME = 'e2e-home-share-host'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

type ShareRow = { token: string; kind: string; terminalId?: string }

async function listShares(request: APIRequestContext): Promise<ShareRow[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/share`, { headers })
  return ((await res.json()) as { data?: ShareRow[] }).data || []
}

/** 清空全部分享（服务端全局状态，保证确定性；终端直播撤销同时断流） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  for (const s of await listShares(request)) {
    await request.delete(`${API_BASE}/api/share/${s.token}`, { headers })
  }
}

/** 按名清理本 spec 的 agent 会话（重跑残留 + 用后即删） */
async function cleanupSessions(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name?: string }[] }).data || []
  for (const s of list) {
    if (s.name === SESSION_NAME) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers }).catch(() => { /* 已不存在即目标态 */ })
    }
  }
}

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击，先收起（既有惯例） */
async function dismissPasswordTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 停在首页，经工具条图标打开终端会话管理全屏 overlay（不进项目页——Layout 不
 *  挂载正是本 spec 的被测形态），返回 overlay 内管理页根与目标会话行 */
async function openHomeManagerRow(page: Page): Promise<{ view: ReturnType<Page['locator']>; row: ReturnType<Page['locator']> }> {
  await fixedLocale(page)
  // agent 终端开合/展开形态是 localStorage：清掉防重试残留——展开形态若为 float，
  // 工具条 open() 无参会开悬浮窗而非 docked overlay
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
    localStorage.removeItem('sc.agentTerminal.expandedMode')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordTip(page)
  await page.locator('.home-action-btn[title="终端会话管理"]').click()
  const view = page.locator('.agt-home-overlay .atv-root')
  await expect(view).toBeVisible({ timeout: 10_000 })
  const row = view.locator('.ats-item').filter({ hasText: SESSION_NAME }).first()
  await expect(row).toBeVisible({ timeout: 10_000 })
  return { view, row }
}

/** xterm 视口中 marker 文本的屏上矩形（DOM renderer 行内 Range 定位；自动化
 *  环境 navigator.webdriver 下终端恒走 DOM renderer）。命令回显行与输出行都含
 *  marker，取最后一条 = 输出行；轮询至出现 */
async function waitForMarkerRect(page: Page, marker: string, timeout = 10_000): Promise<{ left: number; right: number; centerY: number }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const rect = await page.evaluate((n) => {
      let hit: { left: number; right: number; centerY: number } | null = null
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
          const r = range.getBoundingClientRect()
          if (r.width > 0 && r.height > 0) hit = { left: r.left, right: r.right, centerY: r.top + r.height / 2 }
        }
      }
      return hit
    }, marker)
    if (rect) return rect
    if (Date.now() > deadline) throw new Error(`viewport 中找不到输出标记行: ${marker}`)
    await page.waitForTimeout(200)
  }
}

test.describe('share-dialogs-home-host', () => {
  test.beforeEach(async ({ request }) => {
    await cleanupShares(request)
    await cleanupSessions(request)
  })

  test.afterEach(async ({ request }) => {
    await cleanupSessions(request)
    await cleanupShares(request)
  })

  test('首页 overlay 行右键直播分享：选项弹层→结果卡可见→管理全部进项目分享管理且 docked 让位', async ({ page, request }) => {
    test.setTimeout(120_000)
    const created = await createAgentSessionApi(request, { name: SESSION_NAME })
    const { row } = await openHomeManagerRow(page)

    await row.click({ button: 'right' })
    const option = (text: string) => page.locator('.n-dropdown-option').filter({ hasText: text })
    await expect(option('直播分享')).toBeVisible({ timeout: 5000 })
    await option('直播分享').click()

    // 选项弹层（P-20261106-9 遮蔽/水印）：修复前首页无宿主，此断言即回归锚
    const options = page.locator('[data-testid="share-term-options"]')
    await expect(options).toBeVisible({ timeout: 5000 })
    await expect(options).toHaveAttribute('data-kind', 'live')
    await page.locator('[data-testid="share-term-confirm"]').click()

    // 结果卡同宿主（App 层）可见；服务端直播记录锚定该会话
    const result = page.locator('.share-result-modal')
    await expect(result).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      const live = (await listShares(request)).find(s => s.kind === 'terminal' && s.terminalId === created.id)
      expect(live?.token, '直播记录应锚定该会话').toBeTruthy()
    }).toPass({ timeout: 10_000 })
    // 页面仍在首页（Layout 未挂载）——跨宿主可见性的前提
    expect(new URL(page.url()).pathname).toBe('/')

    // 管理全部分享：分享管理是项目页主区视图，首页走 ?view=shares 深链进项目页
    await result.getByRole('button', { name: '管理全部分享' }).click()
    await expect(result).toBeHidden({ timeout: 5000 })
    await page.waitForURL('**/project')
    await expect(page.locator('.share-manager-embedded')).toBeVisible({ timeout: 10_000 })
    await expect(page.locator('.sm-toolbar-text h2')).toHaveText('文件分享')
    // 首页 overlay 的 docked 开态随导航带入项目页（P-20261107-3 无记忆=自然流入）：
    // 深链消费须显式让位，否则与分享管理叠成双视图
    await expect(page.locator('.atv-root')).toBeHidden()
  })

  test('首页 overlay 终端选区右键「分享选中文本」：片段弹窗→创建→结果卡可见', async ({ page, request }) => {
    test.setTimeout(180_000)
    await createAgentSessionApi(request, { name: SESSION_NAME })
    const { view, row } = await openHomeManagerRow(page)

    // 附着会话并等提示符（平台分支同既有终端 spec：Windows 提示符以 > 收尾；
    // Linux bash/sh 以 $（root 为 #）收尾）
    await row.click()
    const xterm = view.locator('.xterm:visible').last()
    await expect(xterm).toBeVisible({ timeout: 20_000 })
    await expect(xterm).toContainText(serverIsLinux ? /[#$] / : />/, { timeout: 20_000 })

    // 回显唯一标记行并拖选（起止点收进首/尾字符单元格内，terminal-ask-selection 同口径）
    const marker = `SC-E2E-HOMESNIP-${Date.now()}`
    await xterm.click()
    await page.keyboard.type(`echo ${marker}\r`)
    await expect(xterm).toContainText(marker, { timeout: 10_000 })
    const rect = await waitForMarkerRect(page, marker)
    await page.mouse.move(rect.left + 3, rect.centerY)
    await page.mouse.down()
    await page.mouse.move(rect.right + 3, rect.centerY, { steps: 5 })
    await page.mouse.up()

    await xterm.click({ button: 'right' })
    const ctxMenu = page.locator('.term-context-menu')
    await expect(ctxMenu).toBeVisible()
    const item = ctxMenu.locator('[data-testid="term-share-selection"]')
    await expect(item, '有选区 → 分享选中文本可用').toBeEnabled()
    await item.click()

    // 片段弹窗（修复前首页无宿主不出现）：选区原文预填
    const snippet = page.locator('.share-snippet-modal')
    await expect(snippet).toBeVisible({ timeout: 5000 })
    await expect(snippet.locator('textarea').first()).toHaveValue(new RegExp(marker))
    await snippet.locator('[data-testid="snippet-share-create"]').click()

    // 结果卡可见 + 服务端片段记录落地
    await expect(page.locator('.share-result-modal')).toBeVisible({ timeout: 10_000 })
    await expect(async () => {
      expect((await listShares(request)).some(s => s.kind === 'snippet'), '应创建 snippet 分享').toBe(true)
    }).toPass({ timeout: 10_000 })
    expect(new URL(page.url()).pathname).toBe('/')
  })
})
