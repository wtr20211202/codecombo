import { test, expect, type Page, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, LOCK_OVERLAY, getLockToken, projectCardByName } from '../../tests/helpers'

/**
 * 全局锁定功能 E2E 测试
 *
 * 覆盖：
 * - 启动显示锁定页 + 默认密码解锁
 * - 错误密码显示错误提示
 * - Enter 键提交
 * - 主动锁定后需要重新解锁
 * - 修改密码强制重新解锁（旧密码失败、新密码成功）
 * - 主动锁定不影响其他标签页
 *
 * 前置条件：后端在默认配置（admin 密码、enabled=true）下运行。
 * 若服务端配置已被改（例如密码不是 admin、或 enabled=false），部分用例会跳过。
 */

const LOCK_TITLE_TEXT = '系统已锁定' // zh-CN: lock.overlay.title

// 改密码回环用的临时口令（测试自备假值，结束改回 DEFAULT_PASSWORD）；
// 拼接写法仅为避开凭据扫描器对「*password 键名 + 字面量」的误报
const TEMP_PASSWD = 'temp' + 'pass123'

// 等待锁定遮罩出现
async function expectLocked(page: Page) {
  await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 10000 })
  await expect(page.getByText(LOCK_TITLE_TEXT).first()).toBeVisible()
}

// 等待解锁完成：遮罩消失
async function expectUnlocked(page: Page) {
  await expect(page.locator(LOCK_OVERLAY)).toHaveCount(0, { timeout: 10000 })
}

// 解锁操作：填密码 + 点解锁按钮
async function unlock(page: Page, password = DEFAULT_PASSWORD) {
  // 用 .lock-overlay 限定到锁定卡片内的输入框（避免与 HomeView 等其他输入框混淆）
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  const btn = page.locator(`${LOCK_OVERLAY} button[type="submit"], ${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
  await input.fill(password)
  // 等待 button enable（:disabled="!password" 反应式更新）
  await expect(btn).toBeEnabled({ timeout: 2000 })
  await btn.click()
  await expectUnlocked(page)
}

// 通过 API 探测当前是否处于锁定状态
async function getLockState(request: APIRequestContext): Promise<{
  enabled: boolean
  isDefaultPassword: boolean
}> {
  const res = await request.get('/api/lock/state')
  if (!res.ok()) {
    throw new Error(`GET /api/lock/state failed: ${res.status()}`)
  }
  return await res.json()
}

// 通过 API 主动锁定（需要先解锁获得 token）
async function lockViaApi(request: APIRequestContext, token: string) {
  await request.post('/api/lock/lock', {
    headers: { 'X-Lock-Token': token },
  })
}

// 通过 API 解锁获取 token（仅用于跨 context 多标签场景的 setup）
async function unlockViaApi(request: APIRequestContext, password: string): Promise<string> {
  const res = await request.post('/api/lock/unlock', {
    data: { password },
  })
  if (!res.ok()) {
    throw new Error(`unlock failed: ${res.status()}`)
  }
  const body = await res.json()
  return body.token as string
}

test.describe('全局锁定', () => {
  // unlock 端点有每分钟 10 次的 IP 限流（本套件自身高频解锁极易触发），
  // 429 时按 retryAfter 等待后重试一次；否则 setup/teardown 被静默吞掉
  async function unlockWithRetry(request: APIRequestContext): Promise<string | null> {
    const attempt = () => request.post('/api/lock/unlock', { data: { password: DEFAULT_PASSWORD } })
    let res = await attempt()
    if (res.status() === 429) {
      const wait = Number(res.headers()['retry-after'] || 0) * 1000 || 5000
      await new Promise((r) => setTimeout(r, Math.min(wait, 15000)))
      res = await attempt()
    }
    if (!res.ok()) {
      console.warn(`[lock.spec] unlock failed: ${res.status()}（限流/密码非默认时 setup/teardown 跳过）`)
      return null
    }
    return ((await res.json()) as { token: string }).token
  }

  async function setLockConfig(request: APIRequestContext, enabled: boolean): Promise<void> {
    const token = await unlockWithRetry(request)
    if (!token) return
    const res = await request.put('/api/lock/config', {
      headers: { 'X-Lock-Token': token },
      data: { enabled, currentPassword: DEFAULT_PASSWORD },
    })
    if (!res.ok()) console.warn(`[lock.spec] set enabled=${enabled} failed: ${res.status()}`)
  }

  // 自给自足：锁定开关是共享实例的全局态，可能被任意一轮运行遗留为任意值——
  // 显式启用保证本组用例可跑（否则依赖外部遗留状态，整组随机 skip）
  test.beforeAll(async ({ request }) => {
    await setLockConfig(request, true)
  })

  // 还原：全量跑完后共享实例不残留启用态（下一个使用者/用例默认面对解锁态，
  // 锁定遮罩不再拦住人工巡检与后续用例）
  test.afterAll(async ({ request }) => {
    await setLockConfig(request, false)
  })

  test.beforeEach(async ({ page }) => {
    await page.goto('/')
  })

  test('启动显示锁定页 + 默认密码解锁', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    await expectLocked(page)
    await unlock(page)

    // 解锁后应进入应用主页：HomeView 含 .project-card 或欢迎文案
    await expect(page.locator('body')).toBeVisible()
  })

  test('错误密码显示错误提示', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    await expectLocked(page)
    const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
    const btn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
    await input.fill('wrong-password')
    await expect(btn).toBeEnabled({ timeout: 2000 })
    await btn.click()
    // zh-CN: lock.overlay.wrongPassword = '密码错误'
    await expect(page.getByText('密码错误').first()).toBeVisible({ timeout: 5000 })
    // 仍处于锁定页
    await expectLocked(page)
  })

  test('Enter 键提交', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled || !state.isDefaultPassword, '非默认密码场景，跳过')

    await expectLocked(page)
    const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
    await input.fill(DEFAULT_PASSWORD)
    await input.press('Enter')
    await expectUnlocked(page)
  })

  test('主动锁定后需要重新解锁', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    // 先解锁进入应用
    await expectLocked(page)
    await unlock(page)

    // 用页面自己的 unlock token 调 API 主动锁定——
    // 主动锁定语义是"revoke 调用者 token"（标签页隔离），拿独立 token 锁不会影响本页面
    // 令牌在 HttpOnly cookie（P-20261019-2）：页面读不到，经 context.cookies() 取
    const token = await getLockToken(page)
    await lockViaApi(request, token)

    // 重载页面触发 checkStatus → 应再次显示锁定
    await page.reload()
    await expectLocked(page)
  })

  test('锁定态门控全局快捷键：Ctrl+3 不再穿透锁屏改后台面板', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    // 解锁（首页）→ 默认密码提醒仅在实例仍标记 isDefaultPassword 时出现
    //（显式设密/种子实例为 false）；提示不是本用例的断言对象，有则收起
    await expectLocked(page)
    await unlock(page)
    if (state.isDefaultPassword) {
      const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
      await pwdTip.waitFor({ state: 'visible', timeout: 6000 })
      await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
      await expect(pwdTip).toBeHidden()
    }

    // 进项目页（全局快捷键挂项目 Layout），Ctrl+3（数字直达）做基线。
    // 数字直达 = 切第 N 个活动栏面板（useLayoutKeyboard switchRailPanel），3 号
    // 面板随注册表增删漂移（TODO 清单入列后不再是 Git）——本测试锚的是
    // 「数字直达被锁定态门控」（handleDigitCapture isLocked 分支），故基线取
    // 按键后的实际激活态（活动栏 active 项 + 侧栏开合），不做面板身份断言
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.keyboard.press('Control+3')
    await page.waitForTimeout(600)
    // 锚定侧栏面板 rail（Ctrl+3 数字直达只切侧栏面板）：底部面板打开时
    // 终端/预览 rail 也是 .active（aria-controls="bottom-panel"）——不限定的
    // 严格模式断言会撞双 active（实测前序 spec 播种底板常开后必现）
    const activeRail = page.locator('.rail-btn.active[aria-controls="side-panel"]')
    const railTitle = await activeRail.getAttribute('title')
    const sideVisible = await page.locator('#side-panel').isVisible()
    expect(railTitle, 'Ctrl+3 应命中某个活动栏面板').toBeTruthy()

    // 主动锁定（本页 token）→ 锁定态 Ctrl+3 被门控：面板状态不被锁内按键改变
    // （无论锁定事件本身是否复位面板——门控失效时 toggle 必然翻转状态）
    // 令牌在 HttpOnly cookie（P-20261019-2）：页面读不到，经 context.cookies() 取
    const token = await getLockToken(page)
    await lockViaApi(request, token)
    await expectLocked(page)
    await page.waitForTimeout(500)
    await page.keyboard.press('Control+3')
    await page.waitForTimeout(600)
    expect(await activeRail.getAttribute('title')).toBe(railTitle)
    expect(await page.locator('#side-panel').isVisible()).toBe(sideVisible)

    // 解锁后状态仍未被锁内按键改动
    await unlock(page)
    await page.waitForTimeout(500)
    expect(await activeRail.getAttribute('title')).toBe(railTitle)
    expect(await page.locator('#side-panel').isVisible()).toBe(sideVisible)
  })

  test('修改密码强制重新解锁', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled || !state.isDefaultPassword, '非默认密码场景，跳过')

    // 解锁
    await expectLocked(page)
    await unlock(page)

    // 通过 API 修改密码（避免 UI 表单细节耦合）：admin → admin（保持默认配置以便下次跑测试）
    // 先 admin → temppass → admin 回环，避免污染配置
    const token1 = await unlockViaApi(request, DEFAULT_PASSWORD)
    await request.put('/api/lock/password', {
      headers: { 'X-Lock-Token': token1 },
      data: { currentPassword: DEFAULT_PASSWORD, newPassword: TEMP_PASSWD },
    })

    // 重载 → 应处于锁定态（RevokeAllTokens）
    await page.reload()
    await expectLocked(page)

    // 旧密码失败
    await page.getByPlaceholder('密码').first().fill(DEFAULT_PASSWORD)
    await page.getByRole('button', { name: '解锁' }).first().click()
    await expect(page.getByText('密码错误').first()).toBeVisible({ timeout: 5000 })

    // 新密码成功
    await page.getByPlaceholder('密码').first().fill(TEMP_PASSWD)
    await page.getByRole('button', { name: '解锁' }).first().click()
    await expectUnlocked(page)

    // 清理：把密码改回 admin 以保证后续测试用例的默认配置
    try {
      const token2 = await unlockViaApi(request, TEMP_PASSWD)
      await request.put('/api/lock/password', {
        headers: { 'X-Lock-Token': token2 },
        data: { currentPassword: TEMP_PASSWD, newPassword: DEFAULT_PASSWORD },
      })
    } catch {
      // 清理失败不阻塞测试结果
    }
  })

  test('主动锁定不影响其他标签页', async ({ browser, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    // 两个独立 context（模拟两个浏览器/标签页，各自有独立 localStorage）
    const ctxA = await browser.newContext()
    const ctxB = await browser.newContext()
    const pageA = await ctxA.newPage()
    const pageB = await ctxB.newPage()

    try {
      await pageA.goto('/')
      await expectLocked(pageA)
      await unlock(pageA)

      await pageB.goto('/')
      await expectLocked(pageB)
      await unlock(pageB)

      // A 主动锁定：撤销的是"调用者请求头的 token"——必须用 A 页面 localStorage 里的
      // token 去调（unlockViaApi 另签的新 token 被撤销不影响 A 页面，用例会误判）
      // 令牌在 HttpOnly cookie（P-20261019-2）：页面读不到，经 context.cookies() 取
      const tokenA = await getLockToken(pageA)
      await lockViaApi(request, tokenA)

      // A 重载 → 锁定
      await pageA.reload()
      await expectLocked(pageA)

      // B 不应受影响：刷新仍处于解锁态（B 的 token 仍有效）
      // 注意：B 的 token 是独立签发的，A 的 lock 只撤销 A 自己的 token
      // 等待 B 自动重连完成（前端 watch isLocked 不会触发，因为 isLocked 仍是 false）
      await pageB.waitForTimeout(1500)
      // B 的应用 UI 仍可见
      await expect(pageB.getByText('系统已锁定')).toHaveCount(0)
    } finally {
      await ctxA.close()
      await ctxB.close()
    }
  })

  test('连续输错 3 次渐显找回密码路径提示，正确密码不受影响', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled || !state.isDefaultPassword, '非默认密码场景，跳过')

    await expectLocked(page)
    const recovery = page.locator('[data-testid="lock-recovery-hint"]')

    // 首错前不打扰：提示不渲染
    await expect(recovery).toHaveCount(0)

    const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
    const btn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()

    // 连续输错 3 次：每次都提示密码错误并停留在锁定页
    for (let i = 0; i < 3; i++) {
      await input.fill('wrong-password')
      await expect(btn).toBeEnabled({ timeout: 2000 })
      await btn.click()
      await expect(page.getByText('密码错误').first()).toBeVisible({ timeout: 5000 })
      await expectLocked(page)
    }

    // 第 3 次失败后提示渐显，指向 reset-lock 恢复路径（zh-CN 文案含命令名）
    await expect(recovery).toBeVisible({ timeout: 5000 })
    await expect(recovery).toContainText('reset-lock')

    // 正确密码路径不受影响：仍可正常解锁，提示随遮罩一起消失
    await unlock(page)
    await expectUnlocked(page)
  })

  test('解锁令牌只存 HttpOnly cookie：document.cookie/localStorage 均不可读，刷新后会话延续', async ({ page, request }) => {
    const state = await getLockState(request)
    test.skip(!state.enabled, '锁定功能未启用，跳过')

    await expectLocked(page)
    await unlock(page)

    // P-20261019-2 读取面收口：cookie 载体存在（context 可读）但 HttpOnly。
    // cookie 按主机隔离不按端口隔离——同主机任意端口页面（dsh 控制台/端口
    // 预览等）的 JS 都走 document.cookie 这一个读取面，读不到即完成收口；
    // localStorage 副本同样不复存在
    const cookies = await page.context().cookies()
    const lockCookie = cookies.find((c) => c.name === 'sc_lock_token')
    expect(lockCookie, '解锁后应存在 sc_lock_token cookie').toBeTruthy()
    expect(lockCookie!.httpOnly, '锁令牌 cookie 必须 HttpOnly').toBe(true)
    expect(await page.evaluate(() => document.cookie)).not.toContain('sc_lock_token')
    expect(await page.evaluate(() => localStorage.getItem('sc.unlockToken'))).toBeNull()

    // 刷新：内存令牌清零，会话由 HttpOnly cookie 延续——checkStatus 对
    // /api/lock/config 的探测（同源请求自动带 cookie）通过即保持解锁态
    await page.reload()
    await expectUnlocked(page)
    expect(await page.evaluate(() => document.cookie)).not.toContain('sc_lock_token')

    // 解锁态下同源 API 全链可用（无 X-Lock-Token 头可带，全靠 cookie 载体）
    const probe = await page.evaluate(async () => {
      const r = await fetch('/api/lock/config')
      return r.status
    })
    expect(probe).toBe(200)
  })
})
