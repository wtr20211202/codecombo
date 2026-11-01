import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件监听降级轮询兜底 E2E（P-20261003-140）：
 *   1. 开关 API 契约：POST/GET /api/watch/fallback 显式开关与状态回读
 *   2. 降级态链路：fallback ON，向临时仓库写新文件 → 变更面板在轮询间隔内
 *      刷新出新文件行（file.changed 广播与 fsnotify 同管道——真实 ENOSPC
 *      无法在 e2e 造出，自动降级/探针恢复由 server/watch 单测覆盖，此处锁
 *      「兜底开启时端到端仍通」）
 *   3. 通知动作「切换轮询」：播种带 action 的告警条 → 行内按钮点击翻转兜底
 *      态（toast 反馈 + GET 状态回读对齐）
 *   4. 关闭兜底后 watcher 原生路径仍工作（重挂恢复的功能面）
 * 自备临时仓库，afterAll 清理（changes-agent-marks 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-watch-fallback')
const PROJ = 'e2e-watch-fallback'
const POLL_FILE = 'poll-detected.txt'
const WATCHER_FILE = 'watcher-alive.txt'

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

/** 降级兜底开关（API 直调：e2e 模拟配额耗尽 = 手动开启兜底的等价状态） */
async function setFallback(headers: Record<string, string>, enabled: boolean): Promise<{ enabled?: boolean; source?: string }> {
  const res = await fetch(`${API_BASE}/api/watch/fallback`, {
    method: 'POST', headers, body: JSON.stringify({ enabled }),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: { enabled?: boolean; source?: string } }
  return body.data || {}
}

async function getFallback(headers: Record<string, string>): Promise<{ enabled?: boolean; source?: string }> {
  const res = await fetch(`${API_BASE}/api/watch/fallback`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as { data?: { enabled?: boolean; source?: string } }
  return body.data || {}
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO })
  fs.writeFileSync(path.join(REPO, 'base.txt'), 'baseline\n')
  git(REPO, ['add', '.'])
  git(REPO, ['commit', '-m', 'root: baseline'])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
  // 兜底态归零起步（共享实例跨用例状态对齐）
  await setFallback(headers, false)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await setFallback(headers, false).catch(() => {})
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers }).catch(() => {})
  if (projectId) {
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers }).catch(() => {})
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
}

test('开关 API 契约：显式开启/关闭与状态回读', async () => {
  const headers = await unlockHeaders()
  const on = await setFallback(headers, true)
  expect(on.enabled).toBe(true)
  expect(on.source).toBe('manual')
  expect(on.since).toBeTruthy()
  const read = await getFallback(headers)
  expect(read.enabled).toBe(true)
  const off = await setFallback(headers, false)
  expect(off.enabled).toBe(false)
  expect(off.source ?? '').toBe('') // 关闭态 source 清空（omitempty 序列化省略）
})

test('兜底开启时新文件经轮询链路进变更面板', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  await setFallback(headers, true)
  await enterProject(page)
  // 等页面 WS 建连 + 服务端 gitStatusCacheTTL（3s）过期：file.changed 触发的
  // fetchStatus 在 TTL 内会命中面板初载的陈旧缓存（广播不可回放，watcher 路径
  // 单发，写入必须晚于缓存窗口——轮询路径的下一 tick 同理受益）
  await page.waitForTimeout(4000)

  fs.writeFileSync(path.join(REPO, POLL_FILE), 'poll fallback detected\n')
  // 轮询间隔 5s + 前端 300ms 防抖 + fetchStatus：12s 足够覆盖一个轮询周期
  await expect(page.locator('.cp-node').filter({ hasText: POLL_FILE })).toBeVisible({ timeout: 12000 })
  await setFallback(headers, false)
})

test('通知动作「切换轮询」：行内按钮翻转兜底态并有反馈', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  // 清残留后播种带动作的配额告警条（服务端 inotifyExhaustedNotification 同形状）；
  // 兜底先置 ON：第一次点击翻转 OFF（已切回实时监听），第二次翻回 ON
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  await setFallback(headers, true)
  const seeded = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST', headers,
    body: JSON.stringify({
      type: 'warning', category: 'system',
      title: '文件监听配额耗尽',
      body: 'e2e seeded: watch-fallback action',
      action: 'watch-fallback', actionPayload: 'toggle',
    }),
  })
  expect(seeded.status).toBe(200)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })

  // 行内动作按钮可见（动作型通知的可见入口）→ 点击翻转 OFF
  const row = page.locator('.nc-item').filter({ hasText: '文件监听配额耗尽' }).first()
  const actionBtn = row.locator('.nc-inline-action')
  await expect(actionBtn).toBeVisible({ timeout: 5000 })
  await expect(actionBtn).toHaveText('切换轮询')
  await actionBtn.click()
  // hasText 过滤：上一条 toast 未消退时 .n-message 可能同屏多条（strict mode）
  await expect(page.locator('.n-message').filter({ hasText: '已切回实时监听' })).toBeVisible({ timeout: 5000 })
  expect((await getFallback(headers)).enabled).toBe(false)

  // 再开面板翻转回 ON（handleClick 关面板 → 重开）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-item').filter({ hasText: '文件监听配额耗尽' }).first().locator('.nc-inline-action').click()
  await expect(page.locator('.n-message').filter({ hasText: '已切换到轮询模式' })).toBeVisible({ timeout: 5000 })
  expect((await getFallback(headers)).enabled).toBe(true)
})

test('兜底关闭后 watcher 原生路径仍工作', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  await setFallback(headers, false)
  await enterProject(page)
  await page.waitForTimeout(4000) // 等 WS 建连 + 服务端 git status 缓存过期（TTL 3s，见「兜底开启」用例注）

  fs.writeFileSync(path.join(REPO, WATCHER_FILE), 'watcher alive\n')
  await expect(page.locator('.cp-node').filter({ hasText: WATCHER_FILE })).toBeVisible({ timeout: 12000 })
})

/**
 * 降级态常驻可见微标（P-20261006-34）：降级是持续态，可见性不靠一次性通知
 * 记忆——状态栏「轮询降级中」微标。锁三面：
 *   1. 加载快照兜底：进入项目页前已降级 → 微标随页面出现（GET 快照拉取）
 *   2. 悬停说明：title 携浅层扫描边界与恢复条件（manual 来源提示手动关闭路径）
 *   3. 迁移广播驱动显隐：页面开着时 API 开关兜底 → 微标经通知 WS 广播即时
 *      显隐，全程零刷新（刷新会退回快照路径，锁不住事件面）
 */
test('状态栏降级微标：加载快照可见 + 悬停说明 + 迁移广播即时显隐（零刷新）', async ({ page }) => {
  test.setTimeout(60000)
  const headers = await unlockHeaders()
  const badge = page.locator('[data-testid="statusbar-watch-fallback"]')

  // ① 页面加载前已降级（manual）：快照路径让微标随项目页出现
  await setFallback(headers, true)
  await enterProject(page)
  await expect(badge).toBeVisible({ timeout: 5000 })
  await expect(badge).toHaveText(/轮询降级中/)
  // 悬停说明：manual 来源 → 浅层边界 + 手动关闭路径（恢复条件按来源分流）
  await expect(badge).toHaveAttribute('title', /浅层/)
  await expect(badge).toHaveAttribute('title', /手动轮询/)

  // ② 迁移广播驱动：API 关闭兜底 → 微标即时消失（页面零刷新）
  await setFallback(headers, false)
  await expect(badge).toBeHidden({ timeout: 5000 })

  // ③ 再开启：即时复现（多标签页一致的广播语义在此同链验证）
  await setFallback(headers, true)
  await expect(badge).toBeVisible({ timeout: 5000 })
  await setFallback(headers, false)
  await expect(badge).toBeHidden({ timeout: 5000 })
})
