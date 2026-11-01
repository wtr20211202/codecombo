import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * WS 断线重连后状态补拉 E2E（P-20261001-19）
 *
 * 动机：项目 WS 断线期间服务端的 file/branch/log.changed 广播全部丢失且不可
 * 回放，重连成功后若不补拉，UI 停留在断线前状态（休眠唤醒/网络切换高频）。
 *
 * 断连模拟沿用 ws-disconnect-bar 的既有范式：routeWebSocket 截胡
 * /ws/projects/:id（连接即 close），恢复时放行直通 + window 'online' 事件触发
 * useWebSocketBase.handleRecovery 立即重连。只截项目 WS，通知/ops-channel WS
 * 与全部 HTTP API 不受影响。
 *
 * 断言聚焦「重连后补拉发生」最小面（断连期间的广播不可回放、面板保持打开、
 * 无任何用户交互、无终端 OSC 自动刷新事件——重连后新数据的唯一来源是 onOpen
 * 补拉）：
 * - 用例 1（changes）：端到端数据面——断连窗口期落盘的文件变更在重连后自动
 *   出现在变更面板。注意服务端 git status 有 3s TTL 缓存
 *   （server/api/gitops/status_cache.go），断连写盘后须等缓存过期再重连，
 *   否则补拉拿到的是进入链时代的缓存条目（首跑实测踩坑）
 * - 用例 2（branch）：分支 store 的消费面是命令面板/快速切换（GitPanel 分支树
 *   自带独立 fetch 链不经 store——其重连刷新由 P-20261005-7 与补拉同谓词的
 *   顺带派发覆盖，见 ws-reconnect-git-panel-refresh.spec）——此处断言重连后
 *   /branches 补拉请求发生（零交互），store 消费链与用例 1 同一 allSettled
 *   批次（单测覆盖）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-ws-reconnect-refetch')
const PROJ = 'e2e-ws-reconnect'
const BASE_FILE = 'e2e-reconnect-base.tmp'
const OFFLINE_FILE = 'e2e-reconnect-offline.tmp'
const NEW_BRANCH = 'e2e-reconnect-branch'
const WS_PATTERN = /\/ws\/projects\/[^/]+$/

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
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

/** 进入项目页并装好 WS 截胡（offline 期）。返回恢复函数：放行新连接直通 */
async function enterOffline(page: Page): Promise<() => void> {
  let offline = true
  await page.routeWebSocket(WS_PATTERN, ws => {
    if (offline) {
      void ws.close()
      return
    }
    void ws.connectToServer()
  })
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  return () => { offline = false }
}

/** 恢复路由 + 'online' 事件触发立即重连（handleRecovery 恢复触发器） */
async function reconnect(page: Page, goOnline: () => void) {
  goOnline()
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
}

/** rail「提交」是 toggle（uiState 服务端全局、恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 显式 -b master：不依赖环境 init.defaultBranch
  execFileSync('git', ['init', '-b', 'master'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // root 基线提交 + 一处进入页面前就存在的未暂存变更（BASE_FILE）：
  // 面板先显示它 = 进入链的首拉已落定，其后出现的 OFFLINE_FILE 只能来自补拉
  fs.writeFileSync(path.join(REPO_DIR, BASE_FILE), 'baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 基线提交'])
  fs.appendFileSync(path.join(REPO_DIR, BASE_FILE), 'baseline changed\n')
  const reg = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(reg.status)
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
  // 本 spec 运行期间 auto-save 的 uiState（面板视图/项目选择）会污染后续
  // spec 的布局恢复——与 commit-amend 收尾对称，归零收尾
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('断连窗口期的文件变更在重连后自动出现在变更面板（无任何交互）', async ({ page }) => {
  const goOnline = await enterOffline(page)
  await openCommitPanel(page)
  const panel = page.locator('.commit-panel')

  // 基线落定：进入链首拉已渲染（BASE_FILE 可见），此时 OFFLINE_FILE 尚不存在
  await expect(panel.locator('.cp-node').filter({ hasText: BASE_FILE })).toBeVisible({ timeout: 10000 })
  await expect(panel.locator('.cp-node').filter({ hasText: OFFLINE_FILE })).toHaveCount(0)

  // 断连窗口期落盘变更：服务端 fsnotify 广播落空（WS 已断，不可回放）
  fs.writeFileSync(path.join(REPO_DIR, OFFLINE_FILE), 'written while offline\n')
  // 等过服务端 git status 3s TTL 缓存（status_cache.go）：重连补拉若落在
  // 进入链采集的 TTL 窗口内，拿到的是不含新文件的缓存条目（首跑实测踩坑）
  await page.waitForTimeout(3500)

  // 恢复路由 → 立即重连 → onOpen 补拉 → 变更自动入列（期间零交互、零事件）
  await reconnect(page, goOnline)
  await expect(panel.locator('.cp-node').filter({ hasText: OFFLINE_FILE })).toBeVisible({ timeout: 10000 })
})

test('重连后分支列表自动补拉（/branches 请求发生，零交互）', async ({ page }) => {
  const goOnline = await enterOffline(page)

  // 断连窗口期建分支：branch.changed 广播落空（WS 已断，不可回放）
  git(REPO_DIR, ['branch', NEW_BRANCH])

  // 计数器在断连期安装（进入链的分支拉取——若有——已在此前发生），
  // 只统计重连后的分支列表请求
  let branchFetches = 0
  await page.route('**/api/projects/*/branches', (route) => {
    branchFetches++
    return route.continue()
  })

  await reconnect(page, goOnline)
  // onOpen 补拉批次含 fetchBranches；无终端 OSC 自动刷新、无面板交互，
  // 重连后 /branches 请求的唯一来源就是补拉
  await expect.poll(() => branchFetches, { timeout: 10000 }).toBeGreaterThanOrEqual(1)
})
