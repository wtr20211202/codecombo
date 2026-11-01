import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 跨项目全局搜索 E2E（P-20261002-17）：
 * 两个项目含同关键词 → 搜索勾「全部项目」→ 结果按项目分组渲染（组头项目名+命中数）→
 * 点击另一项目组内命中 → 先切项目再打开文件（顶栏选择器随切 + 编辑器内容对上）。
 * 另覆盖：默认仅当前项目（无项目组头，既有单项目形态）+ 批量端点单项目失败隔离（API）。
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。
 */

const REPO_A = path.join(os.tmpdir(), 'sc-e2e-search-proj-a')
const REPO_B = path.join(os.tmpdir(), 'sc-e2e-search-proj-b')
const PROJ_A = 'e2e-sp-a'
const PROJ_B = 'e2e-sp-b'

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
  git(dir, ['commit', '-m', 'root: 跨项目搜索基线'])
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
  // 两项目含同关键词 needle：A 两行命中（na.txt），B 一行命中（nb.txt）
  makeRepo(REPO_A, { 'na.txt': 'needle alpha\nfiller\nneedle beta\n' })
  makeRepo(REPO_B, { 'nb.txt': 'needle gamma\n' })
  projIdA = await registerProject(headers, PROJ_A, REPO_A)
  projIdB = await registerProject(headers, PROJ_B, REPO_B)
  expect(projIdA).toBeTruthy()
  expect(projIdB).toBeTruthy()
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
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

async function openProjectSearch(page: import('@playwright/test').Page, projectName: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  return card
}

test('全项目搜索：勾全部项目 → 两组结果按项目分组 → 点 B 组命中切项目打开', async ({ page }) => {
  const card = await openProjectSearch(page, PROJ_A)

  // 「全部项目」快捷项 → 范围覆盖 A+B
  await card.locator('.opt-chip').filter({ hasText: '全部项目' }).locator('.n-checkbox').click()

  await card.locator('.ps-input-row input').first().fill('needle')
  // 项目组头出现：组头 = 项目名 + 命中数（A 2 处 / B 1 处）
  const groupA = page.locator('.ps-project-group').filter({ hasText: PROJ_A })
  const groupB = page.locator('.ps-project-group').filter({ hasText: PROJ_B })
  await expect(groupA).toBeVisible({ timeout: 8000 })
  await expect(groupB).toBeVisible({ timeout: 8000 })
  await expect(groupA.locator('.ps-project-count')).toHaveText('2')
  await expect(groupB.locator('.ps-project-count')).toHaveText('1')

  // 点击 B 组内命中：先切项目再打开文件
  await groupB.locator('.ps-line').first().click()
  await expect(card).toBeHidden({ timeout: 3000 })
  // 顶栏项目选择器切到 B
  await expect(page.locator('.header-project-select')).toContainText(PROJ_B, { timeout: 8000 })
  // 编辑器打开的是 B 仓库文件（内容仅在 REPO_B 存在）
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('needle gamma', { timeout: 8000 })
})

test('默认仅当前项目：不勾全部项目 → 无项目组头（既有单项目形态）', async ({ page }) => {
  const card = await openProjectSearch(page, PROJ_A)

  await card.locator('.ps-input-row input').first().fill('needle')
  await expect(card.locator('.ps-stat-summary')).toBeVisible({ timeout: 8000 })
  // 单项目模式：不渲染项目组头，文件命中照常
  await expect(page.locator('.ps-project-header')).toHaveCount(0)
  await expect(page.locator('.monaco-editor .view-lines')).toBeHidden()
  await expect(page.locator('.ps-file-header', { hasText: 'na.txt' })).toBeVisible()
  // 未选 B 的结果（nb.txt 仅存在于 B）
  await expect(page.locator('.ps-file-header', { hasText: 'nb.txt' })).toHaveCount(0)
})

test('批量端点失败隔离：不存在项目只标错误组，正常项目照常返回（API）', async ({ page }) => {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/search/projects?ids=ghost,${projIdB}&q=needle`, { headers })
  expect(res.status).toBe(200)
  const body = (await res.json()) as {
    data?: Array<{ projectId: string; name?: string; matches?: unknown[]; error?: string }>
  }
  const groups = body.data || []
  expect(groups).toHaveLength(2)
  expect(groups[0].projectId).toBe('ghost')
  expect(groups[0].error).toBe('project not found')
  expect(groups[0].matches).toHaveLength(0)
  expect(groups[1].projectId).toBe(projIdB)
  expect(groups[1].error || '').toBe('')
  expect((groups[1].matches || []).length).toBeGreaterThanOrEqual(1)
})
