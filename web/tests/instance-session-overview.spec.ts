import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 多实例会话总览（可操作版）E2E（路线图 #9）：
 *
 * 入口：Ctrl+K 命令面板 >「多实例会话总览」。
 * 覆盖点（本机实例块）：
 *   1. 总览列出本机会话
 *   2. 行内重命名（Enter 确认）→ 行名更新
 *   3. 结束会话（两击确认）→ 行消失、列表刷新为空
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

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

async function openTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
}

async function openOverview(page: Page) {
  await page.keyboard.press('Control+k')
  const palette = page.locator('.palette-card')
  await expect(palette).toBeVisible({ timeout: 5000 })
  // 命令模式：> 前缀 + 关键词过滤
  await page.keyboard.type('>多实例')
  await page.keyboard.press('Enter')
  const modal = page.locator('.n-modal').filter({ hasText: '多实例会话总览' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test.describe('多实例会话总览（可操作，路线图 #9）', () => {
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
    for (let i = 0; i < 20; i++) {
      const lastTab = page.locator('.term-tab').last()
      if ((await lastTab.count()) === 0) break
      await lastTab.locator('.term-close-btn').click()
      if (await page.locator('.n-modal').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '确认' }).click()
      }
      await page.waitForTimeout(300)
    }

    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
    // 等 WS 首批数据到达（shell banner/提示符）：键入经 ws.send 进 stdin，
    // readyState 未 OPEN 时按键被静默丢弃——必须等可交互再操作
    // xterm 断言取 last（CLAUDE.md「测试」节）：多 tab 时旧屏 DOM 序在前，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content .xterm-rows').last()).toContainText(/[A-Za-z]/, { timeout: 15000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
    // agent 会话清场（agent 跳转用例经 API 创建，无项目绑定）
    const headers = await unlockHeaders(request)
    const list = ((await (await request.get(`${BASE}/api/terminals`, { headers })).json()).data) || []
    for (const s of list) {
      if (s.kind === 'agent') await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  })

  test('列出会话 → 行内重命名 → 两击确认结束', async ({ page }) => {
    // 环境可能残留历史会话（其他 spec 的无项目 shell 会话）：
    // 用本次创建会话的 id（tab content 的 data-tab-id = 弹层行的 title）精确定位
    const tabId = await page.locator('.term-tab-content').first().getAttribute('data-tab-id')
    expect(tabId).toBeTruthy()

    const modal = await openOverview(page)
    const row = modal.locator(`.iso-row[title="${tabId}"]`)
    await expect(row).toBeVisible({ timeout: 5000 })

    // 行内重命名：hover 行显现操作钮 → 点 ✎ → 输入 → Enter
    await row.hover()
    await row.locator('button[title="重命名"]').click()
    const input = row.locator('input')
    await expect(input).toBeVisible()
    await input.fill('改名会话')
    await input.press('Enter')
    await expect(modal.locator('.iso-row').filter({ hasText: '改名会话' })).toBeVisible({ timeout: 5000 })
    // tab 条同步跟随（本机 rename 广播回灌）
    await expect(page.locator('.term-tab .term-tab-name').first()).toHaveText('改名会话', { timeout: 5000 })

    // 结束会话：两击确认（第一次 arm 变红，第二次执行）
    await row.hover()
    const endBtn = row.locator('button[title="结束会话"]')
    await endBtn.click()
    await expect(row.locator('button.armed')).toBeVisible()
    await row.locator('button.armed').click()
    // 行消失（块列表按 id 刷新）
    await expect(modal.locator(`.iso-row[title="${tabId}"]`)).toHaveCount(0, { timeout: 5000 })
  })

  test('查看输出（只读快照）→ 去操作（直达会话上下文）', async ({ page }) => {
    // 在终端里产出确定性内容（聚焦 pane → 输入 echo 标记）
    const pane = page.locator('.term-tab-content:not(.is-floating) .term-pane').first()
    await pane.click()
    await page.keyboard.type('echo SC-E2E-OUT-MARKER')
    await page.keyboard.press('Enter')
    await expect(pane.locator('.xterm-rows')).toContainText('SC-E2E-OUT-MARKER', { timeout: 8000 })

    const tabId = await page.locator('.term-tab-content').first().getAttribute('data-tab-id')
    // xterm 隐藏 textarea 持有焦点时全局 Ctrl+K 被输入守卫拦截：先点状态栏失焦
    await page.locator('.status-bar').click()
    const modal = await openOverview(page)
    const row = modal.locator(`.iso-row[title="${tabId}"]`)
    await expect(row).toBeVisible({ timeout: 5000 })

    // 查看输出：只读弹层渲染 scrollback 内容（不接管会话）
    await row.hover()
    await row.locator('button[title="查看输出"]').click()
    const outModal = page.locator('.n-modal').filter({ hasText: '查看输出' })
    await expect(outModal.locator('.iso-out-pre')).toContainText('SC-E2E-OUT-MARKER', { timeout: 8000 })
    await outModal.locator('button').filter({ hasText: '×' }).first().click().catch(async () => {
      // n-modal 关闭按钮形态差异兜底：按 Esc
      await page.keyboard.press('Escape')
    })
    await expect(outModal).toHaveCount(0, { timeout: 5000 })

    // 去操作：本机直达——总览关闭 + 底部终端面板可见 + 该 tab 激活
    await row.hover()
    await row.locator('button[title="去操作"]').click()
    await expect(modal).toHaveCount(0, { timeout: 5000 })
    await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('.term-tab').first()).toHaveClass(/is-active/)
    await expect(page.locator('.term-tab-content').first()).toBeVisible()
  })

  test('去操作 agent 会话：直达管理页并选中（agent 分支覆盖）', async ({ page, request }) => {
    // 经 API 建 agent 会话（无项目绑定，宿主是终端会话管理页）
    const headers = await unlockHeaders(request)
    const agentName = `e2e-agent-${Math.random().toString(36).slice(2, 7)}`
    const res = await request.post(`${BASE}/api/terminals`, {
      headers, data: { kind: 'agent', name: agentName },
    })
    const agentId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
    expect(agentId).toBeTruthy()

    // 焦点移出终端（xterm textarea 持焦时全局 Ctrl+K 被输入守卫拦截）
    await page.locator('.status-bar').click()
    const modal = await openOverview(page)
    const row = modal.locator(`.iso-row[title="${agentId}"]`)
    await expect(row).toBeVisible({ timeout: 5000 })

    await row.hover()
    await row.locator('button[title="去操作"]').click()
    await expect(modal).toHaveCount(0, { timeout: 5000 })

    // 意图被 AgentTerminalView watcher 消费：管理页 docked 可见 + 该会话选中
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 8000 })
    await expect(view.locator('.ats-item.active').filter({ hasText: agentName })).toBeVisible({ timeout: 8000 })
  })
})
