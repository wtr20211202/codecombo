import { test, expect, type Locator, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知条目触屏滑动快捷操作 E2E（P-20261002-98）：
 *   - 真触屏输入滑动（CDP Input.dispatchTouchEvent）：右滑 = 标已读（未读时）、
 *     左滑 = 清除该条（已读才可清，未读横扫不误删）
 *   - 手势中行体跟手位移（transform translateX），松手回弹；<60px 阈值不分发
 *   - 纵向为主滑动让位列表原生滚动（方向判定），不触发动作
 *   - swipe 与 tap 区分：动作条目滑动仅标已读不导航；触屏 tap 保持跳转语义
 *   - 多条折叠组行不做手势；展开后的组员行可滑
 * 通知经 POST /api/notifications 播种（共享实例先清空、结束后再清空，
 * 不残留测试数据）
 */

// 真触屏输入需要上下文开启触摸（CDP 注入的 touch 事件才会走触摸输入管线）
test.use({ hasTouch: true })

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function seed(headers: Record<string, string>, notes: Array<{ title: string; type?: string; category?: string; body?: string; projectId?: string; projectName?: string; action?: string; actionPayload?: string }>) {
  for (const n of notes) {
    const res = await fetch(`${API_BASE}/api/notifications`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...n,
        type: n.type ?? 'info',
        category: n.category ?? 'system',
        body: n.body ?? '',
      }),
    })
    expect(res.ok).toBeTruthy()
  }
}

async function openPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

function rowOf(page: Page, title: string): Locator {
  return page.locator('.nc-item:not(.nc-sub)').filter({ hasText: title })
}

async function rowCenter(row: Locator): Promise<{ x: number; y: number }> {
  const box = await row.boundingBox()
  if (!box) throw new Error('swipe target row not visible')
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

// 真触屏滑动：touchStart → N 段 touchMove → touchEnd（CDP 注入，走真实输入管线，
// 触发组件 touch 监听与浏览器 click 合成判定）。hold=true 时停在移动末尾不松手
// （供断言跟手位移），返回收尾函数补 touchEnd
async function touchSwipe(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  opts: { steps?: number; hold?: boolean } = {},
): Promise<() => Promise<void>> {
  const steps = opts.steps ?? 5
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: from.x, y: from.y, id: 1 }],
  })
  for (let i = 1; i <= steps; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: from.x + (dx * i) / steps, y: from.y + (dy * i) / steps, id: 1 }],
    })
  }
  const finish = async () => {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }
  if (opts.hold) return finish
  await finish()
  return async () => { /* 已松手 */ }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  // 清理本 spec 遗留的 uiState（tap 跳转链会持久化 changes 侧栏开态，跨文件不串扰）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

test('右滑未读单条：手势中行体跟手位移，≥阈值松手标已读（行保留）', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-swipe-right-甲' }])

  await openPanel(page)
  const row = rowOf(page, 'e2e-swipe-right-甲')
  await expect(row).toHaveClass(/unread/, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toHaveText('1')

  // 子阈值滑动（30px < 60px 阈值）：不分发动作，行保持未读
  await touchSwipe(page, await rowCenter(row), 30, 0)
  await expect(row).toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText('1')
  await expect(row).toHaveCSS('transform', 'none')

  // 手势中（未松手）：行体跟手位移 transform translateX(80px)，动作未分发
  const finish = await touchSwipe(page, await rowCenter(row), 80, 0, { hold: true })
  await expect(row).toHaveCSS('transform', /matrix\(1, 0, 0, 1, 80, 0\)/)
  await expect(row).toHaveClass(/unread/)

  // 松手：达到 60px 阈值 → 标已读（不是清除，行仍在）；位移回弹归零
  await finish()
  await expect(row).not.toHaveClass(/unread/)
  await expect(row).toBeVisible()
  await expect(page.locator('.notify-badge')).toHaveCount(0)
  await expect(row).toHaveCSS('transform', 'none')
})

test('左滑清除：已读才可清，未读横扫不误删', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-swipe-left-甲' }, { title: 'e2e-swipe-left-乙' }])

  await openPanel(page)
  const jia = rowOf(page, 'e2e-swipe-left-甲')
  const yi = rowOf(page, 'e2e-swipe-left-乙')
  await expect(jia).toHaveClass(/unread/, { timeout: 3000 })

  // 未读乙左滑：守护拦截——不清除、不标已读
  await touchSwipe(page, await rowCenter(yi), -80, 0)
  await expect(yi).toBeVisible()
  await expect(yi).toHaveClass(/unread/)
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(2)

  // 点击甲（既有点击语义：标已读）→ 已读甲左滑 → 清除，乙保留
  await jia.click()
  await expect(jia).not.toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText('1')
  await touchSwipe(page, await rowCenter(jia), -80, 0)
  await expect(jia).toHaveCount(0)
  await expect(yi).toBeVisible()
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(1)
})

test('纵向为主滑动让位滚动：不触发标已读/清除', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [{ title: 'e2e-swipe-vert-甲' }, { title: 'e2e-swipe-vert-乙' }])

  await openPanel(page)
  const row = rowOf(page, 'e2e-swipe-vert-甲')
  await expect(row).toHaveClass(/unread/, { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toHaveText('2')

  // 纵向为主（dy 120 > dx 30）：方向判定归滚动车道，无动作无位移残留
  await touchSwipe(page, await rowCenter(row), 30, 120)
  await expect(row).toHaveClass(/unread/)
  await expect(row).toBeVisible()
  await expect(page.locator('.notify-badge')).toHaveText('2')
  await expect(page.locator('.nc-item:not(.nc-sub)')).toHaveCount(2)
  await expect(row).toHaveCSS('transform', 'none')
})

test('动作条目 swipe 与 tap 区分：触屏 tap 保持跳转，右滑仅标已读不导航', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id).toBeTruthy()
  // 两条同形状动作通知（标题不同不聚合）：一条验触屏 tap 跳转、一条验滑动不跳转。
  // 顺序固定为先 tap 后滑：Chromium 输入管线对 CDP 滑动之后的首个触屏 tap 不合成
  // click（管线 artifact——组件完全不介入的行上同样复现，与手势实现无关），
  // 滑动先行会让 tap 断言失真；真实设备滑动后 tap 正常
  await seed(headers, [
    {
      title: 'e2e-swipe-jump-tap',
      type: 'success',
      category: 'clone',
      body: '已添加到项目列表',
      projectId: proj!.id,
      projectName: 'simple-coding',
      action: 'panel',
      actionPayload: 'changes',
    },
    {
      title: 'e2e-swipe-jump-swipe',
      type: 'success',
      category: 'clone',
      body: '已添加到项目列表',
      projectId: proj!.id,
      projectName: 'simple-coding',
      action: 'panel',
      actionPayload: 'changes',
    },
  ])

  await openPanel(page)
  const tapRow = rowOf(page, 'e2e-swipe-jump-tap')
  const swipedRow = rowOf(page, 'e2e-swipe-jump-swipe')
  await expect(tapRow).toHaveClass(/unread/, { timeout: 3000 })

  // rail「提交」是 toggle（uiState 跨用例恢复态不定，changes-filter.spec 同款归一化）：
  // 先归到关闭态，tap 触发的 togglePanel('changes') 翻转才是确定性「打开」
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('.commit-panel').isVisible().catch(() => false))) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible().catch(() => false)).toBe(false)

  // 触屏 tap（零位移 touch）：不误触滑动手势，走既有点击跳转（切项目+开变更面板）
  const center = await rowCenter(tapRow)
  await page.touchscreen.tap(center.x, center.y)
  await expect(page.locator('.nc-card')).toBeHidden({ timeout: 5000 })
  await expect(page.locator('#side-panel .commit-panel')).toBeVisible({ timeout: 10000 })

  // 重开面板右滑另一条：只标已读——面板不关、跳转分发不被触发
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await touchSwipe(page, await rowCenter(swipedRow), 80, 0)
  await expect(swipedRow).not.toHaveClass(/unread/)
  await expect(page.locator('.nc-card')).toBeVisible()
})

test('折叠组行不做手势；展开组员行可滑（组内单条已读/清除）', async ({ page }) => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await seed(headers, [
    { title: 'e2e-swipe-group', body: 'same' },
    { title: 'e2e-swipe-group', body: 'same' },
  ])

  await openPanel(page)
  const group = rowOf(page, 'e2e-swipe-group')
  await expect(group).toContainText('×2', { timeout: 3000 })
  await expect(page.locator('.notify-badge')).toHaveText('2')

  // 折叠组行右滑：不做手势（整组动作有行内按钮承担），组行原样
  await touchSwipe(page, await rowCenter(group), 80, 0)
  await expect(group).toContainText('×2')
  await expect(group).toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText('2')

  // 点击展开 → 组员行右滑标已读（组行因另一条未读保持未读标识）
  await group.click()
  const members = page.locator('.nc-sub')
  await expect(members).toHaveCount(2)
  await touchSwipe(page, await rowCenter(members.nth(0)), 80, 0)
  await expect(members.nth(0)).not.toHaveClass(/unread/)
  await expect(members.nth(1)).toHaveClass(/unread/)
  await expect(group).toHaveClass(/unread/)
  await expect(page.locator('.notify-badge')).toHaveText('1')

  // 已读组员左滑清除：组内剩 1 条 → 组行回落为普通单条行（×N 徽标消失）
  await touchSwipe(page, await rowCenter(members.nth(0)), -80, 0)
  await expect(page.locator('.nc-sub')).toHaveCount(0)
  await expect(rowOf(page, 'e2e-swipe-group')).toHaveCount(1)
  await expect(page.locator('.notify-badge')).toHaveText('1')
})
