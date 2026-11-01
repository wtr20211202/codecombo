import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { dualTmpClean, dualTmpDir, serverPath } from '../../tests/dualpath'

/**
 * 分支行悬停提交预览浮窗（P-20261003-274）：
 *   1. hover 分支行 → 延迟浮窗弹出该分支最近 3 条提交（头部带分支 rev 全名，
 *      最新在前）
 *   2. 首开缓存：浮窗收起再悬停不重发 /log?branch= 请求
 *   3. 点击链不经过浮窗：hover 后点击仍选中行、右键菜单（切换到）照常弹出
 * 自备临时仓库，afterAll 清理（范式与 branch-checkout 对称）。
 */

const PROJ = 'e2e-hover-pop'
const FEAT = 'e2e-hover-feat'
// 缓存用例的专用计数分支：任何用例都不选中它（选中会让 CommitsPanel 拉它的
// log，污染请求计数）——uiState 残留/重试场景下计数面仍纯净
const CACHE = 'e2e-hover-cache'
const POPT = '[data-test="branch-log-pop"]'

let repoDir = ''
let projectId = ''

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

async function removeStaleProject(headers: Record<string, string>): Promise<void> {
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await removeStaleProject(headers)
  const { win } = dualTmpDir('sc-e2e-hover-pop-')
  repoDir = win
  execFileSync('git', ['init'], { cwd: repoDir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoDir }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: repoDir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: repoDir })
  // master：两条基线提交；e2e-hover-feat：三条可辨识提交（浮窗 3 条断言面）
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  git(repoDir, ['commit', '-m', 'root: 悬停基线提交'])
  fs.writeFileSync(path.join(repoDir, 'base.txt'), 'base\nmaster edit\n')
  execFileSync('git', ['add', '.'], { cwd: repoDir })
  git(repoDir, ['commit', '-m', 'master: 悬停对照提交'])
  git(repoDir, ['checkout', '-b', FEAT])
  for (const msg of ['一', '二', '三']) {
    fs.writeFileSync(path.join(repoDir, 'feat.txt'), `feat ${msg}\n`, { flag: 'a' })
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    git(repoDir, ['commit', '-m', `feat: hover 预览提交${msg}`])
  }
  git(repoDir, ['checkout', 'master'])
  // 缓存用例专用分支（与 master 同指即可，悬浮窗只读 log）
  git(repoDir, ['branch', CACHE])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(repoDir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) {
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers }).catch(() => {})
  }
  dualTmpClean(repoDir)
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  }).catch(() => {})
})

/** 进入项目并展开 Git 面板分支树，过滤定位到目标分支行（过滤激活无视折叠态，
 *  uiState 恢复的折叠状态不干扰定位） */
async function openBranchTree(page: import('@playwright/test').Page, branch = FEAT): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.branch-filter-row input').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.branch-filter-row input').fill(branch)
  await expect(page.locator('.branch-item', { hasText: branch })).toBeVisible({ timeout: 5000 })
}

test('hover 分支行 → 浮窗弹出该分支最近 3 条提交（最新在前）', async ({ page }) => {
  test.setTimeout(60000)
  await openBranchTree(page)

  const row = page.locator('.branch-item', { hasText: FEAT })
  await row.hover()
  const pop = page.locator(POPT)
  await expect(pop).toBeVisible({ timeout: 10000 })
  // 头部携带分支 rev 全名（浮窗归属上下文）
  await expect(pop.locator('[data-test="branch-log-pop-name"]')).toHaveText(FEAT)
  // 最近 3 条提交，最新在前（fixture 三条提交按 一/二/三 顺序落）
  const rows = pop.locator('[data-test="branch-log-pop-row"]')
  await expect(rows).toHaveCount(3)
  await expect(rows.nth(0)).toContainText('hover 预览提交三')
  await expect(rows.nth(1)).toContainText('hover 预览提交二')
  await expect(rows.nth(2)).toContainText('hover 预览提交一')
})

test('首开缓存：浮窗收起再悬停不重发 /log?branch= 请求', async ({ page }) => {
  test.setTimeout(60000)
  // 记账专用分支（CACHE）的 log 请求：它不被任何用例选中，CommitsPanel 等
  // 组件不会拉它的 log——计数面只有悬停浮窗自己的取数
  let logReqCount = 0
  page.on('request', (req) => {
    const u = new URL(req.url())
    if (u.pathname.endsWith('/log') && u.searchParams.get('branch') === CACHE) {
      logReqCount++
    }
  })
  await openBranchTree(page, CACHE)

  const row = page.locator('.branch-item', { hasText: CACHE })
  await row.hover()
  await expect(page.locator(POPT)).toBeVisible({ timeout: 10000 })
  await expect.poll(() => logReqCount, { timeout: 5000 }).toBe(1)

  // 移出到过滤输入行收起浮窗（duration 100ms）→ 再悬停：命中缓存，请求计数不变
  await page.locator('.branch-filter-row input').hover()
  await expect(page.locator(POPT)).toBeHidden({ timeout: 5000 })
  await row.hover()
  await expect(page.locator(POPT)).toBeVisible({ timeout: 10000 })
  await page.waitForTimeout(800)
  expect(logReqCount).toBe(1)
})

test('点击链不经过浮窗：hover 后点击仍选中、右键菜单照常', async ({ page }) => {
  test.setTimeout(60000)
  await openBranchTree(page)

  const row = page.locator('.branch-item', { hasText: FEAT })
  await row.hover()
  await expect(page.locator(POPT)).toBeVisible({ timeout: 10000 })
  // 点击仍走选中链（浮窗只读呈现，不拦截点击）
  await row.click()
  await expect(row).toHaveClass(/selected/, { timeout: 5000 })
  // 右键菜单（切换到等分支动作入口）不被浮窗遮断
  await row.click({ button: 'right' })
  await expect(page.locator('.n-dropdown-menu').getByText('切换到', { exact: true })).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Escape')
})
