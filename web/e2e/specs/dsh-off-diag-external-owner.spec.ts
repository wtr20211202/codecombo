import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * dsh 空态可诊断化 + 外部运行实例语义 E2E（P-20261118-4）。
 *
 * 用户实测场景：dsh 进程在跑（netstat LISTEN）、反代通道正常转发，面板却
 * 恒显「未检测到 dsh Web UI」——空态只有笼统判词，不显示实际探测的地址，
 * 配置带偏时提示还指向「默认端口 3080」主动误导。本 spec 用对话框级 API
 * mock（dsh-versions-rollback-prerelease.spec 同款 page.route 先例）钉住：
 *   1. 空态诊断行：available=false + probe 诊断块 → 显示「已探测 <base>
 *      （目标 <id>）：<失败分类+err 原文>」——配置带偏一眼可见；probe 缺省
 *      （旧后端形态）不渲染诊断行（catch/缺省鲁棒）；
 *   2. launching 文案矛盾消解 + 分阶段如实预告：一键启动进行中空态标题从
 *      「未检测到」切换为「启动中…」，拉起后未就绪阶段提示切换为「最长约
 *      1 分钟」预告；
 *   3. 并行 /status 轮询提前收口：launching 期间探测可用（外部实例在跑）即
 *      提示「检测到已有实例」+ 设置直达入口，不再干等 POST /launch 返回；
 *   4. 重启占用显式归因：升级重启响应 externalOwner=true → 「重启未生效：
 *      端口被外部运行 dsh 占用」提示（防 available=true 误判重启成功）。
 */

/** 解锁令牌头（dsh-versions-rollback-prerelease.spec 同款） */
async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test.beforeEach(async ({ request }) => {
  // dsh 控制台开合是服务端 uiState（套件共享实例）：压回关闭防先例浮层挡按钮
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { dshConsole: { open: false } } },
  })
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders(request)
  await request.patch(`${API_BASE}/api/ui-state`, {
    headers,
    data: { local: { dshConsole: { open: false } } },
  })
})

interface ProbeFixture {
  available: boolean
  tokenState?: string
  probe?: { base: string; target: string; latencyMs: number; errClass: string; err: string }
}

/** mock dsh 工具族接口并打开控制台主区（版本/目标/changelog 空态防打穿） */
async function openConsole(page: Page, urlFixture: ProbeFixture) {
  await page.route('**/api/tools/dsh/url*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      data: {
        url: urlFixture.available ? 'http://127.0.0.1:3081/' : '',
        available: urlFixture.available,
        exposeAll: true,
        degraded: false,
        tokenState: urlFixture.tokenState ?? '',
        proxyScheme: 'http',
        tlsServedOnce: true,
        ...(urlFixture.probe ? { probe: urlFixture.probe } : {}),
      },
    }),
  }))
  await page.route('**/api/tools/dsh/targets', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }))
  await page.route('**/api/tools/dsh/changelog', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }))
  await page.route('**/api/tools/dsh/versions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { current: '0.2.2', latest: '0.2.2', versions: [], rollbackVersion: '' } }),
  }))

  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await page.locator('button[title="dsh 控制台"]').click()
  await expect(page.locator('.dsh-root')).toBeVisible({ timeout: 10000 })
}

test('空态诊断行：显示实际探测的 base/目标与失败归因；probe 缺省不渲染', async ({ page }) => {
  await openConsole(page, {
    available: false,
    probe: {
      base: 'http://127.0.0.1:3080',
      target: 'local',
      latencyMs: 3,
      errClass: 'refused',
      err: 'dial tcp 127.0.0.1:3080: connect: connection refused',
    },
  })

  const off = page.locator('.dsh-off')
  await expect(off).toBeVisible()
  // 诊断行：实际探测的 base + 目标 + 失败分类文案 + err 原文（配置带偏一眼可见）
  const diag = off.locator('.dsh-off-diag')
  await expect(diag).toContainText('已探测 http://127.0.0.1:3080')
  await expect(diag).toContainText('目标 local')
  await expect(diag).toContainText('连接被拒绝')
  await expect(diag).toContainText('connection refused')
  // 空态引导不再硬编码「默认端口 3080」（探测地址≠默认端口时不再误导）
  await expect(off).not.toContainText('默认端口 3080')

  // probe 缺省（旧后端/字段缺省形态）：诊断行不渲染，空态其余功能不变。
  // 同一控制台内覆盖 mock 后点「重新检测」触发重探测——不重新 goto：浮层
  // 开态已落盘 uiState，刷新会经 restoreDshConsoleOnce 自动展开空态浮层，
  // 铺满的 .dsh-off 会拦截首页「dsh 控制台」按钮的点击
  await page.route('**/api/tools/dsh/url*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { url: '', available: false, exposeAll: true, degraded: false, tokenState: '', proxyScheme: 'http', tlsServedOnce: true } }),
  }))
  await off.getByRole('button', { name: '重新检测' }).click()
  await expect(off.locator('.dsh-off-diag')).toHaveCount(0)
  await expect(off.locator('.dsh-off-title')).toContainText('未检测到 dsh Web UI')
})

test('launching 文案矛盾消解 + 分阶段如实预告（最长约 1 分钟）', async ({ page }) => {
  await openConsole(page, { available: false })
  const off = page.locator('.dsh-off')
  await expect(off).toBeVisible()

  // /launch 挂起（真实形态：后端在等就绪），/status 恒 false（无外部实例）
  await page.route('**/api/tools/dsh/launch', async (route) => {
    await new Promise((r) => setTimeout(r, 9000))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { available: false, spawned: true, tokenCaptured: false, logPath: '', logTail: '' } }),
    })
  })
  await page.route('**/api/tools/dsh/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: false, upstream: 'http://127.0.0.1:3080', latencyMs: 0 } }),
  }))

  await off.getByRole('button', { name: '一键启动 dsh' }).click()
  // launching 期间空态标题从「未检测到」切换为「启动中…」（文案矛盾消解）
  await expect(off.locator('.dsh-off-title')).toContainText('启动中…', { timeout: 5000 })
  // 分阶段如实预告：拉起后未就绪阶段切换为「最长约 1 分钟」提示
  await expect(off.locator('.dsh-off-hint').filter({ hasText: '仍在等待 dsh 就绪' })).toBeVisible({ timeout: 8000 })
})

test('并行 /status 轮询提前收口：检测到外部实例即提示 + 设置直达入口', async ({ page }) => {
  await openConsole(page, { available: false })
  const off = page.locator('.dsh-off')
  await expect(off).toBeVisible()

  // /launch 极慢（外部占用形态下后端要等宽限才回）；/status 恒 true = 已有实例在监听
  await page.route('**/api/tools/dsh/launch', async (route) => {
    await new Promise((r) => setTimeout(r, 20000))
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: { available: true, spawned: true, tokenCaptured: false } }),
    })
  })
  await page.route('**/api/tools/dsh/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: true, upstream: 'http://127.0.0.1:3080', latencyMs: 1 } }),
  }))

  await off.getByRole('button', { name: '一键启动 dsh' }).click()
  // 提前收口（2.5s 轮询周期，不等 POST 返回）：如实归因 + 设置直达入口为主，
  // 不再引导「重启 dsh」
  await expect(off.filter({ hasText: '检测到已有 dsh 实例在运行' })).toBeVisible({ timeout: 10000 })
  await expect(off.getByRole('button', { name: '打开设置' })).toBeVisible()
  await expect(off).not.toContainText('请先退出/重启 dsh')
})

test('重启占用显式归因：externalOwner=true → 「重启未生效」而非误判成功', async ({ page }) => {
  await openConsole(page, { available: true, tokenState: 'stale' })
  // 令牌失效横幅 → 重启并重新捕获令牌（升级重启链）
  const banner = page.locator('.dsh-auth-banner')
  await expect(banner).toBeVisible()
  await page.route('**/api/tools/dsh/upgrade/restart', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { ok: true, available: true, tokenCaptured: false, spawned: true, externalOwner: true, portBusy: true, probeBase: 'http://127.0.0.1:3080' } }),
  }))
  await banner.getByRole('button', { name: '重启并重新捕获令牌' }).click()
  const confirm = page.locator('.n-dialog').filter({ hasText: '将结束当前 dsh 进程' })
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: '重启并捕获令牌' }).click()
  // available=true 但 externalOwner=true：显式报「重启未生效：端口被外部进程占用」，
  // 不落「重启成功」也不落笼统「重启未成功」（防静默无效误判新令牌已加载）
  await expect(page.locator('.dsh-auth-banner').locator('.dsh-auth-hint').filter({ hasText: '重启未生效：上游端口被外部运行的 dsh 占用' })).toBeVisible({ timeout: 10000 })
})
