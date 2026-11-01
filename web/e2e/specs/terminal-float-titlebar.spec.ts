import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 浮动终端窗轻标题条（P-20261004-91）：识别 / 状态 / 收回三合一 affordance。
 *   - ①auto-hide 标题条：默认收起（不占终端可视区），hover 顶区 4px 状态条
 *     显现——含会话名 + task.progress 状态点 + 收回面板按钮；移开即收起
 *   - ②常驻 4px 语义色状态条：idle/running/done/failed 四档类名随 bySession
 *     状态翻转（真实链路：ops-notify → ops-channel 广播 → assistantTask）
 *   - ③多浮动窗活动窗高亮：z 序顶层唯一 .is-top，点击他窗即跟随
 *   - 收回面板：标题条按钮 → pane 归位、tab 正常保留
 *
 * 前置态自管（esc-layered-dismiss 同款）：uiState 面板归零 + 终端会话逐用例
 * 清理防残留进程/tab 干扰。
 */

function unlockHeaders(): Promise<Record<string, string>> {
  return fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  }).then(async (res) => {
    const token = ((await res.json()) as { token?: string }).token || ''
    return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  })
}

async function resetUiState(): Promise<void> {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
}

async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

/** 清空 simple-coding 项目的终端会话（服务端全局共享，防残留 tab/进程干扰） */
async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** 把底栏归位到终端 tab 可见（.term-toolbar 出现即终端 tab 激活） */
async function ensureBottomTerminalOpen(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.keyboard.press('Control+`')
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.term-toolbar').isVisible()).toBe(true)
}

/** 归一到单一新终端 tab（esc-layered-dismiss 同款清理/新建配方） */
async function normalizeSingleTab(page: Page) {
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) break
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
  await page.locator('.term-toolbar button[title="新建终端"]').click()
  await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
}

/** 右键菜单「拖出为浮动窗」→ 浮动窗出现（expected = 浮动窗总数） */
async function floatOutTab(page: Page, tab: ReturnType<Page['locator']>, expected: number) {
  await tab.click({ button: 'right' })
  await page.locator('.term-tab-context-menu').getByText('拖出为浮动窗').click()
  await expect(page.locator('.term-tab-content.is-floating')).toHaveCount(expected, { timeout: 10000 })
}

/** 真实链路上报 task.progress（agent-chain 同款：ops-notify → 广播 → bySession） */
async function reportProgress(headers: Record<string, string>, terminalId: string, status: string) {
  const res = await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e 浮窗状态', status, step: '', terminalId } }),
  })
  expect(res.ok).toBeTruthy()
}

/** hover 顶区 4px 状态条让标题条显现（auto-hide 显现动作本身即被断言） */
async function revealBar(page: Page, floatContent: ReturnType<Page['locator']>) {
  const status = floatContent.locator('.term-float-status')
  await expect(status).toBeVisible()
  await status.hover()
  await expect(floatContent.locator('.term-float-bar')).toBeVisible()
}

/** 标题条拖拽把浮动窗停到目标几何（x/y = 窗口左上角期望值，视口夹紧兜底）。
 *  指针此刻在标题条中心，startBarDrag 按 pointermove 增量移动窗口——
 *  指针目标位 = 目标锚点 + 同一偏移（宽半 / 条内 19px）。 */
async function dragFloatTo(page: Page, floatContent: ReturnType<Page['locator']>, x: number, y: number) {
  const box = await floatContent.boundingBox()
  expect(box).toBeTruthy()
  await revealBar(page, floatContent)
  await floatContent.locator('.term-float-bar').hover()
  await page.mouse.down()
  await page.mouse.move(x + box!.width / 2, y + 19, { steps: 8 })
  await page.mouse.up()
  await expect(floatContent.boundingBox()).resolves.toMatchObject({ width: box!.width })
}

test.describe('浮动终端窗轻标题条', () => {
  let projectId: string

  test.beforeAll(async ({ request }) => {
    await resetUiState()
    projectId = await getSimpleCodingProjectId(request)
  })
  test.afterAll(async () => {
    await resetUiState()
  })
  test.afterEach(async ({ request }) => {
    // 会话清理兜底：浮动状态随 tab 关闭对账清空（useTerminalFloat watch）
    try {
      await cleanupProjectTerminals(request, projectId)
    } catch { /* 清理失败不影响用例结论 */ }
  })

  test('hover 顶区显现标题条：会话名 + 状态点随 task.progress 翻档，移开即收起', async ({ page, request }) => {
    await cleanupProjectTerminals(request, projectId)
    await openProjectPage(page)
    await ensureBottomTerminalOpen(page)
    await normalizeSingleTab(page)

    await floatOutTab(page, page.locator('.term-tab').first(), 1)
    const floatContent = page.locator('.term-tab-content.is-floating')

    // 常驻 4px 状态条可见；标题条默认收起（不占终端可视区）
    const status = floatContent.locator('.term-float-status')
    await expect(status).toBeVisible()
    await expect(status).toHaveClass(/is-idle/)
    await expect(floatContent.locator('.term-float-bar')).toBeHidden()

    // hover 顶区 → 标题条显现：会话名与 tab 名一致，状态点同档 idle
    await revealBar(page, floatContent)
    const tabName = await page.locator('.term-tab .term-tab-name').first().textContent()
    await expect(floatContent.locator('.term-float-title')).toHaveText(tabName ?? '')
    await expect(floatContent.locator('.term-float-dot')).toHaveClass(/is-idle/)

    // task.progress running（真实链路）→ 状态条/点翻 running 档，tooltip 随档
    const headers = await unlockHeaders()
    const tabId = await floatContent.getAttribute('data-tab-id')
    expect(tabId, '浮动窗容器携带会话 id').toBeTruthy()
    await reportProgress(headers, tabId!, 'running')
    await expect(status).toHaveClass(/is-running/, { timeout: 8000 })
    await expect(floatContent.locator('.term-float-dot')).toHaveClass(/is-running/)
    await expect(floatContent.locator('.term-float-dot')).toHaveAttribute('aria-label', '任务运行中')

    // 终态 done → 完成即变绿档
    await reportProgress(headers, tabId!, 'done')
    await expect(status).toHaveClass(/is-done/, { timeout: 8000 })
    await expect(floatContent.locator('.term-float-dot')).toHaveClass(/is-done/)

    // 指针移开 → 标题条重新收起（auto-hide 归位）
    await page.mouse.move(5, 5)
    await expect(floatContent.locator('.term-float-bar')).toBeHidden()
  })

  test('点收回面板：pane 归位、tab 正常保留', async ({ page, request }) => {
    await cleanupProjectTerminals(request, projectId)
    await openProjectPage(page)
    await ensureBottomTerminalOpen(page)
    await normalizeSingleTab(page)

    await floatOutTab(page, page.locator('.term-tab').first(), 1)
    const floatContent = page.locator('.term-tab-content.is-floating')

    await revealBar(page, floatContent)
    await floatContent.locator('.term-float-btn').click()

    // pane 归位：浮动容器消失；tab 不受影响（仍 1 个、无浮动指示）
    await expect(page.locator('.term-tab-content.is-floating')).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.term-tab')).toHaveCount(1)
    await expect(page.locator('.term-tab-float-ico')).toHaveCount(0)
    // 收回后 terminal tab 仍在激活位（.term-toolbar 可见即终端 tab 激活）
    await expect(page.locator('.term-toolbar')).toBeVisible()
  })

  test('多浮动窗：z 序顶层唯一 is-top，点击他窗即跟随', async ({ page, request }) => {
    await cleanupProjectTerminals(request, projectId)
    await openProjectPage(page)
    await ensureBottomTerminalOpen(page)
    await normalizeSingleTab(page)

    // 第二个 tab；先浮 tab2 并停到 (450,200)。默认锚点 (300,90) 的 760 宽窗
    // 全盖住底栏 tab 条（tab 在 y≈468），后续右键点击会被浮窗 xterm 拦截——
    // 停靠右中后左侧 tab1 的右键路径露出
    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(2, { timeout: 8000 })
    await floatOutTab(page, page.locator('.term-tab').last(), 1)
    await dragFloatTo(page, page.locator('.term-tab-content.is-floating'), 450, 200)

    // 再浮 tab1（拖拽几何已持久化 → 与 float2 同锚点 spawn、z 序置顶持 is-top）
    await floatOutTab(page, page.locator('.term-tab').first(), 2)
    const topFloat = page.locator('.term-tab-content.is-floating.is-top')
    await expect(topFloat).toHaveCount(1)
    const topId = await topFloat.getAttribute('data-tab-id')

    // 顶层窗（float1）拖到左上角，露出 float2 右段（float2 占 450..1210，
    // float1 占 8..768 → x>768 段裸露）
    await dragFloatTo(page, topFloat, 8, 100)

    // 点击 float2 裸露区（pointerdown 置前）→ is-top 跟随且仍唯一
    await page.mouse.click(990, 400)
    await expect(page.locator('.term-tab-content.is-floating.is-top')).toHaveCount(1)
    const newTopId = await page.locator('.term-tab-content.is-floating.is-top').getAttribute('data-tab-id')
    expect(newTopId).toBeTruthy()
    expect(newTopId).not.toBe(topId)
  })
})
