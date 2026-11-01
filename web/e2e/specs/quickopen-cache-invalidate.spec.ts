import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import type { Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Quick Open 文件缓存的事件失效（P-20261003-73）：
 *   - agent 在项目里新建文件（直接落盘 → 服务端 fs 监听广播 WS file.changed →
 *     前端失效链清缓存键）后，重开 Quick Open 无需切项目即可搜到新文件；
 *   - 无变更时重开面板命中项目级缓存：/file-list 不重发（网络请求计数断言）。
 * 走真实链路（服务端 watcher → WS → 前端事件），自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-quickopen-invalidate')
const PROJ = 'e2e-quickopen-invalidate'
// 唯一文件名：跨运行残留（清理失败）不会让断言碰到旧同名词
const NEW_FILE_BASE = `agent-created-${Date.now()}`
const NEW_FILE = `${NEW_FILE_BASE}.txt`

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'baseline.txt'), 'quickopen invalidate e2e baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: quickopen 失效基线'])
  await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进入项目页（WS 随项目页连接，file.changed 才能送达前端失效链） */
async function openProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** 经路由层透传计数 /file-list 请求（Quick Open 独占端点，不干扰真实响应） */
async function trackFileList(page: Page): Promise<{ count: () => number }> {
  let n = 0
  await page.route('**/file-list*', (route) => {
    n++
    return route.continue()
  })
  return { count: () => n }
}

async function openQuickOpen(page: Page) {
  await page.keyboard.press('Control+p')
  await expect(page.locator('.palette-input input')).toBeVisible({ timeout: 5000 })
}

test('agent 新建文件后重开 Quick Open 可搜到（事件失效链清缓存）', async ({ page }) => {
  test.setTimeout(60000)
  await openProject(page)
  const fl = await trackFileList(page)

  // 首开：建立项目级缓存
  await openQuickOpen(page)
  await expect.poll(() => fl.count(), { timeout: 5000 }).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })

  // agent 造新文件：直接落盘（服务端 watcher → WS file.changed → 前端失效链）。
  // 链路时延上界 ≈ watcher 500ms 防抖 + 前端 WS 300ms 合并 + 失效 1s 尾沿去抖，
  // 留裕量后开重试窗：失效迟到时下一次重开面板仍能触发重拉
  fs.writeFileSync(path.join(REPO_DIR, NEW_FILE), 'created by agent\n')
  await page.waitForTimeout(3000)

  let pulled = false
  for (let attempt = 0; attempt < 3 && !pulled; attempt++) {
    await openQuickOpen(page)
    pulled = fl.count() >= 2
    if (!pulled) {
      await page.keyboard.press('Escape')
      await page.waitForTimeout(1500)
    }
  }
  expect(pulled).toBe(true) // 过期缓存被事件失效，重开触发重拉

  const input = page.locator('.palette-input input')
  await input.fill(NEW_FILE_BASE)
  await expect(page.locator('.palette-item').filter({ hasText: NEW_FILE_BASE })).toBeVisible({ timeout: 5000 })
  // Esc 双层退出（P-20261004-95）：有查询先清——两连 Esc 才落到关闭
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
})

test('无变更时重开面板命中缓存，/file-list 不重发（网络计数断言）', async ({ page }) => {
  await openProject(page)
  const fl = await trackFileList(page)

  await openQuickOpen(page)
  await expect.poll(() => fl.count(), { timeout: 5000 }).toBe(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })

  // 覆盖失效去抖窗口（1s 尾沿）后重开：无文件事件则必须仍命中缓存
  await page.waitForTimeout(2000)
  await openQuickOpen(page)
  await page.waitForTimeout(1000) // 留出潜在重发窗口
  expect(fl.count()).toBe(1)
  await page.keyboard.press('Escape')
})
