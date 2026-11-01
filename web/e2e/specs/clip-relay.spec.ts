import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 跨设备剪贴板中继 E2E（P-20261002-32）：
 *   1. API 三态：POST → GET 取到内容 → 二次 GET 404（读取即焚）；超限 413；
 *      空内容 400；空槽 404
 *   2. 双端链路：A 设备命令面板「发送剪贴板到其他设备」（readText 取本机剪贴板）
 *      → 服务端广播 clipboard.arrived → B 设备弹 toast 且 A 自身不弹（origin
 *      回声过滤）→ B 点击 toast → B 本地剪贴板 = 内容 + 槽即焚（二次 GET 404）
 *   3. 终端右键入口（P-20261008-3，缩范围二阶段兑现）：pane 右键菜单「发送剪贴板
 *      到其他设备」项 → 同一双端链路（与命令面板同一条 sendLocalClipboard 链）；
 *      超 32KB 剪贴板 → 前置拦截 toast、槽不被污染
 * 双 context = 两个「设备」；剪贴板读写需 chromium 显式授权（clipboard-read /
 * clipboard-write）+ secure context（e2e 实例 localhost 天然满足）。
 * 通知类共享状态无（内存槽即焚），各用例开头 drain 一次即隔离
 */

const CONTENT = `relay-secret-${Date.now()}`

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function rawClip(headers: Record<string, string>, method: 'GET' | 'POST', body?: unknown) {
  const res = await fetch(`${API_BASE}/api/clip`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: (await res.json().catch(() => null)) as { error?: string; content?: string } | null }
}

/** 清槽（用例间隔离：单槽是服务端全局状态） */
async function drainClip(headers: Record<string, string>): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if ((await rawClip(headers, 'GET')).status === 404) return
  }
}

// 进项目页（命令面板挂在项目页 Layout；路上留出 ops-channel WS 建立窗口）
async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

// 终端 pane 就位（右键菜单宿主，terminal-context-menu-keyboard 同款归一路径）：
// 终端面板可能未开（rail 点开）、项目可能无 tab（新建兜底）；pane 取 ：visible last
// （多 tab 常驻挂载 v-show 互斥可见，first() 会命中隐藏屏——「测试」节纪律）
async function openProjectTerminal(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 5000 })
  if ((await page.locator('.term-tab').count()) === 0) {
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 15_000 })
  }
  await expect(page.locator('.term-pane:visible').last()).toBeVisible({ timeout: 10_000 })
}

// 第二「设备」：独立 context（独立 localStorage → 独立设备 id）+ 剪贴板授权
async function openSecondDevice(browser: import('@playwright/test').Browser): Promise<{ context: import('@playwright/test').BrowserContext; page: Page }> {
  const context = await browser.newContext({ locale: 'zh-CN' })
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  const page = await context.newPage()
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  return { context, page }
}

test.beforeAll(async () => {
  await drainClip(await unlockHeaders())
})

test.afterAll(async () => {
  await drainClip(await unlockHeaders())
})

test('API 三态：写入/读取即焚/超限/空载荷', async () => {
  const headers = await unlockHeaders()
  await drainClip(headers)

  // 写入成功：只回 ok/size，不回显内容
  const post = await rawClip(headers, 'POST', { content: CONTENT, origin: 'e2e-origin' })
  expect(post.status).toBe(200)
  expect(post.json && 'content' in post.json).toBeFalsy()

  // 首次 GET 取到内容
  const got = await rawClip(headers, 'GET')
  expect(got.status).toBe(200)
  expect(got.json?.content).toBe(CONTENT)

  // 读取即焚：二次 GET 404
  expect((await rawClip(headers, 'GET')).status).toBe(404)

  // 超限 413（32KB + 1 字节）
  const over = await rawClip(headers, 'POST', { content: 'a'.repeat(32 * 1024 + 1) })
  expect(over.status).toBe(413)

  // 空内容 400，且不污染槽
  expect((await rawClip(headers, 'POST', { content: '' })).status).toBe(400)
  expect((await rawClip(headers, 'GET')).status).toBe(404)
})

test('双端链路：A 面板发送 → B toast 取走；A 自身不弹到达 toast', async ({ page }) => {
  test.setTimeout(90000)
  const headers = await unlockHeaders()
  await drainClip(headers)

  await enterProject(page)
  // A 侧剪贴板授权（readText 取料 / writeText 预置都要；B 侧在 openSecondDevice 授）
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  const contextB = page.context().browser()
  const deviceB = await openSecondDevice(contextB)
  try {
    // 预置 A 的本机剪贴板（secure context + 授权；发送侧 readText 取料源）。
    // 剪贴板 API 有 document focus 要求，双 context 下先归焦点
    await page.bringToFront()
    await page.evaluate((t) => navigator.clipboard.writeText(t), CONTENT)

    // A：命令面板 → 「发送剪贴板到其他设备」
    await page.keyboard.press('Control+k')
    const input = page.locator('.palette-input input')
    await expect(input).toBeVisible({ timeout: 5000 })
    await input.fill('>发送剪贴板')
    const item = page.locator('.palette-item').filter({ hasText: '发送剪贴板' }).first()
    await expect(item).toBeVisible({ timeout: 5000 })
    await item.click()

    // A 得到发送成功反馈（操作有反馈）
    await expect(page.locator('.n-message').filter({ hasText: '已发送' })).toBeVisible({ timeout: 5000 })

    // B 收到到达 toast（广播已送达 = A 的回声过滤判定窗口已过，下面的负断言才成立）
    const toast = deviceB.page.locator('[data-testid="clip-arrive-toast"]')
    await expect(toast).toBeVisible({ timeout: 10000 })

    // A 自身不弹到达 toast（origin 回声过滤；B 已见 toast 排除「还没到」假阴性）
    await expect(page.locator('[data-testid="clip-arrive-toast"]')).toHaveCount(0)

    // B 点击取走：读取即焚 + copyText 落本地剪贴板（writeText 同样要求文档焦点）
    await deviceB.page.bringToFront()
    await toast.click()
    await expect(deviceB.page.locator('.n-message').filter({ hasText: '已复制到本机剪贴板' })).toBeVisible({ timeout: 5000 })
    const clipped = await deviceB.page.evaluate(() => navigator.clipboard.readText())
    expect(clipped).toBe(CONTENT)

    // 槽已空：后续任何设备点击/GET 都是「已被取走或已过期」
    expect((await rawClip(headers, 'GET')).status).toBe(404)
  } finally {
    await deviceB.context.close()
  }
})

// 终端右键入口（P-20261008-3）：与面板入口同一条 sendLocalClipboard 链，
// 只是入口从命令面板换成 pane 右键菜单——链路断言从简（双端取走细节见上例），
// 重点守「菜单项出现 → 点击即发送成功」的人机动线本身
test('终端右键「发送剪贴板到其他设备」：菜单项出现 → 点击发送 → B 取走', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders()
  await drainClip(headers)

  await enterProject(page)
  // 清场基线：只清理本用例新建的终端会话（存量 tab 不碰，keyboard spec 同纪律）
  const list0 = await page.request.get(`${API_BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))
  await openProjectTerminal(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  const contextB = page.context().browser()
  const deviceB = await openSecondDevice(contextB)
  try {
    // 预置 A 的本机剪贴板（发送侧 readText 取料源；API 有文档焦点要求先归焦点）
    await page.bringToFront()
    const termContent = `term-relay-${Date.now()}`
    await page.evaluate((t) => navigator.clipboard.writeText(t), termContent)

    // 右键 pane → 菜单出现且含「发送剪贴板到其他设备」项
    await page.locator('.term-pane:visible').last().click({ button: 'right', position: { x: 60, y: 40 } })
    const menuItem = page.locator('.term-context-menu [data-testid="term-send-clip"]')
    await expect(menuItem).toBeVisible({ timeout: 5000 })

    // 点击 → 发送成功反馈（读取 → POST /api/clip 现成链；菜单随手势关闭）
    await menuItem.click()
    await expect(menuItem).toHaveCount(0)
    await expect(page.locator('.n-message').filter({ hasText: '已发送' })).toBeVisible({ timeout: 5000 })

    // B 收到到达 toast 并取走：读取即焚 + 落 B 本地剪贴板
    const toast = deviceB.page.locator('[data-testid="clip-arrive-toast"]')
    await expect(toast).toBeVisible({ timeout: 10000 })
    await deviceB.page.bringToFront()
    await toast.click()
    await expect(deviceB.page.locator('.n-message').filter({ hasText: '已复制到本机剪贴板' })).toBeVisible({ timeout: 5000 })
    const clipped = await deviceB.page.evaluate(() => navigator.clipboard.readText())
    expect(clipped).toBe(termContent)
  } finally {
    await deviceB.context.close()
    const list1 = await page.request.get(`${API_BASE}/api/terminals`, { headers })
    for (const s of ((await list1.json()) as { data?: { id: string }[] }).data || []) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

// 32KB 前置拦截（镜像服务端上限的就地提示）：超限剪贴板点发送 → warning toast、
// 不发注定被拒的请求——槽保持为空（GET 404）即证请求未出
test('终端右键发送超 32KB：前置拦截 toast，槽不被污染', async ({ page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders()
  await drainClip(headers)

  await enterProject(page)
  // 清场基线：只清理本用例新建的终端会话（存量 tab 不碰，上一用例同纪律）
  const list0 = await page.request.get(`${API_BASE}/api/terminals`, { headers })
  const beforeIds = new Set((((await list0.json()) as { data?: { id: string }[] }).data || []).map(s => s.id))
  await openProjectTerminal(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: API_BASE })
  try {
    await page.bringToFront()
    await page.evaluate(() => navigator.clipboard.writeText('a'.repeat(32 * 1024 + 1)))

    await page.locator('.term-pane:visible').last().click({ button: 'right', position: { x: 60, y: 40 } })
    const menuItem = page.locator('.term-context-menu [data-testid="term-send-clip"]')
    await expect(menuItem).toBeVisible({ timeout: 5000 })
    await menuItem.click()

    await expect(page.locator('.n-message').filter({ hasText: '32KB' })).toBeVisible({ timeout: 5000 })
    expect((await rawClip(headers, 'GET')).status).toBe(404)
  } finally {
    await drainClip(headers)
    const list1 = await page.request.get(`${API_BASE}/api/terminals`, { headers })
    for (const s of ((await list1.json()) as { data?: { id: string }[] }).data || []) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})
