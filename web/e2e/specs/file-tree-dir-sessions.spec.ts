import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树目录会话驻留徽标（P-20261004-41）E2E：dir-agent（P-55）的反向可见性——
 *   1. 目录有 agent 会话 → 目录行徽标出现（terminals.changed 广播实时点亮）
 *   2. 徽标 tooltip（native title）列会话名/状态
 *   3. 点击徽标跳会话（useApprovalActions.jumpToSession 统一链 → 管理页激活），
 *      且不触发目录 toggle（click.stop）
 *   4. 同目录多会话 → 计数 2、点击先弹选择菜单，选行即跳
 *   5. 会话关闭（DELETE）→ 徽标消失（广播实时熄灭）
 * 会话经 API 直建（runtime=shell 纯终端，不依赖 agent 运行时安装）；徽标数据源
 * 是会话工作目录（无 OSC 7 帧回落创建 dir——sessionWorkingDir 收口），故服务端
 * 会话表 dir 即断言面。afterEach 清理全部终端会话（徽标计数断言基于空白会话表），
 * afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-dir-sessions')
const PROJ_NAME = 'e2e-dir-sessions'
const SUB_DIR = 'packages'
const SUB_FILE = 'inner.ts'
const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

let projectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」的徽标计数，残留会话会污染 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 直建 agent 会话（runtime=shell 纯终端）：返回会话 id 供关闭/定位断言 */
async function createAgentSession(request: APIRequestContext, dir: string, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', runtime: 'shell', name, dir: serverPath(dir) },
  })
  const body = (await res.json()) as { data?: { id?: string } }
  const id = body.data?.id || ''
  expect(id, 'agent 会话创建成功（服务端回 id）').not.toBe('')
  return id
}

/** 进入项目页并等文件树就绪（dir-agent-session 同款就绪等待口径） */
async function openProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage（每用例新 context 天然干净），
  // 显式清一次避免未来 context 复用时上例的 docked 管理页盖住文件树
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
}

/** 目标目录行 / 其上的驻留徽标 */
function subRow(page: Page) {
  return page.locator('.tree-item').filter({ hasText: SUB_DIR }).first()
}
function subBadge(page: Page) {
  return subRow(page).locator('[data-testid="dir-session-badge"]')
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, SUB_DIR), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# demo\n')
  fs.writeFileSync(path.join(REPO_DIR, SUB_DIR, SUB_FILE), 'export const inner = 1\n')
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: fixture'])

  // 注册项目：本地路径交服务端一律 serverPath() 包裹（跨拓扑双路径口径）
  const res = await fetch(BASE + '/api/projects', {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('目录有 agent 会话→徽标出现→tooltip 列名→点击跳转；会话关闭→徽标消失', async ({ page, request }) => {
  await openProject(page)
  const sessionName = 'badge-single'

  // 空白会话表：徽标缺席（目录行无按钮渲染）
  await expect(subBadge(page)).toHaveCount(0)

  // API 直建（页面在场）→ terminals.changed 广播实时点亮
  const sessionId = await createAgentSession(request, path.join(REPO_DIR, SUB_DIR), sessionName)
  await expect(subBadge(page)).toBeVisible({ timeout: 15000 })
  await expect(subBadge(page)).toHaveText('1')

  // tooltip（native title）：列会话名与状态（未连接不谎报运行态 → 空闲）
  await expect(subBadge(page)).toHaveAttribute('title', new RegExp(`${sessionName}.*空闲`))

  // 点击徽标跳会话（jumpToSession 统一链 → docked 管理页激活该会话），
  // 且 click.stop 不触发目录 toggle（子文件行不出现）
  await subBadge(page).click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1)
  await expect(view.locator('.ats-item.active')).toContainText(sessionName)
  await expect(page.locator('.tree-item').filter({ hasText: SUB_FILE })).toHaveCount(0)

  // 会话关闭（DELETE）→ 广播实时熄灭
  const headers = await unlockHeaders(request)
  await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers })
  await expect(subBadge(page)).toHaveCount(0, { timeout: 15000 })
})

test('同目录多会话→徽标计数 2→点击先弹选择菜单→选行跳对应会话', async ({ page, request }) => {
  await openProject(page)
  const nameA = 'badge-multi-a'
  const nameB = 'badge-multi-b'
  await createAgentSession(request, path.join(REPO_DIR, SUB_DIR), nameA)
  await createAgentSession(request, path.join(REPO_DIR, SUB_DIR), nameB)

  await expect(subBadge(page)).toBeVisible({ timeout: 15000 })
  await expect(subBadge(page)).toHaveText('2')
  // tooltip 两行清单：两会话名俱全
  const title = await subBadge(page).getAttribute('title')
  expect(title).toContain(nameA)
  expect(title).toContain(nameB)

  // 多会话点击 → NDropdown 选择菜单（右键菜单同宿主面），行文案含会话名
  await subBadge(page).click()
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible({ timeout: 10000 })
  await expect(menu.getByText(nameA)).toHaveCount(1)
  await expect(menu.getByText(nameB)).toHaveCount(1)

  // 选 B → 管理页激活 B
  await menu.getByText(nameB).click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toContainText(nameB)
})
