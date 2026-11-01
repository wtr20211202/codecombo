import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 舰队发起侧栏入口（P-20261005-152）E2E：智能体侧栏「新建会话」旁的舰队钮
 * 直达 Layout 宿主的 FleetBulkAgentDialog（palette「批量 agent 任务」同一条
 * 弹层，P-20261003-291 的 UI 可达性补充）：
 *   1. docked 管理页侧栏出现舰队钮（enabled，title 为功能说明非置灰门槛）
 *   2. 点击 → 弹层打开（与 palette 入口同一弹层实例）
 * 置灰门槛（项目数 <2）由组件测试钉死（AgentTerminalSidebarFleet.test.ts）：
 * e2e 共享 :9999 服务端项目表（.e2e-data 跨套件持久 + 任意前序 spec 残留），
 * 无法确定性收敛到「恰好一个项目」，不在共享实例上删他人项目强造场景。
 * beforeAll 自建一个临时项目保证项目数 ≥2（enabled 路径确定性成立），
 * afterAll 清项目与夹具；本 spec 不发起编队、零会话残留。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-fleet-sidebar')
const PROJ = 'e2e-fleet-sidebar-proj'

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 按 name 查找已注册项目（find 幂等 upsert 语义，残留不重复建） */
async function findProjectId(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const body = (await res.json()) as { data?: { id: string; name: string }[] }
  return body.data?.find(p => p.name === name)?.id || ''
}

async function createRepoWithProject(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const stale = await findProjectId(request, PROJ)
  if (stale) await fetch(`${API_BASE}/api/projects/${stale}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), `# ${PROJ}\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', `c1: init ${PROJ}`])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

let projId = ''

test.beforeAll(async ({ request }) => {
  projId = await createRepoWithProject(request)
  expect(projId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projId) await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进项目页（侧栏挂载宿主是活动栏 agent docked 管理页） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

test('UI：侧栏舰队钮（enabled + 功能说明 title）→ 点击打开同一弹层', async ({ page }) => {
  await enterProject(page)

  // 活动栏入口 → docked 管理页（agent-terminal.spec 同链路）
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await expect(railBtn).toHaveCount(1)
  await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  // 侧栏舰队钮：项目数 ≥2（beforeAll 临时项目 + simple-coding）→ 可点且
  // title 是功能说明（携 Ctrl+K 可搜括注），而非「需两个以上项目」置灰门槛
  const fleetBtn = view.locator('[data-test="fleet-launch-entry"]')
  await expect(fleetBtn).toBeVisible({ timeout: 5000 })
  await expect(fleetBtn).toBeEnabled()
  await expect(fleetBtn).toHaveAttribute('title', /舰队发起/)
  await expect(fleetBtn).not.toHaveAttribute('title', /需两个以上项目/)

  // 点击 → 同一条 FleetBulkAgentDialog 打开（palette 入口共用同一弹层实例）
  await fleetBtn.click()
  const dlg = page.locator('.n-modal').filter({ hasText: '批量 agent 任务' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg.locator('[data-testid="fleet-bulk-projects"]')).toBeVisible()

  // 关闭收尾：不发起编队，零会话残留
  await dlg.getByRole('button', { name: '关闭' }).click()
  await expect(dlg).toBeHidden({ timeout: 5000 })
})
