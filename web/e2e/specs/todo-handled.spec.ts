import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * TODO 面板「已处理」勾选（P-20261003-200）E2E：
 *   1. 勾选已处理 → 条目从面板隐藏，总数不变（代码注释仍被扫描）、
 *      localStorage `todo.handled` 项目维落盘、reload 后仍隐藏
 *   2. 「显示已处理」开关 → 重现（删除线降透明），再关复隐；点击已处理条目
 *      打开文件定位——代码注释原样仍在（面板态与代码态解耦）
 *   3. 漂移容忍：代码行移动后刷新，陈旧 path:line 键失配、条目重现
 *      （localStorage 键保留不修剪——勾选与代码注释生命周期独立）
 *   4. 全部已处理 → 「全部已标记处理」空态；开关一键全重现
 * 自备临时仓库，afterAll 清理（范式与 todo-panel 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-todo-handled')
const PROJ = 'e2e-todo-handled'

let projId = ''

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

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: TODO 已处理勾选基线'])
}

const TODO_JS = '// todo lowercase noise\nconst x = 1\n// FIXME: check null\nconst y = 2\n// TODO: implement parser\n'

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  // todo.js 两组标记（FIXME:3 / TODO:5）+ extra.js 一条（TODO:1）→ 总数 3
  makeRepo(REPO, {
    'todo.js': TODO_JS,
    'extra.js': '// TODO: another file marker\n',
  })
  projId = await registerProject(headers, PROJ, REPO)
  expect(projId).toBeTruthy()
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
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

// 面板开关是 toggle 语义（上次会话可能停在 todos）：点开不可见则再点一次
async function openTodoPanel(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-todos"]').click()
  const panel = page.locator('[data-testid="todo-panel"]')
  try {
    await panel.waitFor({ state: 'visible', timeout: 2500 })
  } catch {
    await page.locator('[data-testid="rail-todos"]').click()
    await panel.waitFor({ state: 'visible', timeout: 5000 })
  }
  return panel
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
}

/** 条目行 hover 后点「已处理」勾选钮（浮现钮，与真实用户路径一致） */
async function markHandled(page: import('@playwright/test').Page, line: number) {
  const row = page.locator(`[data-testid="todo-item-${line}"]`)
  await row.hover()
  await page.locator(`[data-testid="todo-done-${line}"]`).click()
}

async function readHandledRecord(page: import('@playwright/test').Page): Promise<{ showHandled?: boolean; byProject?: Record<string, string[]> }> {
  const raw = await page.evaluate(() => localStorage.getItem('todo.handled'))
  return raw ? (JSON.parse(raw) as { showHandled?: boolean; byProject?: Record<string, string[]> }) : {}
}

test('勾选已处理 → 条目面板隐藏、总数不变（注释仍被扫描）、localStorage 项目维落盘、reload 仍隐藏', async ({ page }) => {
  await enterProject(page)
  const panel = await openTodoPanel(page)

  const todoGroup = panel.locator('.tp-file').filter({ hasText: 'todo.js' })
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('3', { timeout: 8000 })
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2)

  // 勾选 FIXME（todo.js:3）已处理 → 条目隐藏，总数不变（扫描口径=代码态）
  await markHandled(page, 3)
  await expect(todoGroup.locator('.tp-item')).toHaveCount(1)
  await expect(panel).not.toContainText('check null')
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('3')
  // 反馈：已处理计数 chip 出现（点按即显示开关）
  await expect(panel.locator('[data-testid="todo-handled-count"]')).toHaveText('已处理 1')

  // localStorage `todo.handled` 项目维：byProject[projId] 含 path:line 键
  const rec = await readHandledRecord(page)
  expect(rec.byProject?.[projId]).toContain('todo.js:3')

  // reload 后仍隐藏（localStorage 跨会话持久）
  await enterProject(page)
  const panel2 = await openTodoPanel(page)
  const todoGroup2 = panel2.locator('.tp-file').filter({ hasText: 'todo.js' })
  await expect(todoGroup2.locator('.tp-item')).toHaveCount(1)
  await expect(panel2).not.toContainText('check null')
  await expect(panel2.locator('[data-testid="todo-handled-count"]')).toHaveText('已处理 1')
})

test('显示已处理开关 → 重现（删除线态）→ 关闭复隐；点击已处理条目打开文件定位（代码注释仍在）', async ({ page }) => {
  await enterProject(page)
  const panel = await openTodoPanel(page)
  const todoGroup = panel.locator('.tp-file').filter({ hasText: 'todo.js' })
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2, { timeout: 8000 })

  await markHandled(page, 3)
  await expect(todoGroup.locator('.tp-item')).toHaveCount(1)

  // 开关打开：已处理条目重现，带已处理态（删除线降透明 + 勾选钮常驻显形）
  await panel.locator('[data-testid="todo-show-handled"]').click()
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2)
  const doneItem = todoGroup.locator('.tp-item').filter({ hasText: 'check null' })
  await expect(doneItem).toHaveClass(/tp-is-done/)
  await expect(doneItem.locator('[data-testid="todo-done-3"]')).toHaveClass(/tp-done-on/)

  // 关闭复隐；再开确认可逆，随后点击该条目 → 文件打开且定位行内容原样
  // （面板勾选不动代码——代码态与面板态解耦的直接证据）
  await panel.locator('[data-testid="todo-show-handled"]').click()
  await expect(todoGroup.locator('.tp-item')).toHaveCount(1)
  await panel.locator('[data-testid="todo-show-handled"]').click()
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2)
  await doneItem.locator('[data-testid="todo-item-3"]').click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('check null', { timeout: 15000 })
})

test('漂移容忍：代码行移动后刷新，陈旧 path:line 键失配、条目重现（键保留不修剪）', async ({ page }) => {
  await enterProject(page)
  const panel = await openTodoPanel(page)
  const todoGroup = panel.locator('.tp-file').filter({ hasText: 'todo.js' })
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2, { timeout: 8000 })

  await markHandled(page, 3)
  await expect(todoGroup.locator('.tp-item')).toHaveCount(1)

  // 面板外在文件头部插一行 → FIXME 从 3 挪到 4，旧键 todo.js:3 失配
  fs.writeFileSync(path.join(REPO, 'todo.js'), '// shifted\n' + TODO_JS)
  await panel.locator('[data-testid="todo-refresh"]').click()

  // 条目重现（不再被陈旧键隐藏）；计数 chip 归零隐藏（跟随面板可见口径）
  const shiftedGroup = panel.locator('.tp-file').filter({ hasText: 'todo.js' })
  await expect(shiftedGroup.locator('.tp-item')).toHaveCount(2, { timeout: 8000 })
  await expect(shiftedGroup.locator('[data-testid="todo-item-4"]')).toContainText('check null')
  await expect(panel.locator('[data-testid="todo-handled-count"]')).toHaveCount(0)
  // 键仍在 localStorage——勾选与代码注释生命周期独立，不做扫描回写修剪
  const rec = await readHandledRecord(page)
  expect(rec.byProject?.[projId]).toContain('todo.js:3')
})

test('全部勾选已处理 → 「全部已标记处理」空态；显示开关一键全重现', async ({ page }) => {
  await enterProject(page)

  // 夹具自足：不依赖前序用例的文件态，固定为已漂移形态（FIXME:4 / TODO:6）
  fs.writeFileSync(path.join(REPO, 'todo.js'), '// shifted\n' + TODO_JS)

  const panel = await openTodoPanel(page)
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('3', { timeout: 8000 })
  // 三条全部标记（todo.js 漂移后 FIXME:4 / TODO:6；extra.js:1）
  for (const line of [4, 6]) {
    await panel.locator('.tp-file').filter({ hasText: 'todo.js' }).locator(`[data-testid="todo-item-${line}"]`).hover()
    await panel.locator(`[data-testid="todo-done-${line}"]`).click()
  }
  await markHandled(page, 1)

  // 全部隐藏后整单空态（区别于「没有标记」）
  await expect(panel.locator('.tp-empty')).toContainText('全部已标记处理')
  await expect(panel.locator('.tp-item')).toHaveCount(0)

  // 开关一键全重现：全部带已处理态
  await panel.locator('[data-testid="todo-show-handled"]').click()
  await expect(panel.locator('.tp-item')).toHaveCount(3)
  await expect(panel.locator('.tp-item.tp-is-done')).toHaveCount(3)
  // 计数 chip 显示 3
  await expect(panel.locator('[data-testid="todo-handled-count"]')).toHaveText('已处理 3')
})
