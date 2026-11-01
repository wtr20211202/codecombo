import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * git 操作进行中反馈（P-20261005-211）E2E：
 *   commit 进行中：主按钮 loading+禁用（150ms 阈值后亮 spinner）、Ctrl+Enter
 *     再触发被前端闸拦下（「上一操作仍在进行」toast + 只发一笔请求不堆积）、
 *     结束后 loading 复位且提交落库。
 *   fetch 进行中：GitPanel 快捷钮禁用+图标旋转（同族 pull/push 一并落闸），
 *     结束后复位（失败路 finally 语义）。
 * 慢仓形态用 page.route 人为延迟响应模拟（大仓/弱网 10s+ 等价压缩）。
 * 自备临时仓库，afterAll 清理（范式与 commit-actions 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-git-ops-inflight')
const PROJ = 'e2e-git-ops-inflight'
const FILE = '.e2e-inflight.tmp'
const ROUTE_DELAY_MS = 1200 // > GIT_SPINNER_DELAY_MS(150)：延迟窗内 spinner 必已亮起

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'inflight v1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: inflight 基线提交'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
  // 留一笔未暂存的工作区改动，暂存走产品 API（与 commit-amend 同款准备）
  fs.appendFileSync(path.join(REPO_DIR, FILE), 'inflight v2\n')
  const stage = await fetch(`${API_BASE}/api/projects/${projectId}/stage`, {
    method: 'POST', headers, body: JSON.stringify({ files: [FILE] }),
  })
  expect(stage.ok).toBeTruthy()
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
  // 本 spec 运行期间 auto-save 的 uiState（底部 tab 选择）会污染后续 spec 布局
  // 恢复——与 commit-amend 收尾对称，local: null 归零（浅合并下传对象清不掉）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** rail「提交」是 toggle（uiState 恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

test('commit 进行中：loading+禁用、再触发去重不堆请求、结束复位落库', async ({ page }) => {
  await enterProject(page)
  await openCommitPanel(page)

  let commitRequests = 0
  await page.route('**/api/projects/*/commit', async (route) => {
    commitRequests++
    await new Promise((r) => setTimeout(r, ROUTE_DELAY_MS))
    await route.continue()
  })

  const textarea = page.locator('.cp-commit-area textarea')
  await expect(textarea).toBeVisible()
  await textarea.fill('feat: e2e inflight commit') // 合规信息直过门禁，不弹门禁层
  const commitBtn = page.locator('.cp-commit-actions').getByRole('button', { name: /提交 \(/ })
  await expect(commitBtn).toBeEnabled({ timeout: 10000 })
  await commitBtn.click()

  // 在飞窗内：按钮禁用 + loading spinner（延迟 >150ms 阈值，必亮）
  await expect(commitBtn).toBeDisabled()
  await expect(commitBtn).toHaveClass(/n-button--loading/)

  // 在飞再触发（Ctrl+Enter 绕过禁用按钮的面）：前端闸拦下 → busy 提示 + 不叠加请求
  await textarea.press('Control+Enter')
  await expect(page.locator('.n-message').filter({ hasText: '上一操作仍在进行' })).toBeVisible({ timeout: 3000 })
  expect(commitRequests).toBe(1) // 去重先拦：无第二个 commit 请求堆积

  // 结束：延迟窗过，请求放行 → 提交落库（root +1），loading 复位（finally 语义）
  await expect(page.locator('.n-message').filter({ hasText: '提交成功' })).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => git(REPO_DIR, ['rev-list', '--count', 'HEAD']), { timeout: 10000 }).toBe('2')
  await expect(commitBtn).not.toHaveClass(/n-button--loading/)
  expect(commitRequests).toBe(1)
})

test('fetch 进行中：快捷钮禁用+图标旋转（同族一并落闸），结束复位', async ({ page }) => {
  await enterProject(page)
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.cbc-actions').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  const fetchBtn = page.locator('.cbc-actions button[title="拉取"]') // layout.fetch（Git 惯例：fetch=获取分歧，此处沿既有 zh 词条）
  const pushBtn = page.locator('.cbc-actions button[title="推送"]')
  await expect(fetchBtn).toBeVisible()

  let fetchRequests = 0
  await page.route('**/api/projects/*/fetch', async (route) => {
    fetchRequests++
    await new Promise((r) => setTimeout(r, ROUTE_DELAY_MS))
    await route.continue()
  })

  await fetchBtn.click()
  // 在飞窗内：本钮禁用 + 图标旋转；同族 push 一并落闸（家族闸非全局锁）
  await expect(fetchBtn).toBeDisabled()
  await expect(fetchBtn.locator('.n-icon')).toHaveClass(/is-spinning/)
  await expect(pushBtn).toBeDisabled()
  expect(fetchRequests).toBe(1)

  // 结束（本仓无 remote，fetch 服务端失败走 catch）：finally 复位，不残留禁用/旋转
  await expect(fetchBtn).toBeEnabled({ timeout: 10000 })
  await expect(fetchBtn.locator('.n-icon')).not.toHaveClass(/is-spinning/)
  expect(fetchRequests).toBe(1)
})
