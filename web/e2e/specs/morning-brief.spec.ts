import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 开工检查单 E2E（P-20261005-219）：跨天连续性信号一屏聚合的首页横幅卡。
 *   1. 真实链路：未推送提交（本地 bare 为 origin 的工作区 + 一笔隔夜提交）+
 *      未读通知（API 入账）→ 卡片逐项显示 → 项目名直达进项目 + 一键 push →
 *      行消失且 bare 真收到提交（非纸面成功）；
 *   2. 零打扰：brief 全零（route 桩，与服务端共享状态解耦）不渲染空卡；
 *      非零时「已阅/今天不再提醒」当日生效，刷新不再出现（localStorage 当日已阅）。
 * 夹具自备临时仓库，afterAll 清理（范式同 fetch-all）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-brief-work')
const BARE = path.join(os.tmpdir(), 'sc-e2e-brief-bare')
const PROJ = 'e2e-brief-ahead'

let projId = ''

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

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 检查单的未读源是服务端共享态：清通知保证「未推送 + 未读」两项基线可控
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WORK, BARE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  // bare + clone 工作区（已设 upstream），工作区再落一笔未推送提交（ahead=1）
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
  execFileSync('git', ['clone', BARE, WORK], { stdio: 'ignore' })
  git(WORK, ['config', 'core.autocrlf', 'false'])
  git(WORK, ['commit', '--allow-empty', '-m', 'root: 晨报基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  fs.writeFileSync(path.join(WORK, 'morning.txt'), `overnight ${Date.now()}\n`)
  git(WORK, ['add', '.'])
  git(WORK, ['commit', '-m', 'feat: 隔夜完成未推送'])
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projId = body.data?.id || ''
  expect(projId).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WORK, BARE]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('有项显示直达：未推送 + 未读逐项出现，项目名直达 + 一键 push 真推到远端', async ({ page }) => {
  const headers = await unlockHeaders()
  // 未读通知入账（未推送行之外的第二个检查项）
  await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'info', category: 'system', title: 'morning brief unread item' }),
  })

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 卡片出现：未推送行（按项目 id 定位）与未读行并存
  const card = page.locator('[data-testid="morning-brief-card"]')
  await expect(card).toBeVisible({ timeout: 10000 })
  await expect(card).toContainText('未推送')
  const unpushedRow = card.locator(`[data-testid="brief-unpushed-${projId}"]`)
  await expect(unpushedRow).toBeVisible()
  await expect(unpushedRow).toContainText(PROJ)
  await expect(card.locator('[data-testid="brief-open-notifications"]')).toBeVisible()

  // 项目名直达 = 进项目（复用首页进项目链：最近打开 + 显式选择打标）
  await unpushedRow.locator('.brief-link').click()
  await expect(page).toHaveURL(/\/project/)

  // 回首页后卡片仍在（当日未已阅）——一键 push 推到 bare，行内按钮转忙后行消失
  await gotoAndUnlock(page, `${API_BASE}/`)
  const row = page.locator(`[data-testid="brief-unpushed-${projId}"]`)
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('[data-testid="brief-push"]').click()
  await expect(row).toHaveCount(0, { timeout: 30000 })
  // 整卡若只剩未读行仍显示——只断言未推送项收敛（ahead 归零），不断言整卡消失
  // （会话/未读计数随共享实例状态浮动，与本用例无关）

  // push 真实生效：bare 收到那笔隔夜提交（非纸面成功）
  const bareLog = git(BARE, ['log', '--oneline', 'main'])
  expect(bareLog).toContain('隔夜完成未推送')
})

test('零打扰：全零不渲染空卡；已阅/单项静音当日生效（刷新不复现）', async ({ page }) => {
  await fixedLocale(page)

  // 全零 brief（route 桩与服务端共享态解耦）：卡片不渲染（零打扰，无空卡）
  await page.route('**/api/morning-brief*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          date: new Date().toISOString().slice(0, 10),
          unpushed: { count: 0, projects: [] },
          runningAgents: { count: 0 },
          unread: { count: 0, notifications: 0, approvals: 0 },
        },
      }),
    }))
  await gotoAndUnlock(page, `${API_BASE}/`)
  await expect(page.locator('[data-testid="morning-brief-card"]')).toHaveCount(0, { timeout: 10000 })

  // 非零 brief（只有未读项）：卡片出现 → 单项「今天不再提醒」→ 刷新不复现
  await page.route('**/api/morning-brief*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          date: new Date().toISOString().slice(0, 10),
          unread: { count: 1, notifications: 1, approvals: 0 },
        },
      }),
    }))
  await page.reload()
  const card = page.locator('[data-testid="morning-brief-card"]')
  await expect(card).toBeVisible({ timeout: 10000 })
  await expect(card).toContainText('未读通知')
  await card.locator('[data-testid="brief-mute-unread"]').click()
  await expect(card).toHaveCount(0)

  // 当日已阅跨刷新生效（localStorage 当日键）；换新 brief 载荷仍被已阅纪律压制
  await page.reload()
  await expect(page.locator('[data-testid="morning-brief-card"]')).toHaveCount(0, { timeout: 10000 })

  // 「已阅」整卡开关同语义：新一天键位才复位（此处同日内验证 all 键路径）。
  // 只清本功能的当日键——整库 clear 会连带解锁 token/locale，应用会重新上锁
  await page.evaluate(() => {
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith('sc.morningBrief.')) localStorage.removeItem(k)
    }
  })
  await page.route('**/api/morning-brief*', route =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          date: new Date().toISOString().slice(0, 10),
          runningAgents: { count: 2 },
        },
      }),
    }))
  await page.reload()
  await expect(card).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="brief-ack-all"]').click()
  await expect(card).toHaveCount(0)
  await page.reload()
  await expect(page.locator('[data-testid="morning-brief-card"]')).toHaveCount(0, { timeout: 10000 })
})
