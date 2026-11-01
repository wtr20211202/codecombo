import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 克隆目标目录预检（P-20261003-26）：POST /api/clone 对「已存在且非空」目标目录
 * 在任务创建前 400（稳定原文 destination directory already exists and is not empty），
 * 前端 CloneModal 把失败时点从「git 跑一阵后的任务中途」前移到「点击瞬间」——
 * 表单行内显示「目标目录已存在且非空」（clone.destExists.label），不启动任务。
 * 空目录 / 不存在目录按 git 语义放行（200 + taskId）。
 *
 * 数据面：克隆弹窗经首页空态入口打开——beforeEach 快照全部项目后逐个移除注册
 * （不删磁盘目录），afterEach 恢复（同 home-empty-guide 套路）；API 用例的
 * bogus URL 任务快速失败且不注册项目，仅各留一条克隆失败通知（clone-cancel 同）。
 */

type ProjectSnapshot = { id: string; name: string; path: string }

const PROJ_PREFIX = 'e2e-clone-precheck'
const NONEMPTY_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-precheck-nonempty')
const EMPTY_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-precheck-empty')
const MISSING_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-precheck-missing', 'not-created')
const BOGUS_URL = 'file:///nonexistent-sc-clone-precheck-src'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let saved: ProjectSnapshot[] = []

test.beforeAll(async () => {
  // 非空目录夹具：一个文件即非空；空目录夹具保持空；MISSING_DIR 不创建
  fs.rmSync(NONEMPTY_DIR, { recursive: true, force: true })
  fs.mkdirSync(NONEMPTY_DIR, { recursive: true })
  fs.writeFileSync(path.join(NONEMPTY_DIR, 'occupied.txt'), 'x')
  fs.rmSync(EMPTY_DIR, { recursive: true, force: true })
  fs.mkdirSync(EMPTY_DIR, { recursive: true })
})

test.afterAll(async () => {
  for (const dir of [NONEMPTY_DIR, EMPTY_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

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

test('UI：克隆到非空目录点击即表单行内错误，任务不启动', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 首页空态入口打开克隆弹窗（项目列表已被 beforeEach 清空）
  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })
  await empty.getByRole('button', { name: '从 URL 克隆项目' }).click()

  const modal = page.locator('.n-modal').filter({ hasText: '克隆远程仓库' })
  await expect(modal).toBeVisible({ timeout: 5000 })

  await modal.locator('input[placeholder*="https://github.com"]').fill(BOGUS_URL)
  // 目标目录按服务端形态交接（跨拓扑时 serverPath 转换）
  await modal.locator('input[placeholder*="D:/workspace"]').fill(serverPath(NONEMPTY_DIR))

  await modal.locator('button').filter({ hasText: /^克隆$/ }).click()

  // 失败时点前移：点击瞬间表单行内错误，弹窗不关、不进克隆运行态
  const inlineError = modal.locator('[data-testid="clone-dir-error"]')
  await expect(inlineError).toBeVisible({ timeout: 5000 })
  await expect(inlineError).toHaveText('目标目录已存在且非空')
  await expect(modal).toBeVisible()
  await expect(modal.locator('.clone-running')).toHaveCount(0)

  // 改目录即清除行内错误
  await modal.locator('input[placeholder*="D:/workspace"]').fill(serverPath(EMPTY_DIR))
  await expect(inlineError).toHaveCount(0)

  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('API：空目录放行（200 + taskId）', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone`, {
    headers,
    data: { url: BOGUS_URL, dir: serverPath(EMPTY_DIR), name: `${PROJ_PREFIX}-empty` },
  })
  expect(res.status()).toBe(200)
  const tid = ((await res.json()) as { taskId?: string }).taskId
  expect(tid).toBeTruthy()
  // bogus URL 任务快速失败，cancel 幂等收尾（已结束返回 404 不影响断言）
  await request.post(`${API_BASE}/api/clone/${tid}/cancel`, { headers })
})

test('API：不存在目录放行（200 + taskId）', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone`, {
    headers,
    data: { url: BOGUS_URL, dir: serverPath(MISSING_DIR), name: `${PROJ_PREFIX}-missing` },
  })
  expect(res.status()).toBe(200)
  const tid = ((await res.json()) as { taskId?: string }).taskId
  expect(tid).toBeTruthy()
  await request.post(`${API_BASE}/api/clone/${tid}/cancel`, { headers })
})

test('API：非空目录 400 稳定原文，任务未创建', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone`, {
    headers,
    data: { url: BOGUS_URL, dir: serverPath(NONEMPTY_DIR), name: `${PROJ_PREFIX}-occupied` },
  })
  expect(res.status()).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toBe('destination directory already exists and is not empty')
  // 任务未创建：无任何以本前缀命名的项目注册（兜底断言，快照恢复前清理）
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const names = ((list?.data || []) as Array<{ name: string }>).map(p => p.name)
  expect(names.filter(n => n.startsWith(PROJ_PREFIX))).toHaveLength(0)
})
