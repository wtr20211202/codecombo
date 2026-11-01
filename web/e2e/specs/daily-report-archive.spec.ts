import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 日报存档与回看 E2E（P-20261003-4）：真实服务端全链路——
 *   触发日报（POST /api/reports/daily/run 历史日补档）→ 存档落库（列表口/详情口
 *   可查）→ 前端通知中心「日报历史」入口 → 日期列表 → 单日详情（跨日回看视角）。
 * 聚合与 14 天滚动清理由 Go 单测锁定（server/store/dailyreport_test.go、
 * server/report/module_test.go），本用例锁端口形状与前端回看闭环。
 * 触发口选历史日补档（不发通知）：确定性来自 git log 的真实提交日期——
 * 任取日志页内的提交日期，该日必有 ≥1 提交，聚合必非空。
 * 不残留测试数据：补档存档无删除口（14 天滚动保留语义），经 upsert 幂等；
 * 通知中心在 afterAll 清空兜底（today 分支可能投递）
 */

interface CommitInfo { date?: string; message?: string }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** Date → 服务器本地 YYYY-MM-DD（触发口/存档键同一时区口径） */
function localDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

let projId = ''
let projName = ''
let archiveDate = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 目标项目（e2e-restart.sh 预置的 simple-coding 卡片，真实 git 仓库）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id, '种子项目 simple-coding 应存在').toBeTruthy()
  projId = proj!.id!
  projName = proj!.name!

  // 从提交日志取候选日期（真实提交必有；先试今日之前的历史日——跨日回看视角）
  const logRes = await fetch(`${API_BASE}/api/projects/${projId}/log?limit=50`, { headers })
  const commits = ((await logRes.json()) as { data?: CommitInfo[] }).data || []
  expect(commits.length, '种子项目应有提交历史').toBeGreaterThan(0)
  const today = localDate(new Date())
  const candidates = [...new Set(commits.map(c => localDate(new Date(c.date!))))]
    .sort()
    .reverse()
    .sort((a, b) => (a === today ? 1 : 0) - (b === today ? 1 : 0)) // 历史日优先

  // 逐候选补档直到该日聚合非空（提交日期口径与服务端同机同时区，首轮即中）
  for (const date of candidates.slice(0, 5)) {
    const runRes = await fetch(`${API_BASE}/api/reports/daily/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date }),
    })
    expect(runRes.ok).toBeTruthy()
    const run = (await runRes.json()) as { sent?: number }
    if ((run.sent ?? 0) > 0) {
      archiveDate = date
      break
    }
  }
  expect(archiveDate, '至少一个提交日的聚合非空（补档成功）').toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('日报存档端口：列表倒序 + 单日详情含项目聚合', async () => {
  const headers = await unlockHeaders()

  // 列表口：含补档日期与项目，倒序在前部
  const listRes = await fetch(`${API_BASE}/api/reports/daily?limit=200`, { headers })
  expect(listRes.ok).toBeTruthy()
  const list = ((await listRes.json()) as { data?: Array<{ date?: string; projectId?: string; commits?: number }> }).data || []
  const mine = list.find(e => e.date === archiveDate && e.projectId === projId)
  expect(mine, `列表口应含 ${archiveDate}/${projId}`).toBeTruthy()
  expect(mine!.commits!).toBeGreaterThanOrEqual(1)

  // 单日详情口：该日全部项目、聚合数与列表一致；空日返回空列表
  const detailRes = await fetch(`${API_BASE}/api/reports/daily/${archiveDate}`, { headers })
  expect(detailRes.ok).toBeTruthy()
  const detail = ((await detailRes.json()) as { data?: Array<{ projectId?: string; commits?: number; commitSubjects?: string[] }> }).data || []
  const mineDetail = detail.find(e => e.projectId === projId)
  expect(mineDetail?.commits).toBe(mine!.commits)
  expect(mineDetail!.commitSubjects!.length).toBeGreaterThanOrEqual(1)

  const emptyRes = await fetch(`${API_BASE}/api/reports/daily/2000-01-01`, { headers })
  const empty = ((await emptyRes.json()) as { data?: unknown[] }).data || []
  expect(emptyRes.ok).toBeTruthy()
  expect(empty.length).toBe(0)

  // 畸形日期 400
  const badRes = await fetch(`${API_BASE}/api/reports/daily/not-a-date`, { headers })
  expect(badRes.status).toBe(400)
})

test('日报回看：通知中心历史入口 → 日期列表 → 单日详情', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 通知中心 → 日报历史入口
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="notif-archive-btn"]').click()
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeVisible({ timeout: 3000 })

  // 日期列表含补档日（跨日回看视角：选中的是历史日而非今天）
  const chip = page.locator(`[data-testid="report-archive-date-${archiveDate}"]`)
  await expect(chip).toBeVisible({ timeout: 5000 })
  await chip.click()

  // 单日详情：项目聚合行 + 提交主题明细 + 实例级事实条
  const entry = page.locator(`[data-testid="report-archive-entry-${projId}"]`)
  await expect(entry).toBeVisible({ timeout: 5000 })
  await expect(entry).toContainText(projName)
  await expect(entry).toContainText('提交')
  // 主题明细锚 data-testid（P-20261003-135 拆 DayDetailPane 后样式类随组件更名）。
  // 断言口径=UI 忠实渲染服务端单日明细（spec 头注声明的「端口形状+回看闭环」
  // 职责；聚合排序语义由 Go 单测锁定）：首条与 detail API 的 commitSubjects[0]
  // 同源比对。不从 git log 独立推导「该日最新提交」——git log 遍历序（服务端
  // 聚合同源）在 author/committer 时间倒挂（rebase 改写提交时间）的日子不等价
  // 于按时间排序，run9 实测同日 merge 与 feat 倒挂致该独立推导假红
  const detailRes = await fetch(`${API_BASE}/api/reports/daily/${archiveDate}`, { headers: await unlockHeaders() })
  expect(detailRes.ok).toBeTruthy()
  const detail = ((await detailRes.json()) as { data?: Array<{ projectId?: string; commitSubjects?: string[] }> }).data || []
  const expectedFirst = detail.find(e => e.projectId === projId)?.commitSubjects?.[0] ?? ''
  expect(expectedFirst, '单日明细应含提交主题（端口用例已断言非空）').toBeTruthy()
  const subjects = entry.locator('[data-testid="report-archive-subjects"] li')
  await expect(subjects.first()).toBeVisible()
  await expect(subjects.first()).toContainText(expectedFirst)
  await expect(page.locator('[data-testid="report-archive-panel"]')).toContainText('审批')
  await expect(page.locator('[data-testid="report-archive-panel"]')).toContainText('部署')

  // Esc 先关日报面板（通知中心仍在）
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeHidden()
  await expect(page.locator('.nc-card')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.nc-card')).toBeHidden()
})
