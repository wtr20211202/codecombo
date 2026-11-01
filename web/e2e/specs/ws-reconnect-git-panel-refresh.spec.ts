import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * WS 重连顺带触发 git 面板自动刷新 E2E（P-20261005-7）
 *
 * 动机：分支树是独立 fetch 链（GitBranchesSection.fetchBranchesAndTags，不读
 * branch store），P-20261001-19 的重连补拉只刷新各 store——git 面板打开时分支
 * 树滞旧到下次交互。落地：useWebSocket onOpen 与补拉同谓词顺带派发
 * sc:git-panel-autorefresh 既有窗口事件（真重连 / 离线进入后的首开），面板侧
 * 去抖/兜底全复用。本 spec 即离线进入形态：面板在断线窗口前挂载拉取，窗口期
 * 外建的分支靠补拉点的顺带派发上屏。
 *
 * 断连模拟沿用 ws-reconnect-refetch 的既有范式：routeWebSocket 截胡
 * /ws/projects/:id（连接即 close），恢复时放行直通 + window 'online' 事件触发
 * useWebSocketBase.handleRecovery 立即重连。只截项目 WS——通知/ops 通道与全部
 * HTTP API 不受影响（排除其他通知源），断言聚焦「分支树零交互出现断连窗口期
 * 外建的分支」：
 * - 分支树刷新事件的唯一来源就是补拉点的顺带派发——断连期无终端 OSC、无
 *   git.activity、无 file.changed（建分支不动工作区）、面板零交互；
 * - 无需等服务端 3s TTL 缓存过期（status_cache.go 只罩 /status 与文件树，
 *   分支端点 branch.go 直接 git.GetBranches，P-19 spec 的等待教训在此不适用）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-ws-reconnect-git-panel')
const PROJ = 'e2e-ws-reconnect-panel'
const NEW_BRANCH = 'e2e-panel-reconnect-branch'
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 基线提交'])
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
  // spec 的布局恢复——与 ws-reconnect-refetch 收尾对称，归零收尾
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('断连窗口期外部建的分支在重连后零交互出现在分支树（面板独立 fetch 链被重连带起）', async ({ page }) => {
  const goOnline = await enterOffline(page)

  // 底栏收起时 tab 条 v-show 不可点（uiState 跨 spec 持久、恢复态不定）→
  // 循环归一化到底栏可见，再切 git tab（GitBranchesSection 挂载，进入链首拉渲染基线）
  const bottomPanel = page.locator('[data-testid="bottom-panel"]')
  for (let i = 0; i < 3; i++) {
    if (await bottomPanel.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('[data-testid="bottom-tab-git"]').click()
  const localHeader = page.locator('.section-header').filter({ hasText: '本地' })
  await expect(localHeader).toBeVisible({ timeout: 10000 })
  // 本地 master 行以 .branch-marker（● 当前分支）锚定（同 git-panel-autorefresh 范式）
  const localMaster = page.locator('.branch-item').filter({ has: page.locator('.branch-marker') }).filter({ hasText: 'master' })
  await expect(localMaster).toBeVisible({ timeout: 10000 })

  // 断连窗口期外部建分支：branch.changed 广播落空（WS 已断不可回放），分支树
  // 无任何可达刷新链（无终端 OSC / 无 git.activity / 建分支不产生 file.changed）
  git(REPO_DIR, ['branch', NEW_BRANCH])
  await expect(page.locator('.branch-item').filter({ hasText: NEW_BRANCH })).toHaveCount(0)

  // 恢复路由 → 立即重连 → onOpen 补拉点同谓词顺带派发面板刷新事件 → 1s 去抖后
  // 分支树独立 fetch 链拉到新分支（期间零交互、零终端事件）
  await reconnect(page, goOnline)
  await expect(page.locator('.branch-item').filter({ hasText: NEW_BRANCH })).toBeVisible({ timeout: 10000 })
})
