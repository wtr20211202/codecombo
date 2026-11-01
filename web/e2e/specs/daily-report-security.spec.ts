import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 日报安全事件行 E2E（P-20261003-51）：真实服务端全链路——
 *   造解锁失败（POST /api/lock/unlock 错误密码 → 审计 failure 事件）→
 *   触发当日日报（POST /api/reports/daily/run，与 21 点巡检同一聚合链）→
 *   通知 API 断言 bodyKey 切到 report.daily.bodySec 且解锁失败计数差分 +1 →
 *   UI 断言通知中心日报行渲染「安全事件：N（解锁失败 x / 令牌变更 y）」。
 * 聚合计数/零事件省略由 Go 单测锁定（server/report/aggregator_test.go），
 * 本用例锁审计读取→聚合→模板键选择→i18n 渲染的端口形状与前端闭环。
 * 计数断言取「造失败前后两轮日报的差分」而非绝对值：e2e-seed 对全新实例的
 * 解锁探测本身会落一条 failure（先 unlock 探测后 setup），且套件内其他用例
 * 可能残留失败计数——差分口径对重跑与残留都稳定。
 * 自备临时仓库项目保证当日聚合非空（零事件项目不发日报，是日报出现的前置）；
 * afterAll 清理项目/通知/临时目录，不残留测试数据。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-daily-report-sec')
const PROJ = 'e2e-daily-report-sec'
const FILE = '.e2e-daily-sec.tmp'

// 固定参数列表调用 git（无 shell 拼接），身份内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()

  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 与服务端 git 视图一致（commit-amend 同款）
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'daily security e2e\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'feat: 日报安全事件行夹具提交'])

  const regRes = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(regRes.status)
  projectId = ((await regRes.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId, '夹具项目应注册成功').toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) {
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

test('造解锁失败 → 当日日报含安全事件行（API 形状 + UI 渲染）', async ({ page }) => {
  const headers = await unlockHeaders()

  // 通知从零开始：本用例的日报通知经真实聚合链产生，取「最新一份」做差分
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })

  const latestDaily = async () => {
    const list = await (await fetch(`${API_BASE}/api/notifications`, { headers })).json()
    const mine = ((list?.data || []) as Array<Record<string, any>>)
      .filter(n => n.titleKey === 'report.daily.title' && n.projectName === PROJ)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)))
    return mine[0]
  }
  const runDaily = async () => {
    const res = await fetch(`${API_BASE}/api/reports/daily/run`, {
      method: 'POST', headers, body: JSON.stringify({}),
    })
    expect(res.ok).toBeTruthy()
    const run = (await res.json()) as { sent?: number }
    expect(run.sent ?? 0, '夹具项目当日有提交，聚合非空应发日报').toBeGreaterThanOrEqual(1)
  }

  // 基线一轮：种子残留等既有安全计数进 base，不进断言
  await runDaily()
  const base = await latestDaily()
  expect(base, '基线日报通知应存在').toBeTruthy()

  // 造解锁失败：错误密码一次（401=审计 failure；429=限流 denied，聚合同为失败）
  const wrong = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: 'wrong-password-for-daily-sec' }),
  })
  expect([401, 429]).toContain(wrong.status)

  // 再跑一轮：解锁失败计数差分 +1、令牌变更不变；当日有审计事件 → bodyKey 切 bodySec
  await runDaily()
  const daily = await latestDaily()
  expect(daily, '造失败后的日报通知应存在').toBeTruthy()
  expect(String(daily!.time) > String(base!.time), '应取造失败后的新通知').toBeTruthy()
  expect(daily!.bodyKey).toBe('report.daily.bodySec')
  expect(daily!.msgParams?.secUnlockFail).toBe(Number(base!.msgParams?.secUnlockFail) + 1)
  expect(daily!.msgParams?.secTokenChange).toBe(Number(base!.msgParams?.secTokenChange))

  // UI 渲染：通知中心日报行含「安全事件：N（解锁失败 x / 令牌变更 y）」
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  const row = page.locator('.nc-item:not(.nc-sub)')
    .filter({ hasText: PROJ })
    .filter({ hasText: '今日动态' })
    .first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText('安全事件：')
  await expect(row).toContainText(
    `解锁失败 ${daily!.msgParams?.secUnlockFail} / 令牌变更 ${daily!.msgParams?.secTokenChange}`,
  )
})
