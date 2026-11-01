import { test, expect } from '@playwright/test'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 周报草稿拼接 E2E（P-20261003-135）：真实服务端全链路——
 *   触发日报补档（POST /api/reports/daily/run 两个历史日）→ 通知中心「日报历史」
 *   → 勾选两个日期 →「拼接为周报草稿」→ 预览按日分节（升序、项目事实行、提交
 *   主题、实例级事实）→ 复制剪贴板校验；
 *   T2 下载 .md 文件名 + 返回详情视图 + Esc 渐进收起（草稿→详情→关面板）+
 *   Shift 范围勾选（期望格数按存档窗口序 API 预先推算，避免中间日期不确定）。
 * 聚合语义由 Go 单测锁定（server/report / server/store），本用例锁前端拼接闭环。
 * 存档无删除口（14 天滚动保留，upsert 幂等），通知中心 afterAll 清空兜底。
 * 数据自锚（run15 修复）：此前候选日与提交主题锚定 simple-coding 真仓历史
 * （log?limit=100 滚动窗）——分支演进窗口漂移 + 补交提交的 author/commit 日期
 * 偏斜让断言跨窗定时弹（run14 过 run15 挂）。改为夹具仓自种两条回溯提交
 * （昨日/前日，author+committer 双日期对齐聚合窗口）注册临时项目后补档，
 * 断言只吃自建数据，不再随仓库历史漂移。
 */

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

const FIXTURE_PROJ = 'e2e-weekly-draft-fixture'
/** 自建锚点提交主题（草稿预览 bullet 断言锚；主题即断言数据，无前缀截断问题） */
const ANCHOR_SUBJECT_A = 'e2e weekly draft 锚点提交A：拼接断言自建数据'
const ANCHOR_SUBJECT_B = 'e2e weekly draft 锚点提交B：拼接断言自建数据'
let fixtureProjId = ''
let fixtureRepoDir = ''
let projName = ''
/** 补档成功的两个历史日（升序；草稿分节顺序断言用） */
let dayA = ''
let dayB = ''
/** dayA..dayB 在面板窗口序（存档倒序）内覆盖的格数（Shift 范围勾选期望值） */
let rangeCount = 1
let topSubjectPrefix = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 页面入口仍走种子项目卡（通知中心是全局面板，与入口项目无关）
  const projRes = await fetch(`${API_BASE}/api/projects`, { headers })
  const projects = ((await projRes.json()) as { data?: Array<{ id?: string; name?: string }> }).data || []
  const proj = projects.find(p => p.name === 'simple-coding')
  expect(proj?.id, '种子项目 simple-coding 应存在').toBeTruthy()

  // 夹具仓自种两条回溯提交（昨日/前日正午）：author+committer 双日期对齐——
  // 聚合窗口按 git --since/--until（commit date）圈定，提交主题即断言锚
  fixtureRepoDir = await mkdtemp(path.join(tmpdir(), 'sc-e2e-weekly-draft-'))
  const git = (args: string[], envDate?: string) => execFileSync('git', args, {
    cwd: fixtureRepoDir, encoding: 'utf8',
    env: envDate
      ? { ...process.env, GIT_AUTHOR_DATE: envDate, GIT_COMMITTER_DATE: envDate }
      : process.env,
  })
  git(['init'])
  git(['config', 'user.email', 'e2e@example.com'])
  git(['config', 'user.name', 'e2e'])
  git(['config', 'commit.gpgsign', 'false'])
  const mkCommit = (subject: string, dayOffset: number) => {
    const d = new Date()
    d.setDate(d.getDate() - dayOffset)
    d.setHours(12, 0, 0, 0)
    const stamp = `${localDate(d)} 12:00:00`
    git(['add', '.'])
    git(['commit', '-m', subject, '--date', stamp], stamp)
    return localDate(d)
  }
  writeFileSync(path.join(fixtureRepoDir, 'anchor-a.md'), 'anchor a\n')
  dayA = mkCommit(ANCHOR_SUBJECT_A, 2)
  writeFileSync(path.join(fixtureRepoDir, 'anchor-b.md'), 'anchor b\n')
  dayB = mkCommit(ANCHOR_SUBJECT_B, 1)

  // 清同名残留项目（前次运行崩溃遗留）后注册夹具项目
  for (const p of projects) {
    if (p.name === FIXTURE_PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  const regRes = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: FIXTURE_PROJ, path: serverPath(fixtureRepoDir) }),
  })
  expect(regRes.ok).toBeTruthy()
  fixtureProjId = ((await regRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(fixtureProjId, '夹具项目注册成功').toBeTruthy()
  projName = FIXTURE_PROJ

  // 两个锚点日逐个补档（历史日=只补档不投递，返回值=当日有事实的项目数）
  const seeded: string[] = []
  for (const date of [dayA, dayB]) {
    const runRes = await fetch(`${API_BASE}/api/reports/daily/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ date }),
    })
    expect(runRes.ok).toBeTruthy()
    const run = (await runRes.json()) as { sent?: number }
    if ((run.sent ?? 0) > 0) seeded.push(date)
  }
  expect(seeded.length, '两个锚点日的聚合非空（补档成功）').toBe(2)

  // 存档窗口序（列表口倒序）里两端的位置差 = Shift 范围覆盖格数
  const listRes = await fetch(`${API_BASE}/api/reports/daily?limit=200`, { headers })
  const list = ((await listRes.json()) as { data?: Array<{ date?: string }> }).data || []
  const window = [...new Set(list.map(e => e.date!))] // 服务端已倒序，去重即面板窗口序
  const posA = window.indexOf(dayA)
  const posB = window.indexOf(dayB)
  expect(posA).toBeGreaterThanOrEqual(0)
  expect(posB).toBeGreaterThanOrEqual(0)
  rangeCount = Math.abs(posA - posB) + 1

  // 最新补档日的提交主题锚 = 自建提交主题全文（存档 bullet 即它，无截断错位面）
  topSubjectPrefix = ANCHOR_SUBJECT_B
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  if (fixtureProjId) {
    await fetch(`${API_BASE}/api/projects/${fixtureProjId}`, { method: 'DELETE', headers }).catch(() => {})
  }
  if (fixtureRepoDir) {
    await rm(fixtureRepoDir, { recursive: true, force: true }).catch(() => {})
  }
})

test('多选勾选 → 拼接分节正确（升序/事实行/主题） → 复制草稿', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  // 通知中心 → 日报历史面板
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="notif-archive-btn"]').click()
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeVisible({ timeout: 3000 })

  // 逐格勾选两个补档日（恰 2 天——窗口内其他存档日不掺入）
  await page.locator(`[data-testid="report-archive-check-${dayA}"]`).click()
  await page.locator(`[data-testid="report-archive-check-${dayB}"]`).click()
  await expect(page.locator('[data-testid="report-archive-selected-count"]')).toContainText('已选 2 天')

  // 拼接 → 草稿预览按日分节（升序），含项目事实行与提交主题
  await page.locator('[data-testid="weekly-draft-build"]').click()
  const preview = page.locator('[data-testid="weekly-draft-preview"]')
  await expect(preview).toBeVisible({ timeout: 8000 })
  const text = (await preview.textContent()) || ''
  expect(text).toContain('# 周报')
  expect(text.indexOf(`## ${dayA}`)).toBeGreaterThanOrEqual(0)
  expect(text.indexOf(`## ${dayA}`)).toBeLessThan(text.indexOf(`## ${dayB}`))
  expect(text).toContain(projName)
  expect(text).toContain('审批')
  expect(text).toContain('部署')
  if (topSubjectPrefix) {
    expect(text).toContain(topSubjectPrefix)
  }

  // 复制：toast + 剪贴板含标题与两个日期分节
  await page.locator('[data-testid="weekly-draft-copy"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' })).toBeVisible({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toContain('# 周报')
  expect(clip).toContain(`## ${dayA}`)
  expect(clip).toContain(`## ${dayB}`)
})

test('下载 .md 文件名 + Shift 范围勾选 + 返回详情 + Esc 渐进收起', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="notif-archive-btn"]').click()
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeVisible({ timeout: 3000 })

  // Shift 范围勾选：先点窗口序靠后的 dayA，Shift 点靠前的 dayB——
  // 期望覆盖格数 = 窗口内两端位置差 + 1（中间可能有其他存档日）
  await page.locator(`[data-testid="report-archive-check-${dayA}"]`).click()
  await page.locator(`[data-testid="report-archive-check-${dayB}"]`).click({ modifiers: ['Shift'] })
  await expect(page.locator('[data-testid="report-archive-selected-count"]')).toContainText(`已选 ${rangeCount} 天`)

  // 拼接（范围集）→ 预览可见即可（分节正确性由上一用例锁定）
  await page.locator('[data-testid="weekly-draft-build"]').click()
  await expect(page.locator('[data-testid="weekly-draft-preview"]')).toBeVisible({ timeout: 8000 })

  // 下载：blob 文件名 = weekly-report-<起 YYYYMMDD>-<止 YYYYMMDD>.md（勾选集升序两端）
  const downloadPromise = page.waitForEvent('download')
  await page.locator('[data-testid="weekly-draft-download"]').click()
  const download = await downloadPromise
  expect(download.suggestedFilename()).toBe(`weekly-report-${dayA.replaceAll('-', '')}-${dayB.replaceAll('-', '')}.md`)

  // 返回按钮：回单日详情视图（草稿视图退出）
  await page.locator('[data-testid="weekly-draft-back"]').click()
  await expect(page.locator('[data-testid="report-archive-detail"]')).toBeVisible({ timeout: 3000 })
  await expect(page.locator('[data-testid="weekly-draft-view"]')).toBeHidden()

  // 详情视图下 Esc 直接关面板
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeHidden()

  // 草稿视图下 Esc 先退详情再关面板（渐进收起）
  await page.locator('[data-testid="notif-archive-btn"]').click()
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeVisible({ timeout: 3000 })
  await page.locator(`[data-testid="report-archive-check-${dayA}"]`).click()
  await page.locator('[data-testid="weekly-draft-build"]').click()
  await expect(page.locator('[data-testid="weekly-draft-preview"]')).toBeVisible({ timeout: 8000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="weekly-draft-view"]')).toBeHidden()
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="report-archive-panel"]')).toBeHidden()
})
