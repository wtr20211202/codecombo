import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * TODO 面板 E2E（P-20261002-25）：
 * 活动栏「TODO 清单」→ 文件分组列表（徽标 + 行号 + 注释文本）→ 点击条目
 * 打开文件并定位到对应行（深行锚点：未 reveal 时 Monaco 虚拟化不渲染该行，
 * 断言其出现在 .view-lines 即证明行定位生效）。另覆盖：小写 todo/忽略目录
 * 不计入（服务端整词+大小写+排除语义）、手动刷新重拉、500 上限截断（API）。
 * 自备临时仓库，afterAll 清理（范式与 search-projects 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-todo-panel')
const REPO_BIG = path.join(os.tmpdir(), 'sc-e2e-todo-big')
const PROJ = 'e2e-todo-panel'
const PROJ_BIG = 'e2e-todo-big'
const DEEP_ANCHOR = 'TODO: deep anchor marker'

let projId = ''
let projIdBig = ''

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
  git(dir, ['commit', '-m', 'root: TODO 面板基线'])
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ || p.name === PROJ_BIG) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO, REPO_BIG]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }

  // 主仓：todo.js 两组标记（FIXME/TODO）+ deep.js 深行锚点（Monaco 虚拟化下
  // 不 reveal 不渲染）+ 小写 todo 噪声行 + .gitignore 排除目录
  const pad = Array.from({ length: 150 }, (_, i) => `// pad ${i + 1}\n`).join('')
  makeRepo(REPO, {
    '.gitignore': 'ignored/\n',
    'todo.js': '// todo lowercase noise\nconst x = 1\n// FIXME: check null\nconst y = 2\n// TODO: implement parser\n',
    'deep.js': `${pad}${DEEP_ANCHOR}\n`,
    'ignored/secret.go': '// TODO: in ignored dir\n',
  })

  // 截断仓：501 条命中 → 服务端截到 500 + truncated（API 层断言）
  const bigLines = Array.from({ length: 501 }, (_, i) => `// TODO item ${i + 1}\n`).join('')
  makeRepo(REPO_BIG, { 'big.txt': bigLines })

  projId = await registerProject(headers, PROJ, REPO)
  projIdBig = await registerProject(headers, PROJ_BIG, REPO_BIG)
  expect(projId).toBeTruthy()
  expect(projIdBig).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ || p.name === PROJ_BIG) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  for (const dir of [REPO, REPO_BIG]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
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

test('TODO 面板：文件分组列出标记（噪声与忽略目录不计入）→ 点击深行条目定位到行', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = await openTodoPanel(page)

  // 面板头总数：todo.js 2 条（FIXME+TODO）+ deep.js 1 条 = 3
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('3', { timeout: 8000 })
  // 文件分组：组头文件名 + 组内条目
  const todoGroup = panel.locator('.tp-file').filter({ hasText: 'todo.js' })
  const deepGroup = panel.locator('.tp-file').filter({ hasText: 'deep.js' })
  await expect(todoGroup).toBeVisible()
  await expect(deepGroup).toBeVisible()
  await expect(todoGroup.locator('.tp-item')).toHaveCount(2)
  // 整词+大小写：小写 todo 噪声行不计入；.gitignore 目录排除
  await expect(panel).not.toContainText('lowercase noise')
  await expect(panel).not.toContainText('secret')
  // 徽标颜色分级：FIXME 与 TODO 各自的徽标类
  await expect(todoGroup.locator('.tp-badge.mk-fixme')).toHaveText('FIXME')
  await expect(todoGroup.locator('.tp-badge.mk-todo')).toHaveText('TODO')

  // 点击深行锚点（deep.js:151）：文件打开 + 行定位——锚点行未经 reveal 时
  // Monaco 虚拟化不渲染，出现在 .view-lines 即证明定位生效
  await deepGroup.locator('[data-testid="todo-item-151"]').click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('deep anchor marker', { timeout: 15000 })
})

test('TODO 面板：手动刷新重拉——新增文件标记经刷新出现', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const panel = await openTodoPanel(page)
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('3', { timeout: 8000 })
  await expect(panel).not.toContainText('late arrival')

  // 面板外改仓库（未跟踪新文件按工作区语义计入）→ 不刷新不出现，点刷新出现
  fs.writeFileSync(path.join(REPO, 'late.js'), '// HACK: late arrival\n')
  await panel.locator('[data-testid="todo-refresh"]').click()
  await expect(panel.locator('.tp-file').filter({ hasText: 'late.js' })).toBeVisible({ timeout: 8000 })
  await expect(panel.locator('[data-testid="todo-total"]')).toHaveText('4')
})

test('TODO 端点：501 条命中截到 500 + truncated 标记（API）', async () => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/projects/${projIdBig}/todos`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data?: Array<{ path: string; items: unknown[] }>
    total?: number
    truncated?: boolean
  }
  expect(body.truncated).toBe(true)
  expect(body.total).toBe(500)
  expect(body.data).toHaveLength(1)
  expect(body.data![0].path).toBe('big.txt')
  expect(body.data![0].items).toHaveLength(500)
})
