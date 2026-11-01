import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import http from 'http'
import net from 'net'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, projectCardByName } from './helpers'

/**
 * dsh 控制台 E2E（P6）：主区 iframe 视图 + 回环反代通道。
 *
 * 本 spec 在 Playwright Node 进程内起一个「假 dsh」HTTP 服务（默认上游端口
 * 3080），返回带 marker 的 HTML 并显式设置 X-Frame-Options: DENY——用于端到
 * 端验证反代通道的结构性保证：
 *   1. 剥除帧限制头后 iframe 可正常加载（dsh 禁帧也拦不住）
 *   2. token 注入：回环浏览器 URL 保持干净（token 经反代 302 签发门下发，
 *      不泄漏到 URL/历史记录；fbab1bc 契约），配置 token 后内容仍可达
 * 以及主区视图的开关/保活/新标签语义。
 *
 * 8a44349 起：令牌未配置态不渲染 iframe（主题化引导卡居中替代）——
 * iframe 类用例统一在 beforeAll 配置 token；「token 注入」用例另行覆盖
 * 配置/清理生命周期。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const MARKER = 'sc-fake-dsh-ok'
let fakeServer: http.Server | null = null
let fakePort = 0

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function startFakeDsh() {
  return new Promise<void>((resolve) => {
    fakeServer = http.createServer((req, res) => {
      // 显式禁止被 iframe 嵌入：反代必须剥掉这个头，iframe 才能加载
      res.setHeader('X-Frame-Options', 'DENY')
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(`<!doctype html><html><body><h1 id="${MARKER}">${MARKER}</h1></body></html>`)
    })
    // 随机空闲端口：与真实 dsh（3080，若 WSL 中运行）完全解耦
    fakeServer.listen(0, '127.0.0.1', () => {
      fakePort = (fakeServer!.address() as net.AddressInfo).port
      resolve()
    })
  })
}

async function openDshConsole(page: Page) {
  await page.locator('.rail-btn[title="dsh 控制台"]').click()
  const view = page.locator('.dsh-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

test.describe('dsh 控制台（P6）', () => {
  test.beforeAll(async ({ request }) => {
    await startFakeDsh()
    // 上游指向假服务（随机端口）：与真实 dsh（3080，若 WSL 中运行）完全解耦。
    // token 统一配置：8a44349 起未配置态渲染引导卡而非 iframe，iframe 类
    // 用例（剥头/快捷键）都需要 token 才走 iframe 分支
    const headers = await unlockHeaders(request)
    await request.put(`${BASE}/api/settings`, {
      headers,
      data: { dshWebBase: `http://127.0.0.1:${fakePort}`, dshWebToken: 'e2e-token' },
    })
  })

  test.afterEach(async ({ page, request }) => {
    await closeDshConsoleAndClearState(page, request, BASE)
  })

  test.afterAll(async ({ request }) => {
    const headers = await unlockHeaders(request)
    // 恢复默认上游与 token
    await request.put(`${BASE}/api/settings`, {
      headers,
      data: { dshWebBase: 'http://127.0.0.1:3080', dshWebToken: '' },
    })
    if (fakeServer) {
      // 主服务反代与假上游之间有 keep-alive 长连：server.close() 会等它空闲
      // （Go 默认 IdleConnTimeout 90s），afterAll 30s 预算必超——先掐断全部
      // 连接再关，close 立即返回
      fakeServer.closeAllConnections()
      await new Promise<void>(resolve => fakeServer!.close(() => resolve()))
      fakeServer = null
    }
  })

  test('反代通道：剥帧限制头后 iframe 加载假 dsh 页面', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    const view = await openDshConsole(page)
    // iframe 可见且经反代加载了假 dsh 页面内容（跨域 frame 的 DOM 可断言 =
    // 反代已剥掉 X-Frame-Options: DENY，结构性验证通过）
    const frame = page.frameLocator('.dsh-frame')
    await expect(frame.locator(`#${MARKER}`)).toBeVisible({ timeout: 15000 })
    // 工具条状态点为可用（绿色 ok）
    await expect(view.locator('.dsh-status.ok')).toBeVisible()

    // 关闭 → 视图隐藏（v-show 保活，组件不卸载）
    await view.locator('.dsh-actions button').last().click()
    await expect(view).toBeHidden()
    // 再开 → 内容原地保留（iframe 未重载：marker 仍在即可）
    await page.locator('.rail-btn[title="dsh 控制台"]').click()
    await expect(view).toBeVisible()
    await expect(frame.locator(`#${MARKER}`)).toBeVisible()
  })

  test('token 注入（302 签发门）：配置后回环 URL 保持干净且内容可达', async ({ page, request }) => {
    const headers = await unlockHeaders(request)
    await request.put(`${BASE}/api/settings`, { headers, data: { dshWebToken: 'e2e-secret' } })

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    const view = await openDshConsole(page)
    // 回环浏览器契约（fbab1bc 起）：iframe URL 不携带 token——token 由反代的
    // 302 签发门自动下发（无 cookie 首访 302 携 token），不泄漏进 URL/历史
    const src = await view.locator('.dsh-frame').getAttribute('src', { timeout: 15000 })
    expect(src).not.toContain('token=')
    // 假上游 marker 可见 = 302 签发门用配置 token 完成了鉴权闭环
    const frame = page.frameLocator('.dsh-frame')
    await expect(frame.locator(`#${MARKER}`)).toBeVisible({ timeout: 15000 })

    // 清理 token：恢复套件默认（8a44349 起无 token 不渲染 iframe，
    // 后续 iframe 用例依赖默认 token 就位）
    await request.put(`${BASE}/api/settings`, { headers, data: { dshWebToken: 'e2e-token' } })
  })

  test('键盘快捷键（打磨轮4）：Ctrl+R/F5 刷新 iframe、Esc 关闭', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    const view = await openDshConsole(page)
    const frameLoc = page.locator('.dsh-frame')
    await expect(frameLoc).toBeVisible({ timeout: 15000 })
    // 刷新提示带快捷键文案
    await expect(view.locator('.dsh-actions button[title*="Ctrl+R"]')).toHaveCount(1)

    // Ctrl+R：iframe 重建（iframeKey++ → 新元素 ≠ 旧元素），反代页面仍可达
    const before = await frameLoc.elementHandle()
    await page.keyboard.press('Control+r')
    // 与兄弟断言对齐 15s：负载下 iframe 重建 + 302 签发门往返可能超默认 5s
    await expect.poll(async () => {
      const now = await frameLoc.elementHandle()
      return now !== null && now !== before
    }, { timeout: 15000 }).toBeTruthy()
    await expect(page.frameLocator('.dsh-frame').locator(`#${MARKER}`)).toBeVisible({ timeout: 15000 })

    // F5：同样触发刷新
    const beforeF5 = await frameLoc.elementHandle()
    await page.keyboard.press('F5')
    await expect.poll(async () => {
      const now = await frameLoc.elementHandle()
      return now !== null && now !== beforeF5
    }, { timeout: 15000 }).toBeTruthy()

    // Esc：关闭视图（v-show 保活 → hidden）
    await page.keyboard.press('Escape')
    await expect(view).toBeHidden()
  })
})
