import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 实例活动热力图 E2E（P-20261003-37）：真实服务端全链路——
 *   补档触发日报（POST /api/reports/daily/run 历史日）→ 发报链随存档顺带
 *   upsert 实例活动序列行 → GET /api/reports/activity 可查 → 值班大屏热力图卡
 *   （格子数 = 窗口公式、补档日色阶非零、悬停 title 显当日三项明细、today 格
 *   描边方位锚 P-20261004-118）。
 * 聚合/滚动清理/append 幂等由 Go 单测锁定（server/store/activityday_test.go、
 * server/report/module_test.go），本用例锁端口形状与前端渲染闭环。
 * 触发口选历史日补档（不发通知，不污染通知中心）：从种子项目提交日志取
 * 热力图窗口（近 13 周）内的提交日，该日聚合必非空。
 * 不残留测试数据：补档行无删除口（365 天滚动保留语义），经 upsert 幂等。
 */

interface CommitInfo { date?: string }
interface ActivityRow { date?: string; commits?: number; sessions?: number; commands?: number }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** Date → 服务器本地 YYYY-MM-DD（补档触发口与序列行日期同一时区口径） */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** 复刻卡片窗口公式（近 days 天、起点对齐周日，逐日步进免 DST 假设）：
 *  断言格子数与组件渲染一致；days = 周档 ×7（13/26/52 三档，P-20261004-106） */
function expectedCellCount(now: Date, days = 91): number {
  const start = new Date(now)
  start.setDate(start.getDate() - (days - 1))
  start.setDate(start.getDate() - start.getDay())
  let n = 0
  for (const c = new Date(start); c <= now; c.setDate(c.getDate() + 1)) n++
  return n
}

let seedDate = ''
let seedRow: ActivityRow = {}

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 目标项目（e2e-restart.sh 预置的 simple-coding 卡片，真实 git 仓库——
  // 按名锁定，git-test 种子项目的历史不保证窗口内有提交）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id, '种子项目 simple-coding 应存在').toBeTruthy()
  const projId = proj!.id!

  // 从提交日志取热力图窗口内（近 80 天）的候选提交日，历史日优先（补历史档
  // 不投递通知，零副作用），逐个补档直到聚合非空
  const logRes = await fetch(`${API_BASE}/api/projects/${projId}/log?limit=50`, { headers })
  const commits = ((await logRes.json()) as { data?: CommitInfo[] }).data || []
  expect(commits.length, '种子项目应有提交历史').toBeGreaterThan(0)
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - 80)
  const cutoffStr = localDate(cutoff)
  const today = localDate(new Date())
  const candidates = [...new Set(commits.map(c => localDate(new Date(c.date!))))]
    .filter(d => d >= cutoffStr)
    .sort()
    .reverse()
    .sort((a, b) => (a === today ? 1 : 0) - (b === today ? 1 : 0)) // 历史日优先

  for (const date of candidates.slice(0, 5)) {
    const runRes = await fetch(`${API_BASE}/api/reports/daily/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date }),
    })
    expect(runRes.ok).toBeTruthy()
    const run = (await runRes.json()) as { sent?: number }
    if ((run.sent ?? 0) > 0) {
      seedDate = date
      break
    }
  }
  expect(seedDate, '窗口内至少一个提交日的聚合非空（补档成功）').toBeTruthy()

  // 读回该日活动行（发报链随存档顺带写入的旁路投影）
  const actRes = await fetch(`${API_BASE}/api/reports/activity?days=91`, { headers })
  expect(actRes.ok).toBeTruthy()
  const rows = ((await actRes.json()) as { data?: ActivityRow[] }).data || []
  const mine = rows.find(r => r.date === seedDate)
  expect(mine, `活动序列应含 ${seedDate}`).toBeTruthy()
  seedRow = mine!
})

test.afterAll(async () => {
  // 兜底清通知（仅当候选日全部耗尽回落到「今天」补档时才会投递；历史日
  // 补档不投递，此清理为无操作）
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('活动序列端口：升序 + days 截断取最新段', async () => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/reports/activity`, { headers })
  expect(res.ok).toBeTruthy()
  const rows = ((await res.json()) as { data?: ActivityRow[] }).data || []
  expect(rows.length).toBeGreaterThanOrEqual(1)
  for (let i = 1; i < rows.length; i++) {
    expect(rows[i].date! > rows[i - 1].date!, `升序被破坏于 ${rows[i].date}`).toBe(true)
  }
  // 补档行三项数值形状：非负整数
  for (const r of [seedRow]) {
    expect(r.commits).toBeGreaterThanOrEqual(0)
    expect(r.sessions).toBeGreaterThanOrEqual(0)
    expect(r.commands).toBeGreaterThanOrEqual(0)
  }

  // days 截断：取升序尾段
  const tailRes = await fetch(`${API_BASE}/api/reports/activity?days=1`, { headers })
  const tail = ((await tailRes.json()) as { data?: ActivityRow[] }).data || []
  expect(tail.length).toBeLessThanOrEqual(1)
})

test('热力图卡：格子数合窗口公式、补档日色阶非零、悬停显当日明细', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  const card = page.locator('[data-testid="monitor-activity-card"]')
  await expect(card).toBeVisible({ timeout: 5000 })
  await expect(card).toContainText('实例活动')

  // 格子数 = 窗口公式（默认 13 周档，起点对齐周日的版式，尾部列止于今天）
  const grid = page.locator('[data-testid="monitor-activity-grid"]')
  await expect(grid.locator('.ahc-cell')).toHaveCount(expectedCellCount(new Date(), 91), { timeout: 5000 })

  // today 方位锚（P-20261004-118）：全图恰好一格 today 描边 class 且落在今天
  // 的日期键上——描边环是 CSS outline（不占布局），样式真实生效以 computed
  // style 兜底断言，防止「只剩裸 class 无样式」的漂移
  const todayKey = localDate(new Date())
  await expect(grid.locator('.ahc-cell.is-today')).toHaveCount(1)
  const todayCell = grid.locator(`.ahc-cell[data-date="${todayKey}"]`)
  await expect(todayCell).toHaveClass(/is-today\b/)
  expect(await todayCell.evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
  // 悬停 title 前缀「今天」+ 日期仍在（与描边同码双通道的文字确认）
  const todayTitle = (await todayCell.getAttribute('title')) || ''
  expect(todayTitle).toContain('今天')
  expect(todayTitle).toContain(todayKey)

  // 补档日格子：色阶 1~4（该日聚合非空 → 加权和 > 0 → 至少 1 级），class 与
  // data-level 一致
  const cell = grid.locator(`.ahc-cell[data-date="${seedDate}"]`)
  await expect(cell).toBeVisible()
  const level = Number(await cell.getAttribute('data-level'))
  expect(level).toBeGreaterThanOrEqual(1)
  expect(level).toBeLessThanOrEqual(4)
  await expect(cell).toHaveClass(new RegExp(`is-l${level}\\b`))

  // 悬停明细（title）：日期 + 三项数值文案齐备，数值与端口行一致
  const title = (await cell.getAttribute('title')) || ''
  expect(title).toContain(seedDate)
  expect(title).toContain('提交')
  expect(title).toContain('会话')
  expect(title).toContain('命令')
  expect(title).toContain(String(seedRow.commits ?? 0))

  // 色阶 CSS：全部格子色值走主题变量（spot check 一格的背景不是裸硬编码色）。
  // color-mix() 在 Chromium 的 computed style 会序列化为现代颜色函数
  // color(srgb r g b)（实测取色即此形态），与 rgb/rgba 同等接受——语义仍是
  // 「主题色阶非空可见」，不依赖浏览器序列化格式。
  const bg = await cell.evaluate(el => getComputedStyle(el).backgroundColor)
  expect(bg).toMatch(/rgba?\(|color\(srgb/)

  // R 键全量刷新链路含热力图卡（refreshAll 顺带 refresh），刷新后卡片仍在
  await page.locator('.mon-btn[title="刷新（R）"]').click()
  await expect(card).toBeVisible()
  await expect(grid.locator(`.ahc-cell[data-date="${seedDate}"]`)).toBeVisible()
})

test('空态共存：机群空闲空态与热力图卡同屏常显', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  // 空态（机群空闲）与热力图卡同时可见——卡在 isEmpty 守卫之外
  await expect(page.locator('.mon-empty')).toContainText('机群空闲', { timeout: 5000 })
  await expect(page.locator('[data-testid="monitor-activity-card"]')).toBeVisible()
})

test('窗口档位：切 52 周格子数合窗口公式、R 键刷新保留档位、切回 13 周回归', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  const card = page.locator('[data-testid="monitor-activity-card"]')
  await expect(card).toBeVisible({ timeout: 5000 })
  const grid = page.locator('[data-testid="monitor-activity-grid"]')
  const base13 = expectedCellCount(new Date(), 91)
  const base52 = expectedCellCount(new Date(), 364)
  // 默认档 = 13 周（保持历史观感）
  await expect(grid.locator('.ahc-cell')).toHaveCount(base13, { timeout: 5000 })
  await expect(card).toContainText('近 91 天')

  // 切 52 周档：格子数 = 364 天窗口公式（起点对齐周日），摘要行 days 同口径
  await page.locator('[data-testid="monitor-activity-window-52"]').click()
  await expect(grid.locator('.ahc-cell')).toHaveCount(base52, { timeout: 5000 })
  await expect(card).toContainText('近 364 天')
  // aria-pressed 档位反馈（可发现性/读屏）
  await expect(page.locator('[data-testid="monitor-activity-window-52"]')).toHaveAttribute('aria-pressed', 'true')

  // R 键 refreshAll 重取不重置档位（本会话记忆，模块级会话态）
  await page.locator('.mon-btn[title="刷新（R）"]').click()
  await expect(grid.locator('.ahc-cell')).toHaveCount(base52, { timeout: 5000 })

  // 切回 13 周回归：格子数与摘要行回到默认窗口
  await page.locator('[data-testid="monitor-activity-window-13"]').click()
  await expect(grid.locator('.ahc-cell')).toHaveCount(base13, { timeout: 5000 })
  await expect(card).toContainText('近 91 天')
})
