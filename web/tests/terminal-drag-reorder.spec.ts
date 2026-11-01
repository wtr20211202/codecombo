import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, createAgentSession, projectCardByName } from './helpers'

/**
 * 侧栏拖拽排序 E2E（打磨轮8）：HTML5 DnD（DataTransfer dispatch，headless 下
 * 原生鼠标拖拽不触发 dnd）。
 *
 * 覆盖点：
 *   1. 组内会话拖到另一会话上 = 插到其前（uiState 持久化，重载后保留）
 *   2. 分组头拖到另一分组头 = 移到其前
 *
 * 分组持久化在服务端 ui-state（'local' 实例全局）：组名带唯一前缀，
 * beforeEach 清理全部 drag-e2e-* 残留——按通用前缀而非本次随机前缀，
 * 否则中断/失败的旧运行留下的分组会成为永久垃圾（实测已在实例数据中累积）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const LEGACY_PREFIX = 'drag-e2e-'
const PREFIX = `${LEGACY_PREFIX}${Math.random().toString(36).slice(2, 7)}-`
const G1 = `${PREFIX}甲`
const G2 = `${PREFIX}乙`

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanup(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  for (const s of list) {
    if (s.kind === 'agent') await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
  // 清理全部 drag-e2e-* 历史分组（通用前缀，覆盖中断的旧运行残留）
  const state = await request.get(`${BASE}/api/ui-state`, { headers })
  const all = ((await state.json()) as {
    data?: Record<string, { agentTerminal?: { groups?: { id: string; name: string }[] } }>
  }).data || {}
  const local = all.local
  if (local?.agentTerminal?.groups?.some(g => g.name.startsWith(LEGACY_PREFIX))) {
    local.agentTerminal.groups = local.agentTerminal.groups.filter(g => !g.name.startsWith(LEGACY_PREFIX))
    await request.put(`${BASE}/api/ui-state`, { headers, data: all })
  }
}

/** 派发 HTML5 DnD 事件序列：dragstart → dragover → drop → dragend */
async function dragTo(page: Page, src: ReturnType<Page['locator']>, dst: ReturnType<Page['locator']>) {
  const srcEl = await src.elementHandle()
  const dstEl = await dst.elementHandle()
  await page.evaluate(([s, d]) => {
    const se = s as HTMLElement
    const de = d as HTMLElement
    const dt = new DataTransfer()
    se.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    de.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    de.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    se.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
  }, [srcEl, dstEl])
}

test.describe('侧栏拖拽排序（打磨轮8）', () => {
  let view: ReturnType<Page['locator']>

  test.beforeEach(async ({ page, request }) => {
    await cleanup(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
    await createAgentSession(page, view)
    await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })

    // 建两个组（新建分组 → 内联输入 → Enter）
    for (const name of [G1, G2]) {
      await view.getByRole('button', { name: '新建分组' }).click()
      const input = view.locator('.ats-footer input')
      await input.fill(name)
      await input.press('Enter')
      await expect(view.locator('.ats-section', { hasText: name })).toBeVisible()
    }
  })

  test.afterEach(async ({ request }) => {
    await cleanup(request)
  })

  test('组内会话拖到另一会话前 + 重载后顺序保留', async ({ page, request }) => {
    // 两个会话经右键菜单移入 G1（移入顺序 = 菜单操作顺序）
    for (const name of ['终端 1', '终端 2']) {
      await view.locator('.ats-item', { hasText: name }).click({ button: 'right' })
      await page.locator('.n-dropdown-option', { hasText: `移动到「${G1}」` }).click()
    }
    const section = view.locator('.ats-section', { hasText: G1 })
    await expect(section.locator('.ats-item-title')).toHaveText(['终端 1', '终端 2'])

    // 拖「终端 2」到「终端 1」上 = 插到其前
    await dragTo(page,
      section.locator('.ats-item', { hasText: '终端 2' }),
      section.locator('.ats-item', { hasText: '终端 1' }),
    )
    await expect(section.locator('.ats-item-title')).toHaveText(['终端 2', '终端 1'])

    // 重载前必须等 uiState 异步持久化落盘——persistUi 是 watch 触发的异步
    // PUT，立刻 reload 会打断在途请求导致顺序丢失（全量串行负载下必现）。
    // 轮询服务端状态（id→name 映射后断言顺序）而非盲等固定时长
    await expect.poll(async () => {
      const headers = await unlockHeaders(request)
      const state = await (await request.get(`${BASE}/api/ui-state`, { headers })).json()
      const groups = state?.data?.local?.agentTerminal?.groups || []
      const g = groups.find((x: { name?: string }) => x.name === G1)
      if (!g) return []
      const list = ((await (await request.get(`${BASE}/api/terminals`, { headers })).json()).data || [])
      const nameOf = (id: string) => list.find((s: { id: string }) => s.id === id)?.name || id
      return (g.sessionIds as string[]).map(nameOf)
    }, { timeout: 5000 }).toEqual(['终端 2', '终端 1'])

    // 重载：顺序经 uiState 持久化保留
    await page.reload()
    await gotoAndUnlock(page, '/')
    // 管理器 home 形态经 localStorage 开合态恢复，全屏 overlay 会盖住首页——
    // 先关闭管理器再点项目卡（否则 overlay 拦截卡片点击）
    const homeOverlay = page.locator('.agt-home-overlay')
    if (await homeOverlay.isVisible().catch(() => false)) {
      await homeOverlay.locator('.atv-header-actions button').last().click()
      await expect(homeOverlay).toBeHidden({ timeout: 5000 })
    }
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view2 = page.locator('.atv-root')
    await expect(view2).toBeVisible({ timeout: 10000 })
    await expect(view2.locator('.ats-section', { hasText: G1 }).locator('.ats-item-title'))
      .toHaveText(['终端 2', '终端 1'], { timeout: 10000 })
  })

  test('分组头拖到另一分组头 = 移到其前', async ({ page }) => {
    // 初始 DOM 顺序：G1 在前、G2 在后；拖 G2 头到 G1 头 = G2 移到 G1 之前
    await dragTo(page,
      view.locator('.ats-group-head', { hasText: G2 }),
      view.locator('.ats-group-head', { hasText: G1 }),
    )
    const order = await page.evaluate(([a, b]) =>
      [...document.querySelectorAll('.ats-group-name')]
        .map(el => el.textContent?.trim())
        .filter(t => t === a || t === b),
    [G1, G2])
    expect(order).toEqual([G2, G1])
  })
})
