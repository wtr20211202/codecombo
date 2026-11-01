import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 活动热力图格子点击下钻当日日报 E2E（P-20261004-96）：真实服务端全链路——
 *   补档触发日报（POST /api/reports/daily/run 历史日）→ 活动序列行 + 存档行
 *   同链落库 → 值班大屏热力图格子点击 → 预检单日详情口非空 → 日报历史面板
 *   打开且聚焦该日（task ④「补档日格子点击→日报视图打开日期匹配」）；
 *   零活动日（活动序列缺行 = 发报链未跑，格子 entry 为空）点击弱提示
 *   「当日无日报」且不开面板（task ④「零活动格→弱提示」）。
 * cursor 语义（可下钻 pointer / 不可 default）与可下钻 title 后缀随两用例顺带
 * 断言。聚合/保留语义由 Go 单测锁定，本用例锁下钻闭环。
 * 不残留测试数据：补档行无删除口（滚动保留语义），经 upsert 幂等；afterAll
 * 清通知兜底（仅候选日耗尽回落「今天」补档时才可能投递——本 spec 不取今天）。
 */

interface CommitInfo { date?: string }
interface ActivityRow { date?: string }
interface ArchiveRow { date?: string; projectId?: string }

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

/** 往前推 n 天（逐日步进免 DST 假设，与卡片窗口公式同口径） */
function daysAgo(n: number): string {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return localDate(d)
}

let projId = ''
let projName = ''
let drillDate = ''
let emptyDate = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 目标项目（e2e-restart.sh 预置的 simple-coding 卡片，真实 git 仓库）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id, '种子项目 simple-coding 应存在').toBeTruthy()
  projId = proj!.id!
  projName = proj!.name!

  // 提交日候选（13 周窗口内、非今天——今天的数据面会被实时链路并发改写）；
  // 先试 14 天内（存档保留窗内，巡检清退竞态免疫），再放宽到 80 天
  const logRes = await fetch(`${API_BASE}/api/projects/${projId}/log?limit=100`, { headers })
  const commits = ((await logRes.json()) as { data?: CommitInfo[] }).data || []
  expect(commits.length, '种子项目应有提交历史').toBeGreaterThan(0)
  const today = localDate(new Date())
  const commitDays = [...new Set(commits.map(c => localDate(new Date(c.date!))))]
    .filter(d => d < today && d >= daysAgo(85))
  const recent = commitDays.filter(d => d >= daysAgo(13)).sort().reverse()
  const older = commitDays.filter(d => d < daysAgo(13)).sort().reverse()
  const candidates = [...recent, ...older]

  // 逐候选补档直到单日存档非空——这正是前端下钻预检的同一道门（活动行与
  // 存档同链落库，存档非空则序列行必在）
  for (const date of candidates.slice(0, 8)) {
    const runRes = await fetch(`${API_BASE}/api/reports/daily/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date }),
    })
    expect(runRes.ok).toBeTruthy()
    const detailRes = await fetch(`${API_BASE}/api/reports/daily/${date}`, { headers })
    const detail = ((await detailRes.json()) as { data?: ArchiveRow[] }).data || []
    if (detail.length === 0) continue
    drillDate = date
    break
  }
  expect(drillDate, '窗口内至少一个提交日可补档出「活动行+存档」').toBeTruthy()

  // 零活动格：补档循环结束后重取活动序列（补档会顺带写行——含失败候选的零
  // 活动行，用旧集合会误判缺行），从昨天往回找缺行日（≤85 天前保在 13 周窗
  // 口内），并复核该日确实无存档（弱提示「当日无日报」的诚实性担保）。全窗
  // 口无缺行日（服务连跑 3 个月+天天发报）则置空、对应用例 skip
  const actRes = await fetch(`${API_BASE}/api/reports/activity?days=91`, { headers })
  expect(actRes.ok).toBeTruthy()
  const rows = ((await actRes.json()) as { data?: ActivityRow[] }).data || []
  const rowSet = new Set(rows.map(r => r.date))
  for (let i = 1; i <= 85; i++) {
    const d = daysAgo(i)
    if (rowSet.has(d) || d === drillDate) continue
    const detailRes = await fetch(`${API_BASE}/api/reports/daily/${d}`, { headers })
    const detail = ((await detailRes.json()) as { data?: ArchiveRow[] }).data || []
    if (detail.length > 0) continue
    emptyDate = d
    break
  }
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('补档日格子点击：日报视图打开且聚焦日期匹配', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  const card = page.locator('[data-testid="monitor-activity-card"]')
  await expect(card).toBeVisible({ timeout: 5000 })
  const grid = page.locator('[data-testid="monitor-activity-grid"]')
  const cell = grid.locator(`.ahc-cell[data-date="${drillDate}"]`)
  await expect(cell).toBeVisible({ timeout: 5000 })

  // 可下钻语义（task ③）：有活动行格 pointer + title 补点击提示后缀
  await expect(cell).toHaveClass(/is-drillable\b/)
  expect(await cell.evaluate(el => getComputedStyle(el).cursor)).toBe('pointer')
  expect((await cell.getAttribute('title')) || '').toContain('点击查看当日日报')

  // 点击下钻：预检通过 → 日报历史面板打开（面板挂通知中心组件根，/monitor 上直接浮出）
  await cell.click()
  const panel = page.locator('[data-testid="report-archive-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })

  // 日期匹配：左列该日高亮选中 + 单日详情渲染出种子项目聚合行
  const dateChip = page.locator(`[data-testid="report-archive-date-${drillDate}"]`)
  await expect(dateChip).toBeVisible({ timeout: 5000 })
  await expect(dateChip).toHaveClass(/\bactive\b/)
  const entry = page.locator(`[data-testid="report-archive-entry-${projId}"]`)
  await expect(entry).toBeVisible({ timeout: 5000 })
  await expect(entry).toContainText(projName)

  // Esc 收面板（面板自身监听，下钻打开与入口打开同一条关闭链）
  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()
})

test('零活动格点击：弱提示「当日无日报」，不打开面板', async ({ page }) => {
  test.skip(!emptyDate, '13 周窗口内无零活动缺行日（服务连跑且天天发报）')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  const grid = page.locator('[data-testid="monitor-activity-grid"]')
  const cell = grid.locator(`.ahc-cell[data-date="${emptyDate}"]`)
  await expect(cell).toBeVisible({ timeout: 5000 })

  // 不可下钻语义（task ③）：无活动行格无 is-drillable，cursor 保持默认
  await expect(cell).not.toHaveClass(/is-drillable\b/)
  expect(await cell.evaluate(el => getComputedStyle(el).cursor)).toBe('default')

  // 点击弱提示：不发请求直接提示（缺行日整条发报链未跑必无档），面板不开
  await cell.click()
  await expect(page.getByText('当日无日报')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeHidden()
})
