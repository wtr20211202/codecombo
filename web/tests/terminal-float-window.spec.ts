import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 终端 tab 拖出浮动窗 E2E（CSS morph 方案）：
 *
 * 覆盖点：
 *   1. tab 拖出（HTML5 DnD：dragstart + 条外 dragend）→ .term-tab-content 浮动
 *      （is-floating class），标题栏显示 tab 名，xterm 仍在浮动容器内
 *   2. 浮动 tab 在 tab 条上有 ⧉ 指示
 *   3. 标题栏 pointer 拖拽移动窗口（left/top 变化）
 *   4. 收回面板按钮 → 回 docked，tab 保留，xterm 存活
 *   5. 右键菜单「拖出为浮动窗 / 收回面板」双向切换
 *
 * 拖出判定在 dragend：dropEffect 'none' 且落点在 tab 条外（headless 下
 * 原生鼠标拖拽不触发 dnd，统一用 DataTransfer dispatch）。
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

/** 派发 tab 拖出：dragstart 在 tab 上，dragend 落在 tab 条外指定坐标 */
async function dragTabOut(page: Page, tab: ReturnType<Page['locator']>, toX: number, toY: number) {
  const el = await tab.elementHandle()
  await page.evaluate(([t, x, y]) => {
    const te = t as HTMLElement
    const dt = new DataTransfer() // 默认 dropEffect 'none' = 未落在合法目标
    te.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    te.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, clientX: x, clientY: y }))
  }, [el, toX, toY])
}

/** 标题栏 pointer 拖拽窗口：down → move ×N → up（window 级监听消费 move） */
async function dragFloatBar(page: Page, bar: ReturnType<Page['locator']>, dx: number, dy: number) {
  const box = await bar.boundingBox()
  if (!box) throw new Error('float bar not visible')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  // 分步移动：window pointermove 监听逐步消费，模拟真实手势
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(startX + (dx * i) / 5, startY + (dy * i) / 5)
  }
  await page.mouse.up()
}
/** 标题条 auto-hide（P-04-91）：默认收起（max-height:0 零占位），hover 顶区
 *  4px 状态条显现——旧「拖出即标题条可见」断言须经此显现动作后再作
 *  （terminal-float-titlebar.spec 同款 revealBar） */
async function revealBar(page: Page, floatContent: ReturnType<Page['locator']>) {
  const status = floatContent.locator('.term-float-status')
  await expect(status).toBeVisible()
  await status.hover()
  await expect(floatContent.locator('.term-float-bar')).toBeVisible()
}

test.describe('终端 tab 拖出浮动窗', () => {
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

    // 新建一个终端 tab
    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })
    // xterm 断言取 last（CLAUDE.md「测试」节）：多 tab 时旧屏 DOM 序在前，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content .xterm').last()).toBeVisible({ timeout: 10000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupProjectTerminals(request, projectId)
  })

  test('拖出 tab → 浮动窗（标题栏/xterm/指示），收回面板恢复 docked', async ({ page }) => {
    const tab = page.locator('.term-tab').first()
    const floatContent = page.locator('.term-tab-content.is-floating')

    // 初始 docked：无浮动容器
    await expect(floatContent).toHaveCount(0, { timeout: 10000 })

    // 1. 拖出（落点到 tab 条外：视口中上部）
    await dragTabOut(page, tab, 900, 300)
    await expect(floatContent).toHaveCount(1, { timeout: 10000 })
    await revealBar(page, floatContent)
    await expect(floatContent.locator('.term-float-bar')).toBeVisible()
    // 标题栏显示 tab 名；xterm 仍在浮动容器内（DOM 零迁移）。
    // 命名跟随 playwright 钉定的 zh-CN（服务端按 Accept-Language 命名会话）
    await expect(floatContent.locator('.term-float-title')).toHaveText(/终端/)
    await expect(floatContent.locator('.xterm')).toBeVisible()
    // 浮动几何内联样式生效（fixed 几何以 left/top 内联注入）
    const style = await floatContent.getAttribute('style')
    expect(style).toContain('left:')
    // 2. tab 条上的浮动指示
    await expect(tab.locator('.term-tab-float-ico')).toBeVisible()

    // 3. 标题栏拖拽移动窗口（向左上拖：右下方向会撞视口夹紧边界）
    const before = await floatContent.boundingBox()
    await revealBar(page, floatContent)
    await floatContent.locator('.term-float-bar').hover()
    await dragFloatBar(page, floatContent.locator('.term-float-bar'), -120, -80)
    const after = await floatContent.boundingBox()
    expect(Math.abs((after?.x ?? 0) - (before?.x ?? 0) + 120)).toBeLessThan(40)
    expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0) + 80)).toBeLessThan(40)

    // 4. 收回面板：浮动消失，tab 保留，docked xterm 存活（按钮在标题条内，先显现）
    await revealBar(page, floatContent)
    await floatContent.locator('.term-float-btn').click()
    await expect(floatContent).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 10000 })
    // xterm 断言取 last（CLAUDE.md「测试」节）：docked 屏可能不止一个 tab-content，last 才是当前活跃屏
    await expect(page.locator('.term-tab-content:not(.is-floating) .xterm').last()).toBeVisible()
  })

  test('右键菜单「拖出为浮动窗 / 收回面板」双向切换', async ({ page }) => {
    const tab = page.locator('.term-tab').first()
    const floatContent = page.locator('.term-tab-content.is-floating')

    // 拖出为浮动窗
    await tab.click({ button: 'right' })
    await page.locator('.term-tab-context-menu').getByText('拖出为浮动窗').click()
    await expect(floatContent).toHaveCount(1, { timeout: 10000 })

    // 浮窗默认位置会盖住底部 tab 条：先拖到右上方让开，tab 才可点
    // （标题条收起态无 boundingBox——先 revealBar 再移交 hover 拖拽）
    await revealBar(page, floatContent)
    await floatContent.locator('.term-float-bar').hover()
    await dragFloatBar(page, floatContent.locator('.term-float-bar'), 280, -70)

    // 菜单文案随状态切换为「收回面板」
    await tab.click({ button: 'right' })
    await page.locator('.term-tab-context-menu').getByText('收回面板').click()
    await expect(floatContent).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 10000 })
  })

  test('拖回 tab 条上松手 = 取消（不浮动）', async ({ page }) => {
    const tab = page.locator('.term-tab').first()
    const el = await tab.elementHandle()
    // dragend 落点取 tab 条中心（条内）→ outsideStrip=false → 不浮动
    const stripBox = await page.locator('.term-tablist').boundingBox()
    const cx = (stripBox?.x ?? 0) + (stripBox?.width ?? 0) / 2
    const cy = (stripBox?.y ?? 0) + (stripBox?.height ?? 0) / 2
    await page.evaluate(([t, x, y]) => {
      const te = t as HTMLElement
      const dt = new DataTransfer()
      te.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      te.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, clientX: x, clientY: y }))
    }, [el, cx, cy])
    await page.waitForTimeout(300)
    await expect(page.locator('.term-tab-content.is-floating')).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 10000 })
  })

  test('tab 条内拖到另一 tab 上 = 重排序（非浮动）', async ({ page }) => {
    // 建第二个 tab
    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(2, { timeout: 8000 })

    // 拖 tab1（右）drop 到 tab0（左）上 = 插到其前 → [T2, T1]
    const src = await page.locator('.term-tab').nth(1).elementHandle()
    const dst = await page.locator('.term-tab').nth(0).elementHandle()
    await page.evaluate(([s, d]) => {
      const dt = new DataTransfer()
      s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
      d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
      d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
      s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
    }, [src, dst])

    await expect(page.locator('.term-tab .term-tab-name').nth(0)).toHaveText('终端 2')
    // 重排序不触发浮动
    await expect(page.locator('.term-tab-content.is-floating')).toHaveCount(0, { timeout: 10000 })
  })

  test('浮动几何持久化：重开沿用上次尺寸', async ({ page }) => {
    // 预置持久化几何（模拟上次浮动留下的尺寸）
    await page.evaluate(() => localStorage.setItem(
      'sc.terminalFloat.geometry',
      JSON.stringify({ x: 120, y: 120, w: 500, h: 320 }),
    ))
    const tab = page.locator('.term-tab').first()
    await dragTabOut(page, tab, 700, 260)
    const floatContent = page.locator('.term-tab-content.is-floating')
    await expect(floatContent).toHaveCount(1)
    const box = await floatContent.boundingBox()
    // 尺寸沿用持久化值；位置仍由拖出锚点决定（只断言尺寸）
    expect(Math.round(box?.width ?? 0)).toBe(500)
    expect(Math.round(box?.height ?? 0)).toBe(320)
  })

  test('浮动几何持久化：无锚点浮动恢复上次位置（右键菜单路径）', async ({ page }) => {
    await page.evaluate(() => localStorage.setItem(
      'sc.terminalFloat.geometry',
      JSON.stringify({ x: 180, y: 140, w: 520, h: 340 }),
    ))
    const tab = page.locator('.term-tab').first()
    await tab.click({ button: 'right' })
    await page.locator('.term-tab-context-menu').getByText('拖出为浮动窗').click()
    const floatContent = page.locator('.term-tab-content.is-floating')
    await expect(floatContent).toHaveCount(1)
    // 无锚点（菜单触发）：位置与尺寸整体沿用持久化值
    const box = await floatContent.boundingBox()
    expect(Math.round(box?.x ?? 0)).toBe(180)
    expect(Math.round(box?.y ?? 0)).toBe(140)
    expect(Math.round(box?.width ?? 0)).toBe(520)
    expect(Math.round(box?.height ?? 0)).toBe(340)
  })
})
