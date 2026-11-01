import { test, expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * pull 结果摘要通知 E2E（P-20261003-202）：本地 bare 仓库作 origin（范式同
 * push-behind-guard，无网络依赖），「队友」经种子克隆推新提交。
 *   1. 拉到新提交：TopBar 共享拉取流 → 成功 toast 带「N 个新提交」计数 +
 *      通知中心入账「Pull 完成」（正文含计数），点击行经 pendingAction 打开
 *      变更面板（P-31 panel:changes 惯例，notify-jump 同款断言）
 *   2. 已最新再拉：「已是最新」info 轻提示，通知中心不新增「Pull 完成」条目
 *   3. GitPanel 快捷拉取（handleQuickPull 入口）同样带计数回执
 * 自备临时仓库，afterAll 清理（含 uiState 归零）。
 */

const WORK = path.join(os.tmpdir(), 'sc-e2e-pull-summary')
const BARE = path.join(os.tmpdir(), 'sc-e2e-pull-summary-bare')
const SEED = `${BARE}-seed`
const PROJ = 'e2e-pull-summary'

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

/** teammatePush：从 bare clone 种子仓推进一步（空提交，模拟队友先提交） */
function teammatePush() {
  fs.rmSync(SEED, { recursive: true, force: true })
  execFileSync('git', ['clone', BARE, SEED], { stdio: 'ignore' })
  git(SEED, ['commit', '--allow-empty', '-m', `teammate: ${Date.now()}`])
  git(SEED, ['push'])
}

async function clearNotifications(headers: Record<string, string>) {
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [WORK, BARE, SEED]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }
  execFileSync('git', ['init', '--bare', '-b', 'main', BARE])
  fs.mkdirSync(WORK, { recursive: true })
  execFileSync('git', ['clone', BARE, WORK], { stdio: 'ignore' })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: WORK }) // 双路径：Windows 服务端 git 也不 smudge
  git(WORK, ['commit', '--allow-empty', '-m', 'root: pull 摘要基线'])
  git(WORK, ['push', '-u', 'origin', 'main'])
  // origin URL 改写为服务端形态（P-20261005-187）：UI 拉取由服务端 git 执行，
  // Windows 形态路径跨拓扑不可解析；测试侧播种/断言用 BARE 原形态不受影响
  git(WORK, ['remote', 'set-url', 'origin', serverPath(BARE)])
  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(WORK).replace(/\\/g, '/') }),
  })
  expect(created.status).toBeLessThan(300)
  await clearNotifications(headers)
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
  for (const dir of [WORK, BARE, SEED]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
  await clearNotifications(headers)
})

/** 解锁后延迟弹出的「建议修改默认密码」遮罩会拦后续点击：有界等一次并收起 */
async function dismissPasswordHint(page: Page) {
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  try { await laterBtn.click({ timeout: 4500 }) } catch { /* 未弹出（锁定关闭/已加载完），继续 */ }
}

/** 回首页 → 进项目页（TopBar 拉取按钮所在）。
 *  waitForURL 后留出 boot 收敛窗：启动期 selectInstance 完成触发的 Layout
 *  remount 会卸载旧 discrete message 容器，命中窗口内的 pull toast 会被连根
 *  拔掉（实测：点击后立即断言 15s 全红，等 1.2s 稳定复现绿） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await dismissPasswordHint(page)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await dismissPasswordHint(page)
  await page.waitForTimeout(1200)
}

/** 打开项目页 git 分区（面板开合是 uiState 持久的 toggle 语义，先查可见再点） */
async function openGitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.current-branch-card').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.current-branch-card')).toBeVisible()
}

/** 变更侧板归一化到关闭基线（面板开关是 toggle 语义，CLAUDE.md e2e 纪律）：
 *  已开且停在 changes 时点行会「关」而非「开」。rail-changes 开关二态：开着
 *  changes 时点击即关；最多两轮（files 态点击只切视图不关，再点一轮才关） */
async function closeChangesPanelBaseline(page: Page) {
  for (let i = 0; i < 2; i++) {
    if (!(await page.locator('#side-panel .commit-panel').isVisible().catch(() => false))) return
    await page.locator('[data-testid="rail-changes"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel .commit-panel')).toHaveCount(0)
}

async function openNotificationCenter(page: Page) {
  await page.locator('.ide-header button[title="通知中心"]').click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test('拉到新提交：toast 带计数 + 通知入账，点击直达变更面板', async ({ page }) => {
  test.setTimeout(90000)
  // 队友推 2 个提交
  teammatePush()
  teammatePush()
  await enterProject(page)

  // TopBar 共享拉取流（useProjectActions.handlePull）
  await page.locator('.ide-header button[title="拉取"]').click()
  await expect(page.locator('.n-message').filter({ hasText: 'Pull 成功：2 个新提交' })).toBeVisible({ timeout: 15000 })

  // 通知中心入账：标题「Pull 完成」+ 正文计数
  await openNotificationCenter(page)
  const row = page.locator('.nc-item').filter({ hasText: 'Pull 完成' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
  await expect(row).toContainText('2 个新提交')

  // Action（P-31 panel:changes 惯例）：点击行 → 变更面板打开
  await closeChangesPanelBaseline(page)
  await row.click()
  await expect(page.locator('#side-panel .commit-panel')).toBeVisible({ timeout: 10000 })
})

test('已最新再拉：「已是最新」轻提示，通知中心不新增条目', async ({ page }) => {
  test.setTimeout(90000)
  await enterProject(page)

  // 上一用例已把远端拉平：此刻 pull 无新提交
  await page.locator('.ide-header button[title="拉取"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已是最新' })).toBeVisible({ timeout: 15000 })

  // 通知中心不新增「Pull 完成」条目（仍只有上一用例入账的 1 条）
  await openNotificationCenter(page)
  await expect(page.locator('.nc-item').filter({ hasText: 'Pull 完成' })).toHaveCount(1, { timeout: 5000 })
})

test('GitPanel 快捷拉取：同样带计数回执', async ({ page }) => {
  test.setTimeout(90000)
  teammatePush()
  await enterProject(page)
  await openGitPanel(page)

  // GitPanel 当前分支卡片快捷拉取（handleQuickPull；title=layout.pull「更新」，
  // 与 TopBar 的「拉取」区分，限定分支卡片防误中）
  await page.locator('.current-branch-card button[title="更新"]').click()
  await expect(page.locator('.n-message').filter({ hasText: 'Pull 成功：1 个新提交' })).toBeVisible({ timeout: 15000 })

  // 通知入账：正文含计数（分支名沿用既有 currentBranchInfo 来源，GitPanel 刚开时
  // 分支区未回前显示 HEAD 兜底——断言不钉分支名，只钉计数摘要本体）
  await openNotificationCenter(page)
  const row = page.locator('.nc-item').filter({ hasText: 'Pull 完成' }).filter({ hasText: '1 个新提交' }).first()
  await expect(row).toBeVisible({ timeout: 5000 })
})
