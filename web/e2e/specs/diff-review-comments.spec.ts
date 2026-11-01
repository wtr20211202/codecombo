import { test, expect, type APIRequestContext, type Page, type Locator } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 审阅留言（P-20261003-279）E2E：产出 diff（diff:HEAD:wt）的行级「这里
 * 要改」沉淀——加留言 → 行侧标记 → 整页重开后还在 → 勾选解除。四用例按剧情
 * 串行（uiState 是服务端全局态，前一条留言是后一条的前置）：
 *   1. 右键改动行「添加审阅留言」→ prompt 弹窗落文 → modified 侧行侧标记出现，
 *      PATCH /api/ui-state 落盘（重开还在的数据前提）
 *   2. 整页刷新重开同一 diff → 标记还在（uiState 持久化往返）
 *   3. 右键留言行「标记已处理」→ 标记转已解除样式（绿弱化）；「取消已处理」
 *      复原
 *   4. 行锚点漂移容忍：上方插入一行后重开 diff → 留言按内容锚跟随到新行
 *     （新行有编辑菜单态、旧行没有），条数恒 1 不复制
 * 菜单驱动沿 ask-selection/diff-ask-line 实测口径：Monaco 菜单在 shadow DOM，
 * 点击与聚焦+Enter 交替重试直至目标态达成。自备临时仓库，afterAll 清理项目
 * 与夹具并清空本实例 uiState（留言表归零）
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-review-comments')
const PROJ = 'e2e-diff-review-comments'
const FILE = 'review.txt'
const ADD_LABEL = '添加审阅留言'
const EDIT_LABEL = '编辑留言'
const RESOLVE_LABEL = '标记已处理'
const UNRESOLVE_LABEL = '取消已处理'
const COMMENT_TEXT = '这里要改回来'

const C1_CONTENT = 'alpha\nbeta\ngamma\n'
const WT_CONTENT = 'alpha\nbeta EDITED in worktree\ngamma\n'
// 漂移夹具：顶部插入一行 → 原第 2 行内容整体下移到第 3 行
const WT_DRIFTED_CONTENT = 'inserted top line\n' + WT_CONTENT

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  // 工作区未提交修改（产出审阅对象；第 2 行改动 → 固定锚）
  fs.writeFileSync(path.join(REPO_DIR, FILE), WT_CONTENT)

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 清空本实例 uiState（含 diffComments 留言表），不给后续 spec 留状态
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

async function enterProject(page: Page) {
  await fixedLocale(page)
  // 防御：agent 终端开合状态是 localStorage，显式清一次避免 docked 管理页盖住编辑器
  await page.addInitScript(() => {
    localStorage.removeItem('sc.agentTerminal.openState')
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟弹出的「建议修改默认密码」提醒遮罩拦点击（时序不定）——出现即收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

// rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见
async function openCommitPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-panel')).toBeVisible()
}

/** 打开变更面板工作区 diff（diff:HEAD:wt:<file>）：双击变更树文件行 */
async function openWorkspaceDiff(page: Page) {
  await enterProject(page)
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: FILE })).toBeVisible({ timeout: 10000 })
  await page.locator('.cp-node').filter({ hasText: FILE }).first().dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  // 留言懒加载（ensureLoaded）与装饰重放有异步窗口：等标记车道稳定一拍
  await page.waitForTimeout(800)
}

/** 右键 modified 侧第 nth 行（1-based 视口序）并返回上下文菜单定位 */
async function openContextMenuAtLine(page: Page, nth: number) {
  await page.locator(`.monaco-diff-editor .editor.modified .view-line`).nth(nth).click({ button: 'right' })
  const menu = page.locator('.context-view .monaco-menu, .monaco-menu-container .monaco-menu')
  await expect(menu.first()).toBeVisible({ timeout: 3000 })
  return { menu: menu.first(), item: (label: string) => menu.first().locator('.action-item').filter({ hasText: label }) }
}

/** 触发菜单项并等 until 达成：headless 下 shadow DOM 菜单聚焦状态不定，鼠标
 *  点击与键盘 Enter 交替重试（diff-ask-line.spec 同款实测口径） */
async function driveMenuItem(page: Page, item: Locator, until: () => Promise<boolean>) {
  for (let attempt = 0; attempt < 6 && !(await until()); attempt++) {
    if (attempt % 2 === 0) {
      await item.click({ timeout: 3000 }).catch(() => { /* 菜单瞬时失焦即关：下一轮键盘 */ })
    } else {
      await item.focus()
      await expect(item).toBeFocused().catch(() => { /* 焦点被夺：下一轮重试 */ })
      await page.keyboard.press('Enter')
    }
    await expect.poll(until, { timeout: 2000, intervals: [200, 500, 1000] }).toBe(true).catch(() => { /* 本轮未触发：换下一轮 */ })
  }
  expect(await until(), `菜单项驱动未达成目标态：${item}`).toBe(true)
}

/** modified 侧行侧留言标记（未解除/全部） */
function commentMarks(page: Page, selector = '') {
  return page.locator(`.monaco-diff-editor .editor.modified .sc-diff-comment-mark${selector}`)
}

test('右键改动行「添加审阅留言」→ 行侧标记出现且 PATCH 落盘', async ({ page }) => {
  await openWorkspaceDiff(page)

  const { item } = await openContextMenuAtLine(page, 1)
  await expect(item(ADD_LABEL), '右侧=工作区版本 → 添加留言菜单项出现').toBeAttached()
  // PATCH 在确认后发出：按载荷含 diffComments 键判定（防布局 auto-save 的无关
  // PATCH 抢先解除等待），先挂响应等待再驱动
  const patchDone = page.waitForResponse(
    (r) => {
      if (r.request().method() !== 'PATCH' || !r.url().includes('/api/ui-state')) return false
      try {
        return JSON.stringify(r.request().postDataJSON()).includes('diffComments')
      } catch { return false }
    },
    { timeout: 15000 },
  )
  await driveMenuItem(page, item(ADD_LABEL), async () => {
    return page.locator('.n-dialog').isVisible().catch(() => false)
  })

  // prompt 弹窗（按标题过滤，与其他 .n-dialog 区分）：填留言正文 → 确认
  const dialog = page.locator('.n-dialog').filter({ hasText: '审阅留言' })
  await expect(dialog).toBeVisible()
  await dialog.locator('.n-input input').fill(COMMENT_TEXT)
  await dialog.locator('.n-button').filter({ hasText: '确认' }).click()
  await patchDone

  // 行侧标记出现（未解除样式），恰一条
  await expect(commentMarks(page)).toHaveCount(1, { timeout: 5000 })
  await expect(commentMarks(page, '.is-resolved')).toHaveCount(0)
})

test('整页刷新后重开同一 diff：留言标记还在（持久化往返）', async ({ page }) => {
  // Playwright 每用例全新 context：此处打开 diff 前没有任何内存态，标记只能
  // 来自服务端 uiState（t1 的 PATCH）——即「重开还在」的强断言
  await openWorkspaceDiff(page)
  await expect(commentMarks(page)).toHaveCount(1)
  await expect(commentMarks(page, '.is-resolved')).toHaveCount(0)
})

test('右键留言行「标记已处理」→ 已解除样式；「取消已处理」复原', async ({ page }) => {
  await openWorkspaceDiff(page)
  await expect(commentMarks(page)).toHaveCount(1)

  const { item } = await openContextMenuAtLine(page, 1)
  await expect(item(RESOLVE_LABEL), '留言行出现解除菜单（scDiffCommented 为真）').toBeAttached()
  await expect(item(ADD_LABEL), '已有留言行不再出现添加菜单（一行一条）').toHaveCount(0)
  await driveMenuItem(page, item(RESOLVE_LABEL), async () => {
    return (await commentMarks(page, '.is-resolved').count()) === 1
  })
  await expect(commentMarks(page)).toHaveCount(1)

  // 取消解除复原
  const again = await openContextMenuAtLine(page, 1)
  await expect(again.item(UNRESOLVE_LABEL)).toBeAttached()
  await driveMenuItem(page, again.item(UNRESOLVE_LABEL), async () => {
    return (await commentMarks(page, '.is-resolved').count()) === 0
  })
  await expect(commentMarks(page)).toHaveCount(1)
})

test('行锚点漂移容忍：上方插入一行重开 → 留言按内容锚跟随到新行', async ({ page }) => {
  await openWorkspaceDiff(page)
  await expect(commentMarks(page)).toHaveCount(1)

  fs.writeFileSync(path.join(REPO_DIR, FILE), WT_DRIFTED_CONTENT)
  await openWorkspaceDiff(page)
  await expect(commentMarks(page), '跟随不复制，仍恰一条').toHaveCount(1)

  // 新行（原第 2 行内容现位于视口第 3 行）有留言菜单态；旧行没有
  const { item } = await openContextMenuAtLine(page, 2)
  await expect(item(EDIT_LABEL), '留言按内容锚跟随到新行').toBeAttached()
  const oldLine = await openContextMenuAtLine(page, 1)
  await expect(oldLine.item(EDIT_LABEL), '原行号已无留言').toHaveCount(0)
})
