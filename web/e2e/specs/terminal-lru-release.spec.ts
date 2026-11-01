import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 不活动终端 tab 的 xterm LRU 释放 E2E（P-20261007-21）：
 *   1. 预算收敛：6 会话 > K=4，驻留 xterm 实例（.xterm-screen DOM 数 = 活实例
 *      数，被逐实例 dispose 后连 DOM 一起摘除）收敛到 4；
 *   2. 驱逐目标确定性：按 1→6 序激活后最久未用的 1、2 被逐（按 tab 容器内
 *      xterm-screen 归属断言，不靠计数猜）；
 *   3. 驱逐态数据链存活：向已逐会话 broadcast-write，输出点亮未读点
 *      （P-310 headless 管线：渲染层没了，未读/记账不断流）——echo 能跑也证明
 *      驱逐未杀底层会话（native 后端 WS 断开杀 shell 的回归防线）；
 *   4. 重挂恢复：切回被逐 tab → 服务端 scrollback 重放全量恢复（驱逐期输出在
 *      内，服务端缓冲记账的兑现）+ 未读点清零 + 会话可继续键入；
 *   5. 观测锚点：设置·终端诊断面活实例计数 4/4、累计释放 ≥1。
 */

const BASE = API_BASE
const TS = Date.now()
const NAMES = [1, 2, 3, 4, 5, 6].map(n => `sc-lru-${n}-${TS}`)

interface SessionRow { id: string; kind?: string; projectId?: string; name?: string }

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const res = await request.get(`${BASE}/api/terminals`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: SessionRow[] }).data || []
}

async function writeInput(request: APIRequestContext, id: string, data: string): Promise<void> {
  const res = await request.post(`${BASE}/api/terminals/broadcast-write`, {
    headers: await unlockHeaders(request),
    data: { ids: [id], data },
  })
  expect(res.ok()).toBeTruthy()
}

/** 某会话 pane 容器内当前挂着的 xterm 实例数（0 = 已被 LRU 释放） */
function paneScreen(page: Page, id: string) {
  return page.locator(`.term-tab-content[data-tab-id="${id}"] .xterm-screen`)
}

test('6 会话 LRU 收敛到 4：驱逐态未读链路存活、切回全量恢复、计数可见', async ({ page, request }) => {
  test.setTimeout(240_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  const projRes = await request.get(`${BASE}/api/projects`, { headers: await unlockHeaders(request) })
  const proj = ((await projRes.json()) as { data?: Array<{ id: string; name: string }> }).data
    ?.find(x => x.name === 'simple-coding')
  expect(proj, 'simple-coding 项目应已播种').toBeTruthy()

  // 归一化：清掉本 spec 同名遗留 + 项目下全部 shell 会话（xterm-screen 计数
  // 断言要求面板内只有本 spec 的会话；旧 tab 拦截点击是串行套件互扰根因）
  for (const s of await listSessions(request)) {
    if (s.kind === 'shell' && (s.projectId === proj!.id || NAMES.includes(s.name || ''))) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers: await unlockHeaders(request) })
    }
  }

  // 打开项目 → 底部终端面板可见
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 预置 6 个 shell 会话（terminals.changed 对账自动追加 tab 并自行连接）
  for (const name of NAMES) {
    await request.post(`${BASE}/api/terminals`, { headers: await unlockHeaders(request), data: { projectId: proj!.id, name } })
  }
  const tabs = NAMES.map(name => page.locator('.term-tab').filter({ hasText: name }))
  for (const tab of tabs) await expect(tab).toBeVisible({ timeout: 20_000 })

  const sessions = (await listSessions(request)).filter(s => s.projectId === proj!.id && s.kind === 'shell')
  const idByName = new Map(sessions.map(s => [s.name!, s.id!]))
  const ids = NAMES.map(name => idByName.get(name))
  for (const id of ids) expect(id, '六个会话都应在册').toBeTruthy()

  try {
    // 等预算收敛：6 会话挂载 + IO 可见性记账补执行后，活实例收敛到 K=4
    await expect.poll(() => page.locator('.xterm-screen').count(), {
      timeout: 30_000,
      intervals: [1000],
      message: 'LRU budget should converge to 4 resident xterm instances',
    }).toBe(4)

    // 按序激活 1→6（间隔拉开，lastUsed 严格有序）：最久未用的 1、2 被逐，
    // 5、6 与最近激活的 3、4 驻留——驱逐归属确定（不靠计数猜）
    for (const tab of tabs) {
      await tab.click()
      await expect(tab).toHaveClass(/is-active/)
      await page.waitForTimeout(900)
    }
    await expect.poll(() => page.locator('.xterm-screen').count(), {
      timeout: 15_000,
      intervals: [1000],
    }).toBe(4)
    expect(await paneScreen(page, ids[0]!).count(), '最久未用的会话 1 应已被逐').toBe(0)
    expect(await paneScreen(page, ids[1]!).count(), '次久的会话 2 应已被逐').toBe(0)
    expect(await paneScreen(page, ids[5]!).count(), '最新激活的会话 6 应驻留').toBe(1)

    // 驱逐态数据链存活：向已逐的会话 1 写标记输出——
    // echo 跑通 = 驱逐未杀底层会话；未读点点亮 = headless 管线记账不断流
    const FIRST = `SC_LRU_FIRST_${TS}`
    const MID = `SC_LRU_MID_${TS}`
    const LAST = `SC_LRU_LAST_${TS}`
    const tab1 = tabs[0]!
    await writeInput(request, ids[0]!, `echo ${FIRST}\r`)
    await writeInput(request, ids[0]!, `echo ${MID}\r`)
    await writeInput(request, ids[0]!, `echo ${LAST}\r`)
    await expect(tab1.locator('[data-testid="term-tab-unread"]')).toBeVisible({ timeout: 15_000 })

    // 重挂恢复：切回被逐 tab → connect 重建 + 服务端 scrollback 重放——
    // 驱逐期输出完整回屏（服务端缓冲记账的兑现），未读点清零
    await tab1.click()
    await expect(tab1).toHaveClass(/is-active/)
    const activeXterm = page.locator('.xterm:visible').last()
    await expect(activeXterm).toContainText(FIRST, { timeout: 20_000 })
    await expect(activeXterm).toContainText(MID)
    await expect(activeXterm).toContainText(LAST)
    await expect(tab1.locator('[data-testid="term-tab-unread"]')).toHaveCount(0)
    expect(await paneScreen(page, ids[0]!).count(), '切回后实例已重建').toBe(1)
    // 预算保持：恢复 1 挤出下一个最久未用者（3），驻留恒 4
    await expect.poll(() => page.locator('.xterm-screen').count(), {
      timeout: 15_000,
      intervals: [1000],
    }).toBe(4)

    // 恢复后会话可用：键入回显照常到达（WS 双向链路完好）
    const OK = `SC_LRU_OK_${TS}`
    await activeXterm.click()
    await page.keyboard.type(`echo ${OK}`)
    await page.keyboard.press('Enter')
    await expect(activeXterm).toContainText(OK, { timeout: 15_000 })

    // 观测锚点：设置·终端·诊断面——活实例计数与累计驱逐
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible({ timeout: 5000 })
    const stats = page.locator('[data-testid="settings-terminal-lru-stats"]')
    await expect(stats).toBeVisible()
    await expect(stats).toContainText('4/4', { timeout: 10_000 })
    await expect(stats).toContainText(/释放 [1-9]\d* 次/)
  } finally {
    // 会话用完即删（断言失败也清理，防跨 spec 残留 tab 拦截点击）
    for (const id of ids) {
      if (id) await request.delete(`${BASE}/api/terminals/${id}`, { headers: await unlockHeaders(request) })
    }
  }
})
