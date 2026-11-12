import { test, expect, type Page, type Route } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, projectCardByName, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 更新进度离开可见 E2E（P-20261109-10）：真实更新链外呼 GitHub 不可控（版本
 * 漂移/速率限制/会真换包），/api/updates/status 走 page.route 注入状态机各态
 * （version-uptodate-feedback 同款先例），机器化钉住：
 *   1. 全局徽标常驻可见——版本面板关闭后，下载中/校验各阶段文案与下载百分比
 *      在页面角落实时可见（离开面板不失明）；
 *   2. F5/关面板重开进度恢复——面板挂载即同步，服务端在途即接管（「立即更新」
 *      不误可点，服务端 409 前端静默的双洞）；
 *   3. 面板内进度块同源消费——阶段文案（不再直出键名原文）+ 字节明细；
 *   4. 失败通知「查看详情」回面板——服务端通知（titleKey 模板 + update-panel
 *      动作）点击后设置弹窗定位「关于」，原因原文在面板结局块可见；「知道了」
 *      确认已读（DELETE /updates/status）；
 *   5. 长 changelog 收起态摘要 + 展开限高内滚，「立即更新」首屏可达；更新内容
 *      markdown 净化渲染与页内锚点切换（P-20261112-2 S1）；标题行「查看发布页」
 *      外链新窗直达 Release 页、同行布局不回归、releaseUrl 缺失不显（S2）；
 *   6. 断点续传透出（P-20261110-1-S4）——续传态「已续传 xxMB」标记在面板内可见，
 *      全量回退（服务端归 0 省略）后消隐，百分比分母不随之失真。
 *   7. 失败态一键重试（P-20261110-1-S2）：结局块重试按钮复用 apply 受理端点，
 *      失败→重试→受理进下载恢复（升级链中断恢复形态）。
 *   8. 升级链中断恢复全链呈现（P-20261110-1-S7）：下载阶段内存失败态（重试耗尽
 *      的 status=failed+error 原文，区别于 7 的结果文件形态）→ 重试受理 → 进度块
 *      从续传偏移起步（「已续传」标记 + 百分比/分母不失真）→ 校验 → 重启 → 成功
 *      结局带刷新引导。状态序列回放的是服务端真实链的输出——真链（受理→断连→
 *      续传→真校验→换包边界）由 Go 集成测试背书（server/update/
 *      manager_retry_test.go 的 S7 三用例：续传成功/中断恢复/停滞看门狗），本 spec
 *      钉 UI 消费面。真 e2e 不可行的缘由：更新源与下载地址强制公网 https、拨号期
 *      拒回环，且走通即真实换包。
 * /api/updates/apply 也拦下（本套件不真触发受理），通知 POST 拦截本地应答；
 * 结尾 API 清通知域，不残留测试数据。
 */

const STATUS_ROUTE = '**/api/updates/status*'

type StatusPayload = Record<string, unknown>

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 可切换响应的 status 路由；DELETE（确认已读）同服务端语义：清结果与失败态回空闲 */
async function routeStatus(page: Page, initial: StatusPayload) {
  const state = { payload: initial, deletes: 0 }
  await page.route(STATUS_ROUTE, async (route: Route) => {
    if (route.request().method() === 'DELETE') {
      state.deletes++
      state.payload = { status: 'idle', progress: 0, total: 0, version: '' }
      await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ message: 'update status cleared' }) })
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.payload }) })
  })
  return state
}

/** 打开版本面板（设置弹窗「关于」分区） */
async function openVersionPanelViaSettings(page: Page) {
  await page.locator('.rail-btn[title="设置"]').first().click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="settings-nav-about"]').click()
  return modal
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('下载中：面板内进度块与全局徽标同源可见；关闭面板后徽标仍在且实时', async ({ page }) => {
  // 续传态注入（P-20261110-1-S4）：resumedBytes = 服务端 .part 实际续传偏移
  const status = await routeStatus(page, {
    status: 'downloading', progress: 40 * 1024 * 1024, total: 100 * 1024 * 1024, resumedBytes: 40 * 1024 * 1024, version: '9.9.9',
  })
  const posted: string[] = []
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 面板尚未打开：全局徽标已可见（启动同步接管在途更新）
  const badge = page.locator('[data-testid="update-progress-badge-text"]')
  await expect(badge).toContainText('下载中')
  await expect(badge).toContainText('40%')

  // 打开面板：进度块同源（阶段文案不是键名原文）；续传会话带「已续传」标记
  const modal = await openVersionPanelViaSettings(page)
  await expect(page.locator('[data-testid="version-update-phase"]')).toHaveText('下载中')
  await expect(page.locator('[data-testid="version-update-bytes"]')).toContainText('40.0 MB')
  await expect(page.locator('[data-testid="version-update-resumed"]')).toContainText('已续传 40.0 MB')

  // 全量回退（服务端续传起点归 0、omitempty 省略）：标记消隐，分母不随之失真
  status.payload = { status: 'downloading', progress: 50 * 1024 * 1024, total: 100 * 1024 * 1024, version: '9.9.9' }
  await expect(page.locator('[data-testid="version-update-resumed"]')).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('[data-testid="version-update-bytes"]')).toContainText('50%')

  await expect(page.locator('[data-testid="version-update-now"]')).toHaveCount(0)
  await page.locator('.n-modal.settings-modal .settings-close').click()
  await expect(modal).not.toBeVisible({ timeout: 5000 })

  // 关闭面板后徽标仍在；推进状态（校验 → 100%）实时反映
  await expect(badge).toBeVisible()
  status.payload = { status: 'verifying', progress: 100 * 1024 * 1024, total: 100 * 1024 * 1024, version: '9.9.9' }
  await expect(badge).toContainText('校验中', { timeout: 10000 })
  // 百分比只在下载阶段透出（校验无字节分母，徽标底边改流动条）
  await expect(badge).not.toContainText('%')
  // 更新链不重复入账通知（服务端单一发射）：面板/store 零 POST
  expect(posted.filter(b => b.includes('更新') || b.includes('update')).length).toBe(0)
})

test('换包重启窗：受理后失联推断态「安装并重启中」；恢复后成功结局带刷新引导', async ({ page }) => {
  let failStatus = true
  await page.route(STATUS_ROUTE, async (route) => {
    if (failStatus) {
      await route.abort('connectionrefused')
      return
    }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { status: 'idle', progress: 0, total: 0, version: '9.9.9', result: 'success', resultAt: '2026-11-09T00:00:00Z' } }) })
  })
  const posted: string[] = []
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  await page.route('**/api/updates/apply', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ message: 'update started', version: '9.9.9' }) })
  })
  await page.route('**/api/updates/check*', async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog: '- fix' } }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 首页版本弹窗（首页同样有宿主入口）发起更新：受理即失联 → 推断态
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()
  await card.getByRole('button', { name: '立即更新' }).click()
  const badge = page.locator('[data-testid="update-progress-badge-text"]')
  await expect(badge).toContainText('安装并重启中', { timeout: 10000 })

  // 服务恢复且结果已落盘：成功结局 + 刷新引导 toast；开始通知不由前端入账
  failStatus = false
  await expect(badge).toContainText('已更新到 v9.9.9', { timeout: 10000 })
  await expect(page.locator('.n-message').first()).toContainText('已更新到 v9.9.9', { timeout: 5000 })
  expect(posted.filter(b => b.includes('更新') || b.includes('update')).length).toBe(0)
})

test('失败通知「查看详情」：回面板结局块带原因；「知道了」确认已读', async ({ page }) => {
  const status = await routeStatus(page, {
    status: 'idle', progress: 0, total: 0, version: '9.9.9',
    result: 'failed', resultError: 'update verification failed: checksum mismatch', resultAt: '2026-11-09T01:02:03Z',
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 服务端通知（titleKey 模板 + update-panel 动作）入通知中心
  const headers = await unlockHeaders()
  const res = await page.request.post(`${API_BASE}/api/notifications`, {
    headers,
    data: {
      type: 'error',
      category: 'system',
      titleKey: 'update.notify.failedTitle',
      bodyKey: 'update.notify.failedBody',
      title: '更新到 v9.9.9 失败',
      body: 'update verification failed: checksum mismatch',
      msgParams: { version: '9.9.9' },
      action: 'update-panel',
    },
  })
  expect(res.ok()).toBeTruthy()

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
  // 模板按界面语言渲染（不是键名原文）
  await expect(page.locator('.nc-card').getByText('更新到 v9.9.9 失败').first()).toBeVisible()
  await page.locator('.nc-card').getByRole('button', { name: '查看详情' }).first().click()

  // 回跳：设置弹窗定位「关于」，结局块带原因原文
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(modal.locator('[data-testid="settings-pane-about"]')).toBeVisible()
  await expect(modal.locator('[data-testid="version-update-outcome-phase"]')).toHaveText('更新失败')
  await expect(modal.locator('[data-testid="version-update-outcome-reason"]')).toContainText('checksum mismatch')

  // 确认已读：DELETE status 清结果文件与失败态（路由按服务端语义回空闲），结局块消隐
  await modal.locator('[data-testid="version-update-ack"]').click()
  await expect(modal.locator('[data-testid="version-update-outcome"]')).toHaveCount(0, { timeout: 5000 })
  expect(status.deletes).toBe(1)
})

test('失败态一键重试（P-20261110-1-S2）：结局块重试按钮复用 apply 受理，失败→重试→下载恢复', async ({ page }) => {
  const status = await routeStatus(page, {
    status: 'idle', progress: 0, total: 0, version: '9.9.9',
    result: 'failed', resultError: 'download failed: download returned 503 (after 3 attempts)', resultAt: '2026-11-09T02:03:04Z',
  })
  const applies: string[] = []
  await page.route('**/api/updates/apply', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    applies.push(route.request().postData() ?? '')
    // 按服务端受理语义推进状态源：受理即清上一轮结果文件、状态机进下载——不切的话
    // 受理后首拉（1.5s 轮询）读回旧 failed 结果会被判作本轮终局，用例随跑速竞态
    status.payload = { status: 'downloading', progress: 0, total: 100 * 1024 * 1024, version: '9.9.9' }
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ message: 'update started', version: '9.9.9' }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 打开面板：上次失败结局块带原因原文（重试注记形态）与重试主按钮
  const modal = await openVersionPanelViaSettings(page)
  const block = modal.locator('[data-testid="version-update-outcome"]')
  await expect(block).toBeVisible({ timeout: 5000 })
  await expect(block.locator('[data-testid="version-update-outcome-reason"]')).toContainText('after 3 attempts')
  await block.locator('[data-testid="version-update-retry"]').click()

  // 受理成功：进度块接棒（下载中），结局块消隐；apply 走的是同一受理端点
  await expect(modal.locator('[data-testid="version-update-phase"]')).toHaveText('下载中', { timeout: 5000 })
  await expect(modal.locator('[data-testid="version-update-outcome"]')).toHaveCount(0)
  expect(applies).toHaveLength(1)

  // 重试后的下载进度实时恢复（面板与全局徽标同源）
  status.payload = { status: 'downloading', progress: 20 * 1024 * 1024, total: 100 * 1024 * 1024, version: '9.9.9' }
  await expect(modal.locator('[data-testid="version-update-bytes"]')).toContainText('20%', { timeout: 10000 })
  await expect(page.locator('[data-testid="update-progress-badge-text"]')).toContainText('下载中', { timeout: 10000 })
})

test('升级链中断恢复全链（P-20261110-1-S7）：下载失败→重试受理→从续传偏移起步（已续传）→校验→重启→成功结局', async ({ page }) => {
  const MB = 1024 * 1024
  // 起点 = 服务端内存失败态（下载阶段重试耗尽：status=failed + error 原文，半截
  // .part 保留）。此后回放的状态序列即 Go 集成测试
  // TestApplyUpdateInterruptedThenReadmittedResumesToRestarting 实证的服务端输出：
  // 再受理 → 首个下载快照即带续传偏移与 resumedBytes → 校验 → 重启
  const status = await routeStatus(page, {
    status: 'failed', progress: 40 * MB, total: 100 * MB, version: '9.9.9',
    error: 'download failed: unexpected EOF (after 3 attempts)',
  })
  const applies: string[] = []
  await page.route('**/api/updates/apply', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    applies.push(route.request().postData() ?? '')
    // 再受理：服务端从保留的 .part 续传，状态机进度即刻落到续传起点（不回零）
    status.payload = { status: 'downloading', progress: 40 * MB, total: 100 * MB, resumedBytes: 40 * MB, version: '9.9.9' }
    await route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ message: 'update started', version: '9.9.9' }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 失败结局块：内存失败态的原因原文（尝试注记）+ 重试主按钮
  const modal = await openVersionPanelViaSettings(page)
  const failed = modal.locator('[data-testid="version-update-outcome"]')
  await expect(failed).toBeVisible({ timeout: 5000 })
  await expect(failed.locator('[data-testid="version-update-outcome-phase"]')).toHaveText('更新失败')
  await expect(failed.locator('[data-testid="version-update-outcome-reason"]')).toContainText('unexpected EOF (after 3 attempts)')
  await failed.locator('[data-testid="version-update-retry"]').click()

  // 再受理 → 进度块接棒：首个字节明细即续传现场（40% 起步而非从 0 重来），分母
  // 是全量总长（不是剩余尾段），「已续传」标记 = 续传起点
  const phase = modal.locator('[data-testid="version-update-phase"]')
  const bytes = modal.locator('[data-testid="version-update-bytes"]')
  const resumed = modal.locator('[data-testid="version-update-resumed"]')
  await expect(phase).toHaveText('下载中', { timeout: 5000 })
  await expect(bytes).toHaveText('40%（40.0 MB / 100.0 MB）', { timeout: 10000 })
  await expect(resumed).toHaveText('已续传 40.0 MB')
  await expect(modal.locator('[data-testid="version-update-outcome"]')).toHaveCount(0)

  // 推进：百分比跟随累计字节；续传起点标记恒定（本尝试从哪继续，不随进度漂移）
  status.payload = { status: 'downloading', progress: 70 * MB, total: 100 * MB, resumedBytes: 40 * MB, version: '9.9.9' }
  await expect(bytes).toHaveText('70%（70.0 MB / 100.0 MB）', { timeout: 10000 })
  await expect(resumed).toHaveText('已续传 40.0 MB')
  const badge = page.locator('[data-testid="update-progress-badge-text"]')
  await expect(badge).toContainText('下载中 70%')

  // 校验 → 重启：续传标记只对下载会话成立（离开下载阶段即消隐），阶段文案逐态推进
  status.payload = { status: 'verifying', progress: 100 * MB, total: 100 * MB, resumedBytes: 40 * MB, version: '9.9.9' }
  await expect(phase).toHaveText('校验中', { timeout: 10000 })
  await expect(resumed).toHaveCount(0)
  status.payload = { status: 'restarting', progress: 100 * MB, total: 100 * MB, resumedBytes: 40 * MB, version: '9.9.9' }
  await expect(phase).toHaveText('重启中', { timeout: 10000 })

  // 换包完成（结果文件落盘）：成功结局块带刷新引导、重试按钮不再出现，徽标与
  // toast 同步；全链只受理一次（重试 = 同一 apply 受理端点）
  status.payload = { status: 'idle', progress: 0, total: 0, version: '9.9.9', result: 'success', resultAt: '2026-11-11T03:04:05Z' }
  const outcome = modal.locator('[data-testid="version-update-outcome"]')
  await expect(outcome.locator('[data-testid="version-update-outcome-phase"]')).toHaveText('更新成功', { timeout: 10000 })
  await expect(outcome.locator('[data-testid="version-update-refresh"]')).toBeVisible()
  await expect(outcome.locator('[data-testid="version-update-retry"]')).toHaveCount(0)
  await expect(badge).toContainText('已更新到 v9.9.9')
  await expect(page.locator('.n-message').filter({ hasText: '已更新到 v9.9.9' }).first()).toBeVisible({ timeout: 5000 })
  expect(applies).toHaveLength(1)
})

test('长 changelog：收起态摘要不顶屏，展开限高内滚，「立即更新」首屏可达', async ({ page }) => {
  await routeStatus(page, { status: 'idle', progress: 0, total: 0, version: '' })
  await page.route('**/api/updates/check*', async (route) => {
    const changelog = Array.from({ length: 120 }, (_, i) => `- 变更条目 ${i}`).join('\n')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog } }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()

  // 标题行循 dsh clTitle 惯例；收起态两行摘要，不随 120 条内容增高
  await expect(card.locator('[data-testid="version-changelog-title"]')).toHaveText('v9.9.9 更新内容')
  const body = card.locator('[data-testid="version-changelog-body"]')
  await expect(body).toBeVisible()
  const collapsedHeight = await body.evaluate(el => el.getBoundingClientRect().height)
  expect(collapsedHeight).toBeLessThanOrEqual(200)
  // 「立即更新」在视口内（首屏可达）
  await expect(card.getByRole('button', { name: '立即更新' })).toBeVisible()

  // 展开态：markdown 渲染（列表符成 li，不再裸露「-」），仍限高内滚
  await card.locator('[data-testid="version-changelog-toggle"]').click()
  const md = card.locator('[data-testid="version-changelog-md"]')
  await expect(md).toBeVisible()
  await expect(md.locator('li')).toHaveCount(120)
  await expect(md).toContainText('变更条目 119')
  const expandedHeight = await body.evaluate(el => el.getBoundingClientRect().height)
  expect(expandedHeight).toBeLessThanOrEqual(200)
  await expect(card.getByRole('button', { name: '立即更新' })).toBeVisible()

  // 收起回摘要
  await card.locator('[data-testid="version-changelog-toggle"]').click()
  await expect(card.locator('[data-testid="version-changelog-toggle"]')).toHaveText('展开完整说明')
})

test('更新内容 markdown 净化渲染与页内锚点切换（P-20261112-2 S1）', async ({ page }) => {
  await routeStatus(page, { status: 'idle', progress: 0, total: 0, version: '' })
  await page.route('**/api/updates/check*', async (route) => {
    // 发布说明真实形态：中英文锚点行 + 小节标题；夹带一段危险 html 验证净化
    const changelog = [
      '[中文](#中文) | [English](#english)',
      '<script>window.__xss = 1</script>',
      '## 中文',
      '- **加粗** 条目',
      '## English',
      '- **bold** entry',
    ].join('\n\n')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog } }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()

  await card.locator('[data-testid="version-changelog-toggle"]').click()
  const md = card.locator('[data-testid="version-changelog-md"]')
  await expect(md).toBeVisible()
  // 净化：脚本剥除、变量不落全局；加粗渲染为 strong，不再裸露标记
  await expect(md.locator('script')).toHaveCount(0)
  expect(await page.evaluate(() => (window as { __xss?: unknown }).__xss)).toBeUndefined()
  await expect(md.locator('strong')).toHaveText(['加粗', 'bold'])
  // heading 挂 slug id，锚点行渲染为页内链接
  await expect(md.locator('h2#english')).toHaveText('English')
  const anchorHref = await md.locator('a', { hasText: 'English' }).first().getAttribute('href')
  expect(anchorHref).toContain('#english')

  // 点锚点：容器内平滑滚动到目标小节，hash 不进 SPA 地址栏（地址逐字不变）
  const urlBefore = page.url()
  await md.locator('a', { hasText: 'English' }).first().click()
  await expect(md.locator('h2#english')).toBeInViewport()
  expect(page.url()).toBe(urlBefore)
  await expect(md).toBeVisible()
})

test('查看发布页外链（P-20261112-2 S2）：标题行右侧新窗直达 Release 页；同行布局不回归，缺失不显', async ({ page }) => {
  await routeStatus(page, { status: 'idle', progress: 0, total: 0, version: '' })
  // 响应可切换：先带 releaseUrl（S2 数据面），再回落缺失形态（旧服务端零回退）
  let withReleaseUrl = true
  await page.route('**/api/updates/check*', async (route) => {
    const data = withReleaseUrl
      ? { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog: '- 修复若干问题', releaseUrl: 'https://github.com/owner/repo/releases/tag/v9.9.9' }
      : { currentVersion: '0.0.1', latestVersion: '9.9.9', hasUpdate: true, changelog: '- 修复若干问题' }
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data }) })
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  await card.locator('.version-update-section > button.panel-btn').first().click()

  // 外链：标题行右侧，新窗 noopener 直达发布页；文案循 dshConsole.clOpenPage 惯例
  const title = card.locator('[data-testid="version-changelog-title"]')
  const link = card.locator('[data-testid="version-release-link"]')
  await expect(title).toHaveText('v9.9.9 更新内容')
  await expect(link).toHaveText('查看发布页')
  await expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/releases/tag/v9.9.9')
  await expect(link).toHaveAttribute('target', '_blank')
  await expect(link).toHaveAttribute('rel', /noopener/)

  // 标题行布局不回归：标题与外链同行（y 重叠）、标题在左外链在右
  const titleBox = await title.boundingBox()
  const linkBox = await link.boundingBox()
  expect(titleBox).toBeTruthy()
  expect(linkBox).toBeTruthy()
  expect(Math.abs(titleBox!.y - linkBox!.y)).toBeLessThan(4)
  expect(titleBox!.x).toBeLessThan(linkBox!.x)

  // 外链在场时展开/收起照常（S1 交互形态不被标题行改动波及）
  await card.locator('[data-testid="version-changelog-toggle"]').click()
  await expect(card.locator('[data-testid="version-changelog-md"]')).toBeVisible()
  await card.locator('[data-testid="version-changelog-toggle"]').click()
  await expect(card.locator('[data-testid="version-changelog-toggle"]')).toHaveText('展开完整说明')

  // releaseUrl 缺失（旧服务端增量字段惯例）：外链不渲染，标题行与渲染照常
  withReleaseUrl = false
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('[data-testid="home-logo"]').click()
  const card2 = page.locator('.version-card')
  await expect(card2).toBeVisible({ timeout: 5000 })
  await card2.locator('.version-update-section > button.panel-btn').first().click()
  await expect(card2.locator('[data-testid="version-changelog-title"]')).toHaveText('v9.9.9 更新内容')
  await expect(card2.locator('[data-testid="version-release-link"]')).toHaveCount(0)
  await expect(card2.locator('[data-testid="version-changelog-toggle"]')).toHaveText('展开完整说明')
})
