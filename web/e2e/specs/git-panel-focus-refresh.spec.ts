import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * git 面板挂载期外部变更感知（P-20261004-39）E2E：GitPanel 挂载持续期间仓库被
 * 产品 API 之外的手段（本 spec 直接调 git CLI）修改后，面板对 window focus /
 * visibilitychange(visible) 触发做 >10s 节流静默重取（无任何 sc:git-panel-autorefresh
 * 合成事件、无手动刷新——区别于 git-panel-autorefresh.spec 的感知链）：
 *   1. focus 触发重取——挂载中新建的外部分支在 focus 后出现在列表（静默链拉到现势）
 *   2. 幽灵操作条自愈——「合并进行中且冲突已全解」操作条在 CLI merge --abort 后
 *      仍滞留（挂载期零感知的误导性最强形态），focus 重取即消失
 *   3. 节流窗口——>10s 内的 focus/visibilitychange 不产生分支列表请求，出窗后恢复
 * 自备临时仓库（含一段外部构造的 merge 冲突→已 add 未收尾状态），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-panel-focus-refresh')
const PROJ = 'e2e-git-panel-focus-refresh'
const README = 'README.md'
const FOCUS_BRANCH = 'e2e-focus-new-branch'
const PROBE_BRANCH = 'e2e-probe-side'

let projectId = ''
let unlockToken = ''

function git(cwd: string, args: string[], allowFail = false): string {
  try {
    return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
  } catch (e) {
    if (allowFail) return ''
    throw e
  }
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(API_BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const list = await api('GET', '/api/projects')
  const old = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, README), 'v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: init'])

  const proj = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
  projectId = (proj.json?.data as { id: string }).id
})

test.afterAll(async () => {
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).first().click()
  await page.waitForURL('**/project')
}

/** 打开底部 git tab 并等分支面板出基线（本地 main 行以 .branch-marker 锚定，防与
 *  远程分组同名 displayName 双中——git-panel-autorefresh.spec 同款定位纪律） */
async function openGitTab(page: import('@playwright/test').Page) {
  const panel = page.locator('[data-testid="bottom-panel"]')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端"]').click()
  }
  await page.locator('[data-testid="bottom-tab-git"]').click()
  const localMain = page.locator('.branch-item').filter({ has: page.locator('.branch-marker') }).filter({ hasText: 'main' })
  await expect(localMain).toBeVisible({ timeout: 10000 })
}

test('窗口 focus 静默重取：挂载中外部新建的分支在 focus 后出现（无合成事件无手动刷新）', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)
  await openGitTab(page)

  // 面板外建分支（不经 UI，不经产品 API——本 spec 全程不派发 sc:git-panel-autorefresh）
  git(REPO_DIR, ['branch', FOCUS_BRANCH])

  // 静默链挂载即拉过一次：等过 >10s 节流窗再触发（P-20261004-39 节流语义）
  await page.waitForTimeout(10500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  await expect(page.locator('.branch-item').filter({ hasText: FOCUS_BRANCH })).toBeVisible({ timeout: 10000 })
})

test('幽灵操作条自愈：CLI merge --abort 后滞留的「合并进行中」操作条在 focus 重取时消失', async ({ page }) => {
  test.setTimeout(120000)
  // 进页面前构造 merge 态：probe-side 与 main 各改同一行 → merge 冲突 → 解决后
  // 只 add 不收尾（conflicts 接口 inProgress='merge'、count=0 → 面板挂载即显示
  // 「完成合并」操作条）——正是巡查实证的误导性最强陈旧形态
  git(REPO_DIR, ['checkout', '-b', PROBE_BRANCH])
  fs.writeFileSync(path.join(REPO_DIR, README), 'probe line\n')
  git(REPO_DIR, ['commit', '-am', 'c2: probe'])
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, README), 'main line\n')
  git(REPO_DIR, ['commit', '-am', 'c2: main'])
  git(REPO_DIR, ['merge', PROBE_BRANCH], true) // 预期冲突退出非零，MERGE_HEAD 留存
  fs.writeFileSync(path.join(REPO_DIR, README), 'resolved line\n')
  git(REPO_DIR, ['add', README])

  await enterProject(page)
  await openGitTab(page)
  // 基线：操作条可见（挂载拉取看到 merge 进行中 + 冲突已全解）
  const opBar = page.locator('.git-op-bar')
  await expect(opBar).toBeVisible({ timeout: 10000 })

  // 面板外收尾合并：操作条的前提（merge 态）已不存在，但面板零感知仍滞留
  git(REPO_DIR, ['merge', '--abort'])

  await page.waitForTimeout(10500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))

  // 静默重取后操作条消失，且不残留冲突横幅（abort 后仓库干净）
  await expect(opBar).toBeHidden({ timeout: 10000 })
  await expect(page.locator('.conflict-banner')).toHaveCount(0)
})

test('节流窗口：>10s 内的 focus/visibilitychange 不重复拉分支列表，出窗后恢复', async ({ page }) => {
  test.setTimeout(120000)
  await enterProject(page)
  await openGitTab(page)

  // 确定性重置节流基点：出窗 focus 必然命中一次静默重取并重记账（不依赖页面
  // 加载时长恰好落在挂载首拉的窗口内——那是时序 flaky）
  await page.waitForTimeout(10500)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.waitForTimeout(1500) // 让这次重取完成

  let branchFetches = 0
  await page.route('**/api/projects/*/branches', (route) => {
    branchFetches++
    return route.continue()
  })

  // 窗口内连发 focus + visibilitychange(visible)：距重置基点 <10s，全部被节流跳过
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await page.waitForTimeout(2000)
  expect(branchFetches).toBe(0)

  // 出窗（>10s）后同一触发恢复拉取（visibilitychange 路径；focus 路径上方已实证）
  await page.waitForTimeout(8500)
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => branchFetches, { timeout: 10000 }).toBeGreaterThanOrEqual(1)
})
