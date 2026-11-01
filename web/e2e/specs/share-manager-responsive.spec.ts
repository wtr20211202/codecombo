import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 分享管理器响应式与行操作收口（P-20261020-9）E2E：
 *   1. 「更多」菜单全动作：口令/留言/刷新快照（仅 frozen 行）/轮换/撤销俱在，
 *      各自唤起既有弹窗；撤销仍走确认弹窗（语义不变）；复制/打开/二维码保留为
 *      行内常用图标
 *   2. 四宽度断点（390/768/1024/1440）：页面与卡片零横向溢出、文本列不被压扁
 *      （表格内部横向滚动承载溢出）、固定右操作列让「更多」始终在视口内、
 *      工具栏与类别筛选行换行
 *   3. 窄屏批量回归：390px 下勾选列（fixed:left）+ 表头全选 + 批量撤销链路
 * 共享实例的全局分享列表（workers=1 串行），beforeEach/afterEach 清空保证确定性
 */

const BASE = API_BASE
const PROJECT_NAME = 'simple-coding'
const LIVE_TARGET = 'docs/design/polish-rounds.md'
const FROZEN_TARGET = 'docs/design/share-service.md'
const LIVE_NAME = 'polish-rounds.md'
const FROZEN_NAME = 'share-service.md'
const SNIPPET_CONTENT = 'SCRESP responsive layout snippet\nsecond line of snippet body'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部分享（服务端全局状态，保证确定性） */
async function cleanupShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/share`, { headers })
  const list = ((await res.json()) as { data?: { token: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/share/${s.token}`, { headers })
  }
}

async function getProjectId(request: APIRequestContext, headers: Record<string, string>): Promise<string> {
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const projects = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = projects.find(x => x.name === PROJECT_NAME)
  if (!p) throw new Error(`project ${PROJECT_NAME} not found`)
  return p.id
}

/** 三条形态齐全的分享：live 文件 + frozen 文件（「更多」里有刷新）+ 片段。
 *  frozen 行显式带 7 天窗口：倒数计时是「有效期」独立列的断言面（P-20261020-10
 *  把倒计时从类型列拆出后，无窗口行只渲染「—」） */
async function seedShares(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const projectId = await getProjectId(request, headers)
  const live = await request.post(`${BASE}/api/share`, { headers, data: { projectId, path: LIVE_TARGET } })
  expect(live.ok(), await live.text()).toBeTruthy()
  const frozen = await request.post(`${BASE}/api/share`, {
    headers, data: { projectId, path: FROZEN_TARGET, mode: 'frozen', ttl: '7d' },
  })
  expect(frozen.ok(), await frozen.text()).toBeTruthy()
  const snippet = await request.post(`${BASE}/api/share/snippet`, { headers, data: { content: SNIPPET_CONTENT } })
  expect(snippet.ok(), await snippet.text()).toBeTruthy()
}

async function openManager(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await projectCardByName(page, PROJECT_NAME).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-share-manager"]').click()
  await expect(page.locator('.sm-card table')).toBeVisible({ timeout: 10000 })
}

/** 窄屏抽屉可能继承上一用例的开合态，盖住主区时先收起 */
async function dismissOverlays(page: Page): Promise<void> {
  // 视口切换后 matchMedia 变更 → 窄屏形态重渲染可能晚于一次评估：给足等待，
  // 否则「检查时还没有遮罩、点击时抽屉已盖住主区」
  const mask = page.locator('[data-testid="side-drawer-mask"]')
  await mask.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { /* 无抽屉 */ })
  if (await mask.isVisible().catch(() => false)) {
    // 遮罩左段被 280px 抽屉本体盖住（点 x=4 会命中抽屉、点击被吞），改点底部
    // 切换器的「文件」按钮收起——togglePanel 语义与点遮罩等价且几何稳定
    await page.locator('[data-testid="rail-files"]').click({ force: true }).catch(() => { /* 下一轮 */ })
    await expect(mask).toBeHidden({ timeout: 3000 }).catch(() => { /* 已收起 */ })
  }
  const close = page.locator('[data-testid="bottom-panel-close"]')
  if (await close.isVisible().catch(() => false)) await close.click().catch(() => { /* 已收起 */ })
}

/** 遮罩收起侧栏会写回服务端 uiState（跨用例共享）——用例收尾回桌面宽度并把
 *  files 视图归一化到开启，避免污染后续依赖「文件树可见」的用例 */
async function restoreSidePanel(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 720 }).catch(() => { /* 页面已关 */ })
  const railFiles = page.locator('[data-testid="rail-files"]')
  // 视口切回桌面后活动栏下一帧才渲染：等它可见再判 active，否则会漏恢复
  await railFiles.waitFor({ state: 'visible', timeout: 3000 }).catch(() => { /* 无活动栏 */ })
  if (!(await railFiles.isVisible().catch(() => false))) return
  for (let i = 0; i < 3; i++) {
    if (await railFiles.evaluate(el => el.classList.contains('active')).catch(() => false)) break
    // 收尾属清理动作：force 越过可能残留的弹层，确保 uiState 归一化
    await railFiles.click({ force: true }).catch(() => { /* 下一轮重试 */ })
    await page.waitForTimeout(150)
  }
  // uiState 写端是 500ms 防抖；等它冲刷后再让页关闭（关页不保证 beforeunload）
  await page.waitForTimeout(600)
}

function rowByName(page: Page, name: string) {
  return page.locator('.sm-card tbody tr').filter({ hasText: name }).first()
}

function dropdownMenu(page: Page) {
  return page.locator('.n-dropdown-menu').last()
}

test.beforeEach(async ({ request }) => {
  await cleanupShares(request)
})

test.afterEach(async ({ request, page }) => {
  await restoreSidePanel(page)
  await cleanupShares(request)
})

test('更多菜单收口：口令/留言/刷新/轮换/撤销全在，撤销仍走确认', async ({ page, request }) => {
  test.setTimeout(60_000)
  await seedShares(request)
  await openManager(page)

  const frozenRow = rowByName(page, FROZEN_NAME)
  const liveRow = rowByName(page, LIVE_NAME)
  await expect(frozenRow).toBeVisible()

  // 常用动作保留为行内图标（分发高频，不该藏进菜单）
  await expect(frozenRow.locator('button[aria-label="复制链接"]')).toBeVisible()
  await expect(frozenRow.locator('button[aria-label="打开"]')).toBeVisible()
  await expect(frozenRow.locator('button[aria-label="二维码"]')).toBeVisible()

  // 触发钮是纯图标：title 悬停 + aria-label 读屏双提示
  const more = frozenRow.getByTestId('sm-more-btn')
  await expect(more).toHaveAttribute('aria-label', '更多操作')
  await expect(more).toHaveAttribute('title', '更多操作')

  // ① 口令：菜单项带文字标签 → 既有口令弹层
  await more.click()
  const menu = dropdownMenu(page)
  await expect(menu).toBeVisible()
  for (const label of ['访问口令', '留言', '刷新快照', '轮换', '撤销']) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible()
  }
  await menu.getByText('访问口令', { exact: true }).click()
  const passModal = page.locator('.sm-pass-modal')
  await expect(passModal).toBeVisible()
  await expect(passModal).toContainText(FROZEN_NAME)
  await passModal.getByRole('button', { name: '取消' }).click()
  await expect(passModal).toBeHidden()

  // ② 留言：既有留言面板
  await more.click()
  await dropdownMenu(page).getByText('留言', { exact: true }).click()
  const msgModal = page.getByTestId('sm-msg-modal')
  await expect(msgModal).toBeVisible()
  await msgModal.getByRole('button', { name: '关闭' }).click()
  await expect(msgModal).toBeHidden()

  // ③ 刷新快照：仅 frozen 行有；确认弹窗交代保留期重置
  await more.click()
  await dropdownMenu(page).getByText('刷新快照', { exact: true }).click()
  const refreshDlg = page.locator('.n-dialog')
  await expect(refreshDlg).toBeVisible()
  await expect(refreshDlg).toContainText('保留期重置为 30 天')
  await refreshDlg.getByRole('button', { name: '取消' }).click()
  await expect(refreshDlg).toBeHidden()

  // ④ 轮换：确认弹窗语义不变（旧链即刻作废）
  await more.click()
  await dropdownMenu(page).getByText('轮换', { exact: true }).click()
  const rotateDlg = page.locator('.n-dialog')
  await expect(rotateDlg).toBeVisible()
  await expect(rotateDlg).toContainText('旧链接立即作废')
  await rotateDlg.getByRole('button', { name: '取消' }).click()
  await expect(rotateDlg).toBeHidden()

  // ⑤ 撤销：先取消 → 行仍在；再确认 → 行消失 + toast（确认语义不变）
  await more.click()
  await dropdownMenu(page).getByText('撤销', { exact: true }).click()
  const revokeDlg = page.locator('.n-dialog')
  await expect(revokeDlg).toContainText('撤销后短链立即失效')
  await revokeDlg.getByRole('button', { name: '取消' }).click()
  await expect(revokeDlg).toBeHidden()
  await expect(frozenRow).toBeVisible()

  await more.click()
  await dropdownMenu(page).getByText('撤销', { exact: true }).click()
  await page.locator('.n-dialog').getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: `已撤销 ${FROZEN_NAME} 的分享` })).toBeVisible({ timeout: 10000 })
  await expect(frozenRow).toHaveCount(0)

  // live 行没有「刷新快照」（原地刷新只对冻结副本有意义）
  await liveRow.getByTestId('sm-more-btn').click()
  await expect(dropdownMenu(page).getByText('轮换', { exact: true })).toBeVisible()
  await expect(dropdownMenu(page).getByText('刷新快照', { exact: true })).toHaveCount(0)
})

test('四宽度断点：零横向溢出、文本列不压扁、固定操作列与换行工具栏', async ({ page, request }) => {
  test.setTimeout(60_000)
  await seedShares(request)
  await openManager(page)

  const widths = [390, 768, 1024, 1440]
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 })
    await dismissOverlays(page)
    await expect(page.locator('.share-manager')).toBeVisible()

    // 页面与面板都不横向溢出（横向溢出只允许发生在表格自身滚动容器内）
    await expect.poll(() => page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ), `document @${width}`).toBeLessThanOrEqual(1)
    await expect.poll(() => page.locator('.share-manager').evaluate(
      el => el.scrollWidth - el.clientWidth,
    ), `panel @${width}`).toBeLessThanOrEqual(1)

    // 文本列有确定宽度（名称 170 / 路径 190）：不再被剩余空间挤成几个字；
    // 路径列 max-width + title 悬停兜底保持
    await expect.poll(async () => {
      const box = await rowByName(page, LIVE_NAME).locator('.sc-share-path').boundingBox()
      return box ? Math.round(box.width) : 0
    }, `path width @${width}`).toBeGreaterThanOrEqual(150)
    await expect(rowByName(page, LIVE_NAME).locator('.sc-share-path')).toHaveAttribute('title', LIVE_TARGET)

    // 类型徽标纵向堆叠且列内不横向溢出（frozen 行 = 类型标 + 冻结标）；
    // 倒数计时自 P-20261020-10 起独立成「有效期」列，不再随类型列堆叠
    const typeCol = rowByName(page, FROZEN_NAME).locator('.sc-share-type-col')
    expect(await typeCol.evaluate(el => el.scrollWidth - el.clientWidth), `type overflow @${width}`).toBeLessThanOrEqual(1)
    const badgeBox = await typeCol.locator('.n-tag').first().boundingBox()
    const frozenBox = await typeCol.locator('.n-tag').nth(1).boundingBox()
    expect(badgeBox && frozenBox, `type stack @${width}`).toBeTruthy()
    expect(frozenBox!.y, `frozen badge below type badge @${width}`).toBeGreaterThanOrEqual(badgeBox!.y + badgeBox!.height - 1)
    // 有效期列：该行倒计时真实渲染（列宽可排序/筛选的前提，非空占位）
    const countBox = await rowByName(page, FROZEN_NAME).locator('[data-testid="sm-countdown"]').boundingBox()
    expect(countBox, `countdown @${width}`).not.toBeNull()
    expect(countBox!.width * countBox!.height, `countdown size @${width}`).toBeGreaterThan(0)

    // 固定右操作列：无论表格滚到哪里，「更多」都在视口内可点
    const more = page.getByTestId('sm-more-btn').first()
    await expect(more).toBeVisible()
    const moreBox = await more.boundingBox()
    expect(moreBox, `more box @${width}`).not.toBeNull()
    expect(moreBox!.x).toBeGreaterThanOrEqual(0)
    expect(moreBox!.x + moreBox!.width).toBeLessThanOrEqual(width + 1)

    // 视口放不下列宽合计时走表格内横向滚动（scroll-x 生效），而不是压缩列
    if (width <= 1024) {
      const overflow = await page.locator('.sm-card .n-data-table-base-table-body .n-scrollbar-container').evaluate(
        el => el.scrollWidth - el.clientWidth,
      )
      expect(overflow, `table scroll @${width}`).toBeGreaterThan(10)
    }
  }

  // 390px：工具栏动作组换到标题下方，类别徽标换到搜索框下方
  await page.setViewportSize({ width: 390, height: 900 })
  await dismissOverlays(page)
  const textBox = await page.locator('.sm-toolbar-text').boundingBox()
  const actionsBox = await page.locator('.sm-toolbar-actions').boundingBox()
  expect(textBox, 'toolbar text box').not.toBeNull()
  expect(actionsBox, 'toolbar actions box').not.toBeNull()
  expect(actionsBox!.y).toBeGreaterThan(textBox!.y + textBox!.height - 1)

  const inputBox = await page.locator('[data-testid="sm-filter-search"]').boundingBox()
  const kindsBox = await page.locator('[data-testid="sm-filter-kinds"]').boundingBox()
  expect(inputBox, 'filter input box').not.toBeNull()
  expect(kindsBox, 'filter kinds box').not.toBeNull()
  expect(kindsBox!.y).toBeGreaterThan(inputBox!.y + inputBox!.height - 1)

  // 窄屏打开「更多」：下拉自身也在视口内（不被右缘裁切）
  await page.getByTestId('sm-more-btn').first().click()
  const menu = dropdownMenu(page)
  await expect(menu).toBeVisible()
  const menuBox = await menu.boundingBox()
  expect(menuBox, 'dropdown box').not.toBeNull()
  expect(menuBox!.x).toBeGreaterThanOrEqual(0)
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(391)
})

test('窄屏批量回归：勾选列常驻 + 表头全选 + 批量撤销', async ({ page, request }) => {
  test.setTimeout(60_000)
  await seedShares(request)
  await openManager(page)

  const rows = page.locator('.sm-card tbody tr')
  await expect(rows).toHaveCount(3)
  await page.getByTestId('sm-bulk-enter').click()
  await expect(page.getByTestId('sm-bulk-bar')).toBeVisible()

  // 收缩到手机宽度：批量态不因窄屏失效
  await page.setViewportSize({ width: 390, height: 900 })
  await dismissOverlays(page)
  await expect(page.locator('.sm-table')).toBeVisible()

  // fixed:left 勾选列在视口内可见；操作列 fixed:right 同样在手边
  const firstCheckbox = rows.first().locator('.n-checkbox')
  await expect(firstCheckbox).toBeVisible()
  const cbBox = await firstCheckbox.boundingBox()
  expect(cbBox, 'row checkbox box').not.toBeNull()
  expect(cbBox!.x + cbBox!.width).toBeLessThanOrEqual(391)
  await expect(page.getByTestId('sm-more-btn').first()).toBeVisible()

  // 表头全选 → 计数 3 → 单次确认撤销
  await page.locator('.sm-card thead .n-checkbox').click()
  await expect(page.getByTestId('sm-bulk-count')).toHaveText('已选 3 条')
  await page.getByTestId('sm-bulk-revoke').click()
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toContainText('将撤销 3 条分享')
  await dlg.getByRole('button', { name: '撤销所选' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已撤销 3 条分享' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.sm-card .n-empty')).toBeVisible({ timeout: 10000 })
})
