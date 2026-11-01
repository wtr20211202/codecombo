import { test, expect } from '@playwright/test'
import { exec } from 'child_process'
import http from 'http'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, projectCardByName } from './helpers'

/**
 * dsh 真实 UI 全链路 E2E（P8）：WSL 中真实运行的 dsh（DeepSeek Harness）。
 *
 * 前置（缺失时用例内自动拉起，仍不可用则 skip 不误报）：
 *   - WSL Ubuntu-24.04 安装 Node 22 / @deepseek-ai/dsh（npm 全局）
 *   - dsh web --no-open 运行中（自带 token 鉴权，日志打印 token URL）
 *   - 系统 dshWebToken 已配置为 dsh 当前 token（反代透传 cookie 流程）
 *
 * 说明：与 tests/dsh-console.spec.ts（假上游）互斥使用——两者都占用 3080。
 * 本 spec 断言的是「真实 dsh UI 经反代在主区视图中渲染」这一最终闭环。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

/** dsh Web 探活：任意 HTTP 响应（401/303 等）都算活着，连接失败/超时 = 不可达 */
function dshReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: 3080, path: '/', timeout: 2000 }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

/** 从 WSL dsh 日志读当前 token（dsh 每次启动轮换） */
function readDshToken(): Promise<string> {
  return new Promise((resolve) => {
    exec('wsl -d Ubuntu-24.04 bash -c "grep -oE \'token=[A-Za-z0-9_-]+\' /tmp/dsh-final2.log | head -1 | cut -d= -f2"', { timeout: 15000 }, (err, stdout) => {
      resolve(err ? '' : stdout.trim())
    })
  })
}

/** 前置就绪：探活/_token 任一不满足时（重）启 WSL 内 dsh 并轮询等待。
 *  pkill 模式用字符类防 bash -c 自匹配；setsid 脱离会话防随 wsl 调用结束被回收。
 *  彻底不可用返回空串（调用方 skip），不在 CI 里误报失败 */
async function ensureDshReady(): Promise<string> {
  let token = await readDshToken()
  if (token && await dshReachable()) return token
  await new Promise<void>((resolve) => {
    exec('wsl -d Ubuntu-24.04 bash -c "pkill -f \'dsh web[-]-no-open\' 2>/dev/null; sleep 1; setsid nohup dsh web --no-open > /tmp/dsh-final2.log 2>&1 < /dev/null & disown; sleep 3"', { timeout: 40000 }, () => resolve())
  })
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000))
    token = await readDshToken()
    if (token && await dshReachable()) return token
  }
  return ''
}

async function setDshToken(request: import('@playwright/test').APIRequestContext, token: string) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const t = ((await res.json()) as { token?: string }).token || ''
  await request.put(`${BASE}/api/settings`, {
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': t },
    data: { dshWebToken: token },
  })
}

test.describe('dsh 真实 UI 全链路（P8）', () => {
  // 用例以「重开控制台」结束：不清理会把打开状态持久化到 uiState，后续用例
  // 恢复出全屏控制台遮挡首页（曾致全量串行套件级联失败）
  test.afterEach(async ({ page, request }) => {
    await closeDshConsoleAndClearState(page, request, BASE)
  })

  test('真实 dsh UI 经反代在主区渲染；关闭重开内容保留', async ({ page }) => {
    const token = await ensureDshReady()
    test.skip(!token, 'WSL dsh 不可用（自动拉起失败）——真实 UI 全链路用例跳过')
    if (!token) return

    const request = page.request
    await setDshToken(request, token)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    // 打开 dsh 控制台
    await page.locator('.rail-btn[title="dsh 控制台"]').click()
    const view = page.locator('.dsh-root')
    await expect(view).toBeVisible({ timeout: 10000 })

    // 状态点 ok（探活通过）+ 回环 iframe URL 保持干净（token 经反代 302 签发门
    // 下发，fbab1bc 契约：不泄漏进 URL）
    await expect(view.locator('.dsh-status.ok')).toBeVisible({ timeout: 10000 })
    const src = await view.locator('.dsh-frame').getAttribute('src', { timeout: 15000 })
    expect(src).not.toContain('token=')

    // 真实 dsh UI 渲染：跨域 frame 内出现 DeepSeek Harness 页面结构
    // （302 签发门用配置 token 完成鉴权闭环的直接证据）
    const frame = page.frameLocator('.dsh-frame')
    await expect(frame.locator('body')).toContainText(/dsh|DeepSeek|Harness|项目|会话/i, { timeout: 20000 })

    // 关闭 → 重开：内容保留（iframe 不重载，src 稳定且仍无 token 泄漏）
    await view.locator('.dsh-actions button').last().click()
    await expect(view).toBeHidden()
    await page.locator('.rail-btn[title="dsh 控制台"]').click()
    await expect(view).toBeVisible()
    const srcAfter = await view.locator('.dsh-frame').getAttribute('src', { timeout: 15000 })
    expect(srcAfter).toBe(src)

    // 收尾：清 token 配置（dsh 进程保留运行，供人工查看；停止命令见报告）
    await setDshToken(request, '')
  })
})
