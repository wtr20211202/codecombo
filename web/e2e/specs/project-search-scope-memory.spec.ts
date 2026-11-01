import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 全局搜索项目范围记忆 E2E（P-20261003-69）：
 * 多选显式勾选两项目 → localStorage 即时持久化 → 整页重导航后重开面板恢复勾选
 * （搜索仍两项目分组）；删项目后重开 → 失效引用自动过滤（存储同步修剪 +
 * 只剩存活项目的单项目形态）；首次未显式选择时默认仅当前项目不变。
 * 范围记忆存 localStorage（全域），每个用例独立 context 天然隔离；
 * 自备临时仓库，afterAll 清理（范式与 search-projects 对称）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-scope-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-scope-b')
const PROJ_A = 'e2e-ssm-a'
const PROJ_B = 'e2e-ssm-b'
const SCOPE_KEY = 'project-search-scope'
const NEEDLE = 'ssmneedle'

let projIdA = ''
let projIdB = ''

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 项目范围记忆基线'])
}

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
  // 两项目同关键词：范围断言互不依赖文件名，靠项目分组头区分
  makeRepo(REPO_A, { 'na.txt': `${NEEDLE} alpha\n` })
  makeRepo(REPO_B, { 'nb.txt': `${NEEDLE} beta\n` })
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_A || p.name === PROJ_B) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  for (const dir of [REPO_A, REPO_B]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

async function openProjectSearch(page: import('@playwright/test').Page, projectName: string) {
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  return card
}

// 多选显式勾选两项目（naive-ui 多选菜单：点选项行即勾选，选完点卡内空白收起——
// 不点 mask（会关面板）也不碰「全部项目」快捷项（那条路径由 search-projects 覆盖））。
// 打开面板时当前项目默认预勾选（跟随当前项目的默认范围），故先按实况把 A 置为
// 未选再重新勾选，保证两项目都经显式勾选落地（终态 [A,B] 与初始态无关）
async function selectBothProjects(page: import('@playwright/test').Page, card: import('@playwright/test').Locator) {
  await card.locator('.ps-project-select').click()
  const menu = page.locator('.n-base-select-menu')
  await expect(menu).toBeVisible({ timeout: 3000 })
  const opts = menu.locator('.n-base-select-option')
  await expect(opts.filter({ hasText: PROJ_A })).toHaveCount(1, { timeout: 3000 })
  const optA = opts.filter({ hasText: PROJ_A })
  const optB = opts.filter({ hasText: PROJ_B })
  if ((await optA.getAttribute('class'))?.includes('--selected')) await optA.click()
  await optA.click()
  await optB.click()
  // 点结果区空白（query 为空时的提示行）收起下拉
  await card.locator('.ps-hint').click()
  await expect(menu).toBeHidden()
}

async function storedScope(page: import('@playwright/test').Page): Promise<string[]> {
  const raw = await page.evaluate((k) => window.localStorage.getItem(k), SCOPE_KEY)
  return raw ? (JSON.parse(raw) as string[]) : []
}

test('范围记忆：显式勾两项目持久化 → 整页重导航重开恢复勾选（首开无记忆走默认）', async ({ page }) => {
  await fixedLocale(page)
  let card = await openProjectSearch(page, PROJ_A)

  // 首开无记忆键：默认行为不变（仅当前项目，不打扰首次体验）
  expect(await page.evaluate((k) => window.localStorage.getItem(k), SCOPE_KEY)).toBeNull()

  // 显式勾选 A+B → 即时持久化
  await selectBothProjects(page, card)
  expect(await storedScope(page)).toEqual(expect.arrayContaining([projIdA, projIdB]))

  // 记忆范围立即生效：两项目分组结果
  await card.locator('.ps-input-row input').first().fill(NEEDLE)
  await expect(page.locator('.ps-project-group').filter({ hasText: PROJ_A })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.ps-project-group').filter({ hasText: PROJ_B })).toBeVisible({ timeout: 8000 })

  // 整页重导航（应用重启同路径 = 内存范围重置点）→ 重开面板 → 记忆恢复，仍是两项目分组
  card = await openProjectSearch(page, PROJ_A)
  await card.locator('.ps-input-row input').first().fill(NEEDLE)
  await expect(page.locator('.ps-project-group').filter({ hasText: PROJ_A })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.ps-project-group').filter({ hasText: PROJ_B })).toBeVisible({ timeout: 8000 })
  expect(await storedScope(page)).toEqual(expect.arrayContaining([projIdA, projIdB]))
})

test('删项目失效引用过滤：勾两项目 → 删 B → 重开面板只剩 A（存储同步修剪）', async ({ page }) => {
  await fixedLocale(page)
  let card = await openProjectSearch(page, PROJ_A)

  // 显式勾选 A+B 并持久化
  await selectBothProjects(page, card)
  expect(await storedScope(page)).toEqual(expect.arrayContaining([projIdA, projIdB]))

  // API 删除 B → 整页重导航（boot 重拉项目列表，B 从前端 store 消失）
  const headers = await unlockHeaders()
  const del = await fetch(`${API_BASE}/api/projects/${projIdB}`, { method: 'DELETE', headers })
  expect([200, 204]).toContain(del.status)
  card = await openProjectSearch(page, PROJ_A)

  // 重开即过滤：范围只剩 A，失效引用不进内存也不留存储
  await expect(card.locator('.ps-project-select')).toContainText(PROJ_A)
  await expect(card.locator('.ps-project-select')).not.toContainText(PROJ_B)
  expect(await storedScope(page)).toEqual([projIdA])

  // 搜索按修剪后范围跑：单项目形态（无分组头），B 的文件不出现
  await card.locator('.ps-input-row input').first().fill(NEEDLE)
  await expect(card.locator('.ps-stat-summary')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.ps-project-header')).toHaveCount(0)
  await expect(page.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  await expect(page.locator('.ps-file-header', { hasText: 'nb.txt' })).toHaveCount(0)
})
