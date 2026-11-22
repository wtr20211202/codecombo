import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * dsh 外部目标（多目标）管理面收口 E2E（P-20261118-6）。
 *
 * 外部 dsh 是多机管理高频形态：本 spec 用对话框级 API mock（P-20261118-4
 * dsh-off-diag-external-owner.spec 同款 page.route 先例）钉住外部目标激活时
 * 的四个面，此前全部指回「本机」语义、对外部目标必误导：
 *   1. 令牌横幅入口分支：外部目标令牌在目标管理器维护（「打开设置」改的是
 *      本机 DshWebToken）——横幅按钮随目标分支；
 *   2. 反代关闭警告：外部目标 + 反代关闭 → 直连嵌入三重坏（无帧头剥离/无
 *      签发门/混合内容硬阻断）显式警告；切回本机警告消失；
 *   3. 空态文案分支：「目标机 <host>」替代「本机/默认 3080」三重误导，
 *      一键启动（本机动作）对外部目标不渲染；
 *   4. 版本面只读化（用户定向修订一）：版本与 changelog 可看、升级/回退
 *      动作隐藏（升级链只管本机 npm 包），就地说明；工具栏版本标签 title
 *      本机标注；
 *   5. notReady 显式态消费：launch 响应 available+notReady → 「已监听，但
 *      HTTP 尚未就绪」提示（双层判活的就绪判据未满足，替代笼统成功）；
 *   6. 目标编辑重探测：编辑保存的是当前激活目标 → 立即重探测（不再滞留
 *      旧 available/tokenState/iframe 至 30s 轮询）。
 */

/** 解锁令牌头（dsh 族 spec 同款） */
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

interface UrlFixture {
  available: boolean
  tokenState?: string
  proxyEnabled?: boolean
  url?: string
}

const EXT_TARGET = { id: 't-e2e', name: 'gpu-box', base: 'http://192.168.1.10:3080', token: '' }

/** mock dsh 工具族接口并打开控制台主区。/url 按目标参数分流（本机/外部），
 *  返回 /url 调用清单（含查询串）供重探测断言；versions 可注入注册表形态 */
async function openConsole(
  page: Page,
  opts: {
    local?: UrlFixture
    ext?: UrlFixture
    versions?: { current: string; latest: string; versions: { version: string; date: string }[]; rollbackVersion: string }
  } = {},
) {
  const urlCalls: string[] = []
  const local: UrlFixture = opts.local ?? { available: true }
  const ext: UrlFixture = opts.ext ?? { available: true }
  await page.route('**/api/tools/dsh/url*', (route) => {
    const u = route.request().url()
    urlCalls.push(u)
    const isExt = u.includes('target=t-e2e')
    const f = isExt ? ext : local
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          url: f.url ?? (f.available ? 'http://127.0.0.1:3081/' : ''),
          available: f.available,
          exposeAll: true,
          proxyEnabled: f.proxyEnabled ?? true,
          degraded: false,
          tokenState: f.tokenState ?? '',
          proxyScheme: 'http',
          tlsServedOnce: true,
        },
      }),
    })
  })
  await page.route('**/api/tools/dsh/targets', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [EXT_TARGET] }),
  }))
  await page.route('**/api/tools/dsh/targets/t-e2e', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { id: 't-e2e' } }),
  }))
  await page.route('**/api/tools/dsh/changelog', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [] }),
  }))
  await page.route('**/api/tools/dsh/versions', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: opts.versions ?? { current: '0.2.2', latest: '0.2.2', versions: [], rollbackVersion: '' } }),
  }))

  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await page.locator('button[title="dsh 控制台"]').click()
  await expect(page.locator('.dsh-root')).toBeVisible({ timeout: 10000 })
  return { urlCalls }
}

/** 工具栏目标下拉切换到指定目标（naive select：点开 → portal 内选项点选） */
async function switchTarget(page: Page, label: string) {
  await page.locator('.dsh-toolbar .n-select').click()
  const opt = page.locator('.n-base-select-option').filter({ hasText: label })
  await expect(opt).toBeVisible({ timeout: 5000 })
  await opt.click()
}

test('外部目标令牌横幅：入口开目标管理器（不再指本机设置页），点开直达目标弹层', async ({ page }) => {
  await openConsole(page, { ext: { available: true, tokenState: 'stale' } })
  await switchTarget(page, 'gpu-box')

  // 令牌失效横幅呈现；入口按钮随目标分支——「打开目标管理器」而非「打开设置」
  const banner = page.locator('.dsh-auth-banner')
  await expect(banner).toBeVisible({ timeout: 10000 })
  await expect(banner).toContainText('dsh 需要重新授权')
  const mgrBtn = banner.locator('[data-test="dsh-open-target-manager"]')
  await expect(mgrBtn).toHaveText('打开目标管理器')
  await expect(banner.getByRole('button', { name: '打开设置' })).toHaveCount(0)
  // 重启动作是本机语义：外部目标不渲染（既有行为，一并钉住防回归）
  await expect(banner.getByRole('button', { name: '重启并重新捕获令牌' })).toHaveCount(0)

  // 点击直达目标管理弹层（令牌字段就在其中）
  await mgrBtn.click()
  await expect(page.locator('.n-modal').filter({ hasText: 'dsh 连接管理' })).toBeVisible({ timeout: 5000 })
})

test('外部目标 + 反代关闭：显式警告直连三重坏；切回本机警告消失', async ({ page }) => {
  await openConsole(page, { ext: { available: true, proxyEnabled: false } })
  const warn = page.locator('[data-test="dsh-external-proxy-off"]')
  await switchTarget(page, 'gpu-box')
  await expect(warn).toBeVisible({ timeout: 10000 })
  await expect(warn).toContainText('外部目标需要启用反代通道')

  // 本机目标 + 反代关闭：不警告（直连上游是本机回环，无混合内容/帧策略问题面）
  await switchTarget(page, '本机 dsh')
  await expect(warn).toHaveCount(0)
})

test('外部目标空态文案：「目标机 <host>」分支 + 一键启动不渲染（本机动作）', async ({ page }) => {
  await openConsole(page, { ext: { available: false } })
  await switchTarget(page, 'gpu-box')

  const off = page.locator('.dsh-off')
  await expect(off).toBeVisible({ timeout: 10000 })
  // 文案随目标分支：目标机地址点名（替代「本机/默认 3080/设置→终端」三重误导）
  await expect(off.locator('.dsh-off-hint').filter({ hasText: '目标机 192.168.1.10:3080' })).toBeVisible()
  await expect(off).not.toContainText('请确认本机 dsh 已启动')
  await expect(off).not.toContainText('默认端口')
  // 一键启动是本机动作：外部目标不渲染；重新检测（通用）保留
  await expect(off.getByRole('button', { name: '一键启动 dsh' })).toHaveCount(0)
  await expect(off.getByRole('button', { name: '重新检测' })).toBeVisible()
})

test('外部目标版本面只读化：版本与列表可看，升级/回退动作隐藏，就地说明 + 工具栏本机标注', async ({ page }) => {
  const T0 = '2026-10-01T00:00:00.000Z'
  const T1 = '2026-10-02T00:00:00.000Z'
  // 注册表有比本机 current(0.2.2) 新的版本 + 回退点在案：若非只读化，
  // 升级动作与回退行必然渲染（mock 须在挂载 checkVersions 之前就位）
  await openConsole(page, {
    ext: { available: true },
    versions: {
      current: '0.2.2',
      latest: '0.3.0',
      versions: [
        { version: '0.2.2', date: T0 },
        { version: '0.3.0', date: T1 },
      ],
      rollbackVersion: '0.2.1',
    },
  })

  // 工具栏版本标签：title 带本机标注（版本号与升级徽标恒取自本机 dsh）
  await switchTarget(page, 'gpu-box')
  const tag = page.locator('.dsh-upgrade-tag')
  await expect(tag).toHaveText('↑ v0.3.0', { timeout: 10000 })
  await expect(tag).toHaveAttribute('title', /版本信息取自本机 dsh/)

  // 版本弹窗：只读视图——版本列表照常呈现，升级按钮与回退行隐藏，就地说明在场
  await tag.click()
  const dlg = page.locator('.n-modal').filter({ hasText: 'dsh 版本管理' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg.locator('.ver-item').filter({ hasText: 'v0.3.0' })).toBeVisible()
  await expect(dlg.locator('[data-test="dsh-versions-local-only"]')).toContainText('升级/回退仅作用于本机')
  await expect(dlg.locator('.ver-actions')).toHaveCount(0)
  await expect(dlg.locator('[data-test="dsh-rollback-row"]')).toHaveCount(0)

  // 本机目标：同一弹窗升级动作照常（只读化只随外部目标激活）
  await page.keyboard.press('Escape')
  await switchTarget(page, '本机 dsh')
  await tag.click()
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg.locator('.ver-actions')).toBeVisible()
  await expect(dlg.locator('[data-test="dsh-versions-local-only"]')).toHaveCount(0)
})

test('notReady 显式态：launch 响应 available+notReady → 「已监听，但 HTTP 尚未就绪」提示', async ({ page }) => {
  await openConsole(page, { local: { available: false } })
  const off = page.locator('.dsh-off')
  await expect(off).toBeVisible()

  // /launch 即回 available=true + notReady=true（双层判活 deadline 收口形态）；
  // /status 恒 false——并行轮询不得抢先收口，POST 结果分支必须走到
  await page.route('**/api/tools/dsh/launch', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: true, spawned: true, tokenCaptured: true, notReady: true } }),
  }))
  await page.route('**/api/tools/dsh/status', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { available: false, upstream: 'http://127.0.0.1:3080', latencyMs: 0 } }),
  }))

  await off.getByRole('button', { name: '一键启动 dsh' }).click()
  await expect(page.locator('.dsh-off-hint').filter({ hasText: '已监听，但 HTTP 尚未就绪' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.dsh-root')).not.toContainText('检测到已有 dsh 实例在运行')
})

test('目标编辑重探测：保存的是当前激活目标 → 立即重探测（带 target 参数的 /url 再取）', async ({ page }) => {
  const { urlCalls } = await openConsole(page, { ext: { available: true } })
  await switchTarget(page, 'gpu-box')
  await expect(page.locator('.dsh-frame')).toBeVisible({ timeout: 10000 })
  const extCallsBefore = urlCalls.filter((u) => u.includes('target=t-e2e')).length
  expect(extCallsBefore).toBeGreaterThanOrEqual(1) // 切换目标时的首次探测

  // 打开目标管理器 → 编辑当前激活目标 → 保存
  await page.locator('.dsh-toolbar button[title="管理 dsh 连接"]').click()
  const modal = page.locator('.n-modal').filter({ hasText: 'dsh 连接管理' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('.tgt-item').filter({ hasText: 'gpu-box' }).getByRole('button', { name: '编辑' }).click()
  await modal.getByRole('button', { name: '保存' }).click()
  await expect(modal.locator('.tgt-form-title')).toContainText('添加连接', { timeout: 5000 }) // 表单复位 = 保存成功

  // 立即重探测：带 target 参数的 /url 调用数增长（不再等 30s 轮询）
  await expect.poll(() => urlCalls.filter((u) => u.includes('target=t-e2e')).length,
    { timeout: 10000 }).toBeGreaterThan(extCallsBefore)
})
