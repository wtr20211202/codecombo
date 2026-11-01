import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目仪表盘 E2E（P-20261005-224）：进项目先看状态再动手的项目级一屏聚合。
 * ①活动仓（2 提交 + 1 脏文件）经活动栏按钮进仪表盘：git 卡分支/脏文件数/最近
 *   提交、会话卡空态、问题卡空态、活动卡空态逐一呈现 → 点卡直达（git 底部面板/
 *   问题底部面板/会话管理页/变更流侧栏）；②?view=dashboard 深链直达；③全零态
 *   紧凑条（干净仓不摆空卡）；④默认落点：uiState 偏好开启后从首页进项目主区
 *   先落仪表盘。自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-dashboard-active')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-dashboard-calm')
const PROJ_A = 'e2e-dashboard-active'
const PROJ_B = 'e2e-dashboard-calm'
const COMMIT_SUBJECTS = ['root: dashboard 基线', 'second: dashboard 第二提交']

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

function makeRepo(dir: string, files: Record<string, string>, commits: string[]) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '--initial-branch=master'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  const names = Object.keys(files)
  for (let i = 0; i < commits.length; i++) {
    fs.writeFileSync(path.join(dir, names[i]!), files[names[i]!])
    git(dir, ['add', '.'])
    git(dir, ['commit', '-m', commits[i]!])
  }
}

/** 首页进项目（点击项目卡，显式选择链）→ 等项目页就绪 */
async function enterProjectFromHome(page: import('@playwright/test').Page, name: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: name }).first().click()
  await page.waitForURL('**/project')
  await expect(page.locator('[data-testid="rail-dashboard"]')).toBeVisible()
}

/** 打开仪表盘（幂等）：rail 按钮是 toggle 语义，而 git/问题卡直达只开底部面板
 *  不动主区——仪表盘已可见时再点会把 toggle 成收起，故先查可见性再点 */
async function openDashboard(page: import('@playwright/test').Page) {
  const view = page.locator('[data-testid="dashboard-view"]')
  if (await view.isVisible().catch(() => false)) return
  await page.locator('[data-testid="rail-dashboard"]').click()
  await expect(view).toBeVisible()
}

let projAId = ''
let projBId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }

  // 仓 A（活动）：两个提交 + 未提交改动（注册前完成全部写盘——file.changed 只
  // 在注册后产生，近期活动卡因此保持空态，与「干净远程同步」以外的唯一信号是脏文件）
  makeRepo(REPO_A, { 'a.txt': 'one\n', 'b.txt': 'two\n' }, COMMIT_SUBJECTS)
  fs.writeFileSync(path.join(REPO_A, 'a.txt'), 'one\ndirty change\n')
  projAId = await registerProject(headers, PROJ_A, REPO_A)
  expect(projAId).toBeTruthy()

  // 仓 B（平静）：单提交、无脏文件、无远程 → 全零态
  makeRepo(REPO_B, { 'only.txt': 'calm\n' }, ['root: calm 基线'])
  projBId = await registerProject(headers, PROJ_B, REPO_B)
  expect(projBId).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
  // 复位本机 uiState：清掉默认落点偏好与测试期项目残留（problems-panel 同款）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

test('仪表盘四卡数据正确，点卡直达对应面板', async ({ page }) => {
  await enterProjectFromHome(page, PROJ_A)
  await openDashboard(page)

  const view = page.locator('[data-testid="dashboard-view"]')
  // 未命中全零态：脏文件在场 → 四卡栅格而非紧凑条
  await expect(page.locator('[data-testid="dashboard-calm"]')).toHaveCount(0)

  // git 卡：分支 chip / 脏文件数 / 最近提交（最新在前，基名截断内含主题串）
  const gitCard = page.locator('[data-testid="dashboard-card-git"]')
  await expect(gitCard).toBeVisible()
  await expect(gitCard.locator('[data-testid="dashboard-branch"]')).toHaveText('master')
  await expect(gitCard.locator('[data-testid="dashboard-dirty"]')).toHaveText('1 个未提交文件')
  await expect(gitCard.locator('.commit-msg').filter({ hasText: COMMIT_SUBJECTS[1]! })).toBeVisible()
  await expect(gitCard.locator('.commit-msg').filter({ hasText: COMMIT_SUBJECTS[0]! })).toBeVisible()

  // 会话卡 / 问题卡 / 活动卡空态文案
  await expect(page.locator('[data-testid="dashboard-card-sessions"]')).toContainText('本项目暂无终端会话')
  await expect(page.locator('[data-testid="dashboard-card-problems"]')).toContainText('当前打开的文件没有问题')
  await expect(page.locator('[data-testid="dashboard-card-activity"]')).toContainText('近期没有文件改动')

  // 点 git 卡 → 底部面板落 git tab
  await gitCard.click()
  await expect(page.locator('[data-testid="bottom-tab-git"]')).toHaveClass(/primary/, { timeout: 5000 })

  // 重开仪表盘 → 点问题卡 → 底部面板落问题 tab
  await openDashboard(page)
  await page.locator('[data-testid="dashboard-card-problems"]').click()
  await expect(page.locator('[data-testid="bottom-tab-problems"]')).toHaveClass(/primary/, { timeout: 5000 })

  // 重开仪表盘 → 点会话卡 → 智能体管理页 docked 接管主区
  await openDashboard(page)
  await page.locator('[data-testid="dashboard-card-sessions"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })

  // 重开仪表盘 → 点活动卡 → 侧栏落变更流面板
  await openDashboard(page)
  await page.locator('[data-testid="dashboard-card-activity"]').click()
  await expect(page.locator('[data-testid="change-stream-panel"]')).toBeVisible({ timeout: 5000 })

  // 回到仪表盘：编辑器被仪表盘盖住（主区互斥），视图保活不重建（v-show）
  await openDashboard(page)
  await expect(view).toBeVisible()
})

test('?view=dashboard 深链直达仪表盘', async ({ page }) => {
  await enterProjectFromHome(page, PROJ_A)
  // 已在项目页：携 query 重新进入（SPA 冷启动形态），view 消费后 query 被清
  await gotoAndUnlock(page, `${API_BASE}/project?view=dashboard`)
  await expect(page.locator('[data-testid="dashboard-view"]')).toBeVisible()
})

test('全零态紧凑呈现：干净仓不摆空卡', async ({ page }) => {
  await enterProjectFromHome(page, PROJ_B)
  await openDashboard(page)

  // 紧凑条：平静文案 + 分支 chip；四卡栅格不存在
  const calm = page.locator('[data-testid="dashboard-calm"]')
  await expect(calm).toBeVisible()
  await expect(calm).toContainText('一切平静')
  await expect(calm.locator('[data-testid="dashboard-calm-branch"]')).toHaveText(/master/)
  await expect(calm).toContainText('root: calm 基线')
  await expect(page.locator('[data-testid="dashboard-card-git"]')).toHaveCount(0)
  await expect(page.locator('[data-testid="dashboard-card-sessions"]')).toHaveCount(0)

  // 紧凑条分支 chip 仍可达 git 面板（直达接线不因紧凑态缺席）
  await calm.locator('[data-testid="dashboard-calm-branch"]').click()
  await expect(page.locator('[data-testid="bottom-tab-git"]')).toHaveClass(/primary/, { timeout: 5000 })
})

test('默认落点：偏好开启后从首页进项目主区先落仪表盘', async ({ page }) => {
  // 经真实持久化链置偏好（PATCH /ui-state 键级补丁，与设置分区保存同端点）
  const headers = await unlockHeaders()
  const patch = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: { dashboard: { landing: true } } }),
  })
  expect([200, 204]).toContain(patch.status)

  await enterProjectFromHome(page, PROJ_A)
  // 显式进入（首页点击）+ 偏好开 → 主区先落仪表盘（编辑器让位，底部面板不受影响）
  await expect(page.locator('[data-testid="dashboard-view"]')).toBeVisible({ timeout: 10000 })

  // 「看状态」让位「动手」：打开文件即收回仪表盘（showEditorMain → closeDashboard）。
  // rail-files 是 toggle（侧栏已开且在 files 视图时再点=收起）：两步点击兜底
  // 上次用例残留的侧栏状态
  const treeItem = page.locator('.file-tree .item-name', { hasText: 'a.txt' }).first()
  await page.locator('[data-testid="rail-files"]').click()
  if (!(await treeItem.isVisible().catch(() => false))) {
    await page.locator('[data-testid="rail-files"]').click()
  }
  await treeItem.click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: 'a.txt' })).toBeVisible()
  await expect(page.locator('[data-testid="dashboard-view"]')).toBeHidden()
})
