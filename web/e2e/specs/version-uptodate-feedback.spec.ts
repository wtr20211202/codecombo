import { test, expect, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 检查更新「已是最新」态反馈强化 E2E（P-20261109-2）：
 *   1. 成功态显著化——hasUpdate=false 时面板渲染「已是最新」成功块
 *      （.version-uptodate：对勾 + 正文色 + 当前版本号插值），不再是无版本号的
 *      单行 .muted 灰字（用户实测：块其实在但被读成「没有任何反馈」）
 *   2. 判断条件统一——只认后端 hasUpdate：latest≠current 但 hasUpdate=false
 *      （当前高于最新形态）不得发「发现新版本」通知；成功块回显当前版本而非
 *      更旧的 latest（旧 latest!==current 字符串兜底的矛盾面）
 *   3. 手动检查成功 toast——一次性；5s 去重窗内再查不叠加
 *   4. 检查中态——请求在途按钮禁用并显示「检查中…」
 *
 * /api/updates/check 走 page.route 改写响应（agent-runtime-badge 同款先例）：
 * 真实外呼 GitHub 不可控（速率限制/版本漂移），机器化钉住判定分支。
 * 面板发出的通知 POST 在浏览器侧拦截记录并本地应答——断言「面板没发」的
 * 同时零残留进共享实例通知中心（不依赖开头清空）。
 */

const CHECK_ROUTE = '**/api/updates/check*'

interface CheckPayload {
  currentVersion: string
  latestVersion?: string
  hasUpdate: boolean
}

/** 可切换响应的 check 路由；gate 非空时挂起全部请求直到 release（检查中态观测窗）。
 *  calls 计到达数——前端 updateCheck store 的 5s 静默首查也走同一端点，故只作下限参考 */
async function routeCheck(page: Page, initial: CheckPayload) {
  const state = {
    payload: initial,
    calls: 0,
    gate: null as Promise<void> | null,
  }
  await page.route(CHECK_ROUTE, async (route) => {
    state.calls++
    if (state.gate) await state.gate
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: state.payload }) })
  })
  return state
}

/** 拦截面板经通知中心 store 发出的 POST /api/notifications：记录载荷并本地应答 */
async function captureNotificationPosts(page: Page): Promise<string[]> {
  const posted: string[] = []
  await page.route('**/api/notifications', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    posted.push(route.request().postData() ?? '')
    await route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: {} }) })
  })
  return posted
}

/** 「已是最新版本」toast 出现次数计数器：逐元素打标只计一次（不受插入粒度/淡出影响，
 *  规避自动重试断言 toHaveCount 在重复 toast 淡出后「自愈」成 1 的假绿） */
async function installUptodateToastCounter(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __uptodateToasts: number }
    w.__uptodateToasts = 0
    const scan = () => {
      document.querySelectorAll<HTMLElement>('.n-message').forEach((el) => {
        if (el.dataset.e2eCounted || !el.textContent?.includes('已是最新版本')) return
        el.dataset.e2eCounted = '1'
        w.__uptodateToasts++
      })
    }
    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true, characterData: true })
  })
}

function uptodateToastCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as unknown as { __uptodateToasts: number }).__uptodateToasts)
}

/** 版本面板经首页 logo 版本弹窗打开（三处入口共享同一 VersionPanel） */
async function openVersionPanel(page: Page) {
  await page.locator('[data-testid="home-logo"]').click()
  const card = page.locator('.version-card')
  await expect(card).toBeVisible({ timeout: 5000 })
  return card
}

test('已是最新：成功块回显当前版本 + 手动一次性 toast；当前高于最新零「发现新版本」通知', async ({ page }) => {
  // 当前高于最新形态：latest≠current 但后端判定 hasUpdate=false
  const check = await routeCheck(page, { currentVersion: '9.9.9', latestVersion: '0.0.1', hasUpdate: false })
  const posted = await captureNotificationPosts(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = await openVersionPanel(page)
  await installUptodateToastCounter(page)
  // 结构定位检查按钮（文案在 检查更新/重新检查/检查中… 间切换，按名定位会中途失配）
  const checkBtn = card.locator('.version-update-section > button.panel-btn').first()
  await expect(checkBtn).toHaveText('检查更新')

  await checkBtn.click()
  // 成功块显著化：对勾图标 + 回显当前版本（不是更旧的 latest）
  await expect(card.locator('.version-uptodate-icon')).toBeVisible()
  await expect(card.locator('.version-uptodate-text')).toHaveText('已是最新版本（v9.9.9）')
  await expect(checkBtn).toHaveText('重新检查')
  // 手动一次性 toast
  await expect.poll(() => uptodateToastCount(page)).toBe(1)

  // 5s 去重窗内再查：面板照常刷新，toast 不叠加
  const callsBefore = check.calls
  await checkBtn.click()
  await expect.poll(() => check.calls).toBeGreaterThan(callsBefore)
  await expect(checkBtn).toBeEnabled()
  await page.waitForTimeout(500)
  expect(await uptodateToastCount(page)).toBe(1)

  // 判断统一：当前高于最新——面板不发「发现新版本」通知、不出「立即更新」
  expect(posted.filter(b => b.includes('发现新版本'))).toHaveLength(0)
  await expect(card.getByRole('button', { name: '立即更新' })).toHaveCount(0)

  // 正对照（证明上面「零 POST」非空转）：后端判定有更新 → 面板必发通知并出「立即更新」
  check.payload = { currentVersion: '9.9.9', latestVersion: '10.0.0', hasUpdate: true }
  await checkBtn.click()
  await expect(card.getByRole('button', { name: '立即更新' })).toBeVisible()
  await expect.poll(() => posted.filter(b => b.includes('发现新版本')).length).toBeGreaterThan(0)
})

test('检查中：请求在途按钮禁用并显示「检查中…」，返回后恢复', async ({ page }) => {
  const check = await routeCheck(page, { currentVersion: '9.9.9', latestVersion: '9.9.9', hasUpdate: false })
  await captureNotificationPosts(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const card = await openVersionPanel(page)
  const checkBtn = card.locator('.version-update-section > button.panel-btn').first()
  await expect(checkBtn).toHaveText('检查更新')

  let release: () => void = () => {}
  check.gate = new Promise<void>((resolve) => { release = resolve })
  await checkBtn.click()
  await expect(checkBtn).toBeDisabled()
  await expect(checkBtn).toHaveText('检查中…')

  check.gate = null
  release()
  await expect(checkBtn).toBeEnabled()
  await expect(checkBtn).toHaveText('重新检查')
  await expect(card.locator('.version-uptodate-text')).toHaveText('已是最新版本（v9.9.9）')
})
