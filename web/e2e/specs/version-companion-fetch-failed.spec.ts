import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 更新伴随校验资产拉取失败透出 E2E（P-20261109-9）：
 *   1. check 旗标透出——hasUpdate + companionFetchFailed 时版本面板即时渲染告警块
 *      （role=alert，逐资产原因如实透出），「立即更新」保持可点（否决置灰：点击后端
 *      先 skipCache 重拉，瞬时失败不该伪装成不可用）
 *   2. 点击被拒——apply 的稳定拒绝原文（errmarkers UpdateCompanionFetchFailedTemplate）
 *      经真实拦截器 KNOWN_ERROR_I18N 映射为本地化可行动文案且带原因（原因段内嵌的 OS
 *      网络原文 i/o timeout 不被通用网络条目截走），由面板自出 toast——apply 以 silent
 *      发起：拦截器错误 toast 只在项目页外壳注入 message API 后才有，本例走的首页入口
 *      原本被拒时零反馈（首轮定向 e2e 实锚）
 *   3. 拒绝后面板静默同步告警原因（后端重拉已刷新缓存），按钮仍可点可再试
 *   4. 受理请求在途（后端受理前同步重拉，P-20261109-10 异步受理下该段最长约 20s）
 *      ——按钮禁用+「更新中…」防连点，全局徽标不出（未受理；09-10 语义）
 *   5. 受理前拒绝 = 服务端受理前落账的 failed 态（09-10 形态）——结局块「上次更新」
 *      回显原文（store.start 探测快照），开始更新通知零 POST（服务端单一发射）
 *
 * /api/updates/check、/api/updates/apply、/api/updates/status 走 page.route 改写
 *（version-uptodate-feedback 同款先例）：真实外呼 GitHub 不可控；apply 必须拦截——
 * 放行会让共享实例真去自更新。面板经通知中心 store 发出的 POST 在浏览器侧拦截并
 * 本地应答，零残留进共享实例。
 * 「同步不重复发现新版本通知」由 vitest（VersionPanel.test.ts）钉死：updateCheck
 * store 5s 静默首查会发同文案通知，e2e 计数分不开两路来源，此处不重复断言
 */

const CHECK_ROUTE = '**/api/updates/check*'
const APPLY_ROUTE = '**/api/updates/apply'
const STATUS_ROUTE = '**/api/updates/status*'

const STALE_REASON = 'checksum: status 503 (after 3 attempts)'
const FRESH_REASON = 'checksum: dial tcp: i/o timeout (after 3 attempts)'
// 服务端受理前拒绝原文（errmarkers UpdateCompanionFetchFailedTemplate 形态，
// 与 manager errMsg 落账同串）
const REFUSAL = `update verification failed: companion asset fetch failed: ${FRESH_REASON}; retry or set CC_UPDATE_ALLOW_UNVERIFIED=1 to override`
const IDLE_STATUS = { status: 'idle', progress: 0, total: 0, version: '' }

function flagged(reason: string) {
  return {
    currentVersion: '0.0.1',
    latestVersion: '0.0.2',
    hasUpdate: true,
    companionFetchFailed: true,
    companionFetchError: reason,
  }
}

/** 拦截面板经通知中心 store 发出的 POST /api/notifications 并本地应答（零残留） */
async function stubNotificationPosts(page: Page) {
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
}

/** 版本面板经首页 logo 版本弹窗打开（三处入口共享同一 VersionPanel） */
async function openVersionPanel(page: Page) {
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  return card
}

test('伴随校验资产未取到：面板即时告警带原因，立即更新保持可点；被拒后本地化 toast 带原因并同步告警', async ({ page }) => {
  let releaseApply: () => void = () => {}
  const applyGate = new Promise<void>((resolve) => { releaseApply = resolve })
  const state = {
    payload: flagged(STALE_REASON),
    applyCalls: 0,
    status: IDLE_STATUS as Record<string, unknown>,
  }
  await page.route(CHECK_ROUTE, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.payload }) })
  })
  // 状态机快照（09-10 updateProgress store：面板挂载同步 + 受理被拒后探测一次）
  await page.route(STATUS_ROUTE, async (route) => {
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.status }) })
  })
  await page.route(APPLY_ROUTE, async (route) => {
    state.applyCalls++
    // 受理前同步重拉在途窗（真实形态最长约 20s）：放行前观测按钮反馈
    await applyGate
    // 后端重拉后仍失败：缓存随之刷新为新原因（面板静默同步的数据源）；拒绝在
    // 受理前落账状态机 failed+errMsg（/updates/status 诊断落点）
    state.payload = flagged(FRESH_REASON)
    state.status = { status: 'failed', progress: 0, total: 0, version: '0.0.2', error: REFUSAL }
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: REFUSAL }) })
  })
  await stubNotificationPosts(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = await openVersionPanel(page)
  await card.locator('.version-update-section > button.panel-btn').first().click()

  // 1. 旗标透出：告警块 + 原因；「立即更新」在场且可点
  const warn = card.locator('.version-companion-warn')
  await expect(warn).toBeVisible()
  await expect(warn).toHaveAttribute('role', 'alert')
  await expect(warn).toContainText('此刻更新将被拒')
  await expect(card.locator('.version-companion-warn-reason')).toHaveText(`原因：${STALE_REASON}`)
  const updateNow = card.locator('[data-testid="version-update-now"]')
  await expect(updateNow).toHaveText('立即更新')
  await expect(updateNow).toBeEnabled()

  // 2. 受理请求在途（服务端受理前重拉）：按钮禁用 +「更新中…」；未受理，全局徽标不出
  await updateNow.click()
  await expect(updateNow).toBeDisabled()
  await expect(updateNow).toHaveText('更新中…')
  await expect(page.locator('[data-testid="update-progress-badge"]')).toHaveCount(0)
  releaseApply()

  // 3. 被拒：本地化 toast 带原因（内嵌 i/o timeout 不被通用网络条目截走）
  const toast = page.locator('.n-message').filter({ hasText: '伴随校验资产' })
  await expect(toast).toBeVisible()
  await expect(toast).toContainText(FRESH_REASON)
  await expect(toast).toContainText('CC_UPDATE_ALLOW_UNVERIFIED=1')
  expect(state.applyCalls).toBe(1)

  // 4. 告警原因静默同步为重拉后的新原因；按钮恢复可点（可再试）
  await expect(card.locator('.version-companion-warn-reason')).toHaveText(`原因：${FRESH_REASON}`)
  await expect(updateNow).toHaveText('立即更新')
  await expect(updateNow).toBeEnabled()

  // 5. 受理前拒绝的服务端落账经 store 探测快照回显：结局块「上次更新」带原文；
  //    未受理不跟踪——全局徽标仍不出
  await expect(card.locator('[data-testid="version-update-outcome-phase"]')).toHaveText('更新失败')
  await expect(card.locator('[data-testid="version-update-outcome-reason"]'))
    .toContainText(`companion asset fetch failed: ${FRESH_REASON}`)
  await expect(page.locator('[data-testid="update-progress-badge"]')).toHaveCount(0)
})

test('伴随校验资产齐全：有更新时不渲染告警块（零负担对照）', async ({ page }) => {
  await page.route(CHECK_ROUTE, async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ data: { currentVersion: '0.0.1', latestVersion: '0.0.2', hasUpdate: true } }),
    })
  })
  // 状态机空闲（不受共享实例实况影响）；apply 兜底拦截：本例不点更新，防误触真实自更新
  await page.route(STATUS_ROUTE, route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: IDLE_STATUS }) }))
  await page.route(APPLY_ROUTE, route => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"blocked in e2e"}' }))
  await stubNotificationPosts(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = await openVersionPanel(page)
  await card.locator('.version-update-section > button.panel-btn').first().click()
  await expect(card.getByRole('button', { name: '立即更新' })).toBeVisible()
  await expect(card.locator('.version-companion-warn')).toHaveCount(0)
})
