import { test, expect, type APIRequestContext } from '@playwright/test'
import { execSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 真 dsh 全链路 E2E（opt-in）：WSL 内真实 dsh web → Windows 服务端探测 → 回环反代 iframe。
 *
 * 默认 skip；SC_E2E_REAL_DSH=1 时启用。前置：
 *   1. WSL (默认发行版) 中已有 `dsh web` 实例运行（监听 127.0.0.1:3080）。
 *      官方方式即可启动；若报 "cordis-plugin-hmr: --expose-internals is
 *      required"，是本机 optional 原生绑定缺失（loader 的无旗标回退路径
 *      node-addon-require-builtin 断了），补装平台包即可复原官方行为：
 *        cd $(dirname $(readlink -f $(command -v dsh)))/../lib/node_modules/@deepseek-ai/dsh/node_modules/node-addon-require-builtin
 *        npm install --no-save node-addon-require-builtin-linux-x64-gnu
 *      应急绕过（不修绑定）：node --expose-internals 直拉 bin.js。
 *      注意 wsl 会话退出会杀后台进程 → 用 setsid 起并保活：
 *        setsid nohup dsh web --no-open --trusted-host 127.0.0.1:3081 \
 *          --trusted-host 127.0.0.1:10002 > /tmp/dsh-web.log 2>&1 &
 *      （--trusted-host = dsh 的 /api browser-trust fence 放行反代与宿主
 *      两个 authority，嵌入完整功能需要）
 *   2. Windows 侧可经 localhost 转发访问该端口（WSL2 默认行为；
 *      转发生效前提是 dsh 进程存活）
 *
 * dsh 的 launch token 每次启动随机（进程内存），运行时从 dsh 进程的 stdout 日志
 * 动态提取（fd/1 → 日志文件 → /?token= URL）。用例结束恢复 base/token 默认值。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const ENABLED = process.env.SC_E2E_REAL_DSH === '1'

const TOKEN_SCRIPT = `
# 兼容两种启动形态：官方 shim（node /usr/local/bin/dsh web …）与
# node 直拉（node …/lib/bin.js web …）——两者 cmdline 都含 dsh…web
pid=$(pgrep -f "dsh.*web" | head -1)
[ -z "$pid" ] && exit 0
log=$(readlink /proc/$pid/fd/1)
[ -z "$log" ] && exit 0
grep -oE "http://[^ ]*\\\\?token=[A-Za-z0-9_-]+" "$log" 2>/dev/null | tail -1
`

/** 从 WSL 内 dsh 进程的 stdout 日志提取最近的 /?token= 启动 URL（stdin 喂脚本避开引号转义） */
function readDshLaunchToken(): string | null {
  try {
    const out = execSync('wsl.exe -e bash -s', {
      input: TOKEN_SCRIPT,
      encoding: 'utf-8',
      timeout: 20_000,
    }).trim()
    const m = out.match(/token=([A-Za-z0-9_-]+)$/)
    return m ? m[1] : null
  } catch {
    return null
  }
}

async function putSettings(request: APIRequestContext, base: string, token: string) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const unlock = ((await res.json()) as { token?: string }).token || ''
  await request.put(`${BASE}/api/settings`, {
    headers: { 'X-Lock-Token': unlock },
    data: { dshWebBase: base, dshWebToken: token },
  })
}

test.describe('真 dsh 全链路（opt-in，打磨轮6）', () => {
  test.skip(!ENABLED, 'SC_E2E_REAL_DSH=1 时启用（依赖 WSL 内运行中的 dsh web）')

  const UPSTREAM = 'http://127.0.0.1:3080'
  let launchToken = ''

  test.beforeAll(async ({ request }) => {
    launchToken = readDshLaunchToken() || ''
    test.skip(!launchToken, '未能从 WSL dsh 进程日志提取 launch token')
    await putSettings(request, UPSTREAM, launchToken)
  })

  test.afterAll(async ({ request }) => {
    // 恢复与 fake-dsh spec 一致的默认：上游 3080、无 token
    await putSettings(request, UPSTREAM, '')
  })

  test('WSL 真 dsh：探测可用 → 反代 iframe 渲染 DeepSeek Harness', async ({ page }) => {
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')

    await page.locator('.rail-btn[title="dsh 控制台"]').click()
    const view = page.locator('.dsh-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    // 服务端探测真 dsh 可用（状态点绿色）
    await expect(view.locator('.dsh-status.ok')).toBeVisible({ timeout: 15000 })
    // iframe 经反代加载的是真 dsh（DeepSeek Harness #root 挂载点渲染出内容），
    // 非 fake marker；跨源 frame 用 frameLocator 断言
    const frame = page.frameLocator('.dsh-frame')
    await expect(frame.locator('#root').locator('> *').first()).toBeVisible({ timeout: 20000 })
    await expect(frame.locator('#sc-fake-dsh-ok')).toHaveCount(0)
  })
})
