import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 克隆前远端分支预取（P-20261003-93）：POST /api/clone/branches 对 URL 跑
 * ls-remote --heads（凭据注入语义同克隆），克隆弹窗「拉取分支」小钮 → 分支
 * 下拉可选（不选=默认分支）；失败 502 稳定标记 remote branch prefetch failed
 * → 行内提示，不阻断克隆。本地 file:// 仓库当远端（零网络零凭据）。
 *
 * UI 用例经首页空态入口打开克隆弹窗——beforeEach 快照全部项目后逐个移除注册
 * （不删磁盘目录），afterEach 恢复（同 clone-dest-precheck 套路）；用例只预取
 * 不启动克隆，零项目注册零通知残留。
 */

type ProjectSnapshot = { id: string; name: string; path: string }

const REMOTE_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-branch-remote')
const REMOTE_URL = pathToFileURL(REMOTE_DIR).href
const BOGUS_URL = pathToFileURL(path.join(os.tmpdir(), 'sc-e2e-clone-branch-no-such-repo')).href
const EXPECTED_BRANCHES = ['feat/a', 'feat/x', 'main']

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function git(args: string): void {
  execSync(`git ${args}`, { stdio: 'pipe' })
}

test.beforeAll(() => {
  fs.rmSync(REMOTE_DIR, { recursive: true, force: true })
  fs.mkdirSync(REMOTE_DIR, { recursive: true })
  git(`init -b main "${REMOTE_DIR}"`)
  git(`-C "${REMOTE_DIR}" -c user.name=t -c user.email=t@t commit --allow-empty -m init`)
  git(`-C "${REMOTE_DIR}" branch feat/a`)
  git(`-C "${REMOTE_DIR}" branch feat/x`)
})

test.afterAll(() => {
  try { fs.rmSync(REMOTE_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

let saved: ProjectSnapshot[] = []

test.beforeEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  saved = ((list?.data || []) as ProjectSnapshot[])
    .map(p => ({ id: p.id, name: p.name, path: p.path }))
  for (const p of saved) {
    await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
  }
})

test.afterEach(async ({ request }) => {
  const headers = await unlockHeaders()
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as ProjectSnapshot[])) {
    await request.delete(`${API_BASE}/api/projects/${p.id}`, { headers })
  }
  for (const p of saved) {
    await request.post(`${API_BASE}/api/projects`, { headers, data: { name: p.name, path: p.path } })
  }
})

async function openCloneModal(page: import('@playwright/test').Page) {
  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })
  await empty.getByRole('button', { name: '从 URL 克隆项目' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: '克隆远程仓库' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test('UI：拉取分支 → 下拉可选，选中即填入；改 URL 丢弃旧列表', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const modal = await openCloneModal(page)

  await modal.locator('input[placeholder*="https://github.com"]').fill(REMOTE_URL)
  await modal.locator('[data-testid="clone-fetch-branches"]').click()

  // 预取成功：分支输入框切换为可搜下拉，选项含全部 heads（file:// 远端秒回）
  const select = modal.locator('[data-testid="clone-branch-select"]')
  await expect(select).toBeVisible({ timeout: 10000 })
  await select.click()
  const menu = page.locator('.n-base-select-menu')
  await expect(menu).toBeVisible()
  for (const b of EXPECTED_BRANCHES) {
    await expect(menu.locator('.n-base-select-option').filter({ hasText: b })).toHaveCount(1)
  }

  // 选中 feature 分支（clone --branch 的取值面）
  await menu.locator('.n-base-select-option').filter({ hasText: 'feat/x' }).click()
  await expect(select).toContainText('feat/x')

  // 改 URL 即丢弃旧列表：下拉退回手填输入框（列表只对拉取时的 URL 成立）
  await modal.locator('input[placeholder*="https://github.com"]').fill(BOGUS_URL)
  await expect(select).toHaveCount(0)

  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('UI：错误 URL 行内明确提示，不阻断克隆', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const modal = await openCloneModal(page)

  await modal.locator('input[placeholder*="https://github.com"]').fill(BOGUS_URL)
  await modal.locator('[data-testid="clone-fetch-branches"]').click()

  // 502 稳定标记 repository not found → 行内本地化文案（clone.branches.failedNotFound）
  const err = modal.locator('[data-testid="clone-branch-error"]')
  await expect(err).toBeVisible({ timeout: 10000 })
  await expect(err).toHaveText('拉取分支失败：仓库不存在或无访问权限')

  // 不阻断：克隆主按钮仍可点（预取失败只是提示，分支可手填/留空走默认）
  await expect(modal.locator('button').filter({ hasText: /^克隆$/ })).toBeEnabled()

  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('API：本地远端返回 heads 全集（ref 字典序）', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone/branches`, {
    headers,
    data: { url: REMOTE_URL },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data?: string[] }
  expect(body.data).toEqual(EXPECTED_BRANCHES)
})

test('API：不存在的仓库 502 稳定标记 repository not found', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone/branches`, {
    headers,
    data: { url: BOGUS_URL },
  })
  expect(res.status()).toBe(502)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toContain('remote branch prefetch failed: repository not found')
})

test('API：缺 url 400', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone/branches`, { headers, data: {} })
  expect(res.status()).toBe(400)
})
