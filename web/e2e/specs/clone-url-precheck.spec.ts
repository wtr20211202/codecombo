import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 克隆 URL 形态预检（P-20261003-70）：POST /api/clone 对打错形态的 URL（少冒号、
 * 含空白/全角字符）400（稳定原文 invalid clone URL，前端 KNOWN_ERROR_I18N 映射
 * clone.urlInvalid.label）；CloneModal 打字瞬间行内红提示（不阻断输入），提交前
 * 拦下不发请求；异形但从宽放行（ssh:// 自定义端口长形、file://、SCP 短形、本地
 * 路径）——宁可漏报不误拦。
 *
 * 数据面：同 clone-dest-precheck 套路——beforeEach 快照全部项目后逐个移除注册
 * （不删磁盘目录），afterEach 恢复；API 放行态的不可达来源任务秒败不注册项目，
 * cancel 幂等收尾。UI「请求未发出」用非空目录作绊线：若请求发出，服务端目录
 * 预检会先行 400 并点亮 clone-dir-error。
 */

type ProjectSnapshot = { id: string; name: string; path: string }

const PROJ_PREFIX = 'e2e-clone-url-precheck'
const NONEMPTY_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-url-nonempty')
const EMPTY_DIR = path.join(os.tmpdir(), 'sc-e2e-clone-url-empty')
const BAD_URL = 'https//github.com/user/repo.git' // 少冒号（提案动机形态）
const LENIENT_SCP_URL = 'git@127.0.0.1:nonexistent/repo.git' // SCP 短形，放行

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
  // 非空目录夹具（绊线用，一个文件即非空）；空目录夹具保持空
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

async function openCloneModal(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  // 首页空态入口打开克隆弹窗（项目列表已被 beforeEach 清空）
  const empty = page.locator('.home-empty')
  await expect(empty).toBeVisible({ timeout: 10000 })
  await empty.getByRole('button', { name: '从 URL 克隆项目' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: '克隆远程仓库' })
  await expect(modal).toBeVisible({ timeout: 5000 })
  return modal
}

test('UI：坏 URL 打字即行内红提示，点击不发起请求', async ({ page }) => {
  const modal = await openCloneModal(page)
  const urlInput = modal.locator('input[placeholder*="https://github.com"]')
  const inlineError = modal.locator('[data-testid="clone-url-error"]')

  // 少冒号形态：打字瞬间行内红提示即现（不阻断输入——字符已进输入框）
  await urlInput.fill(BAD_URL)
  await expect(inlineError).toBeVisible({ timeout: 5000 })
  await expect(inlineError).toContainText('URL 形态不合法')

  // 全角空格（粘进中文空格）同样即现
  await urlInput.fill('https://github.com/user/repo.git　')
  await expect(inlineError).toBeVisible()

  // 改成合法形态提示即清（computed 跟随输入）
  await urlInput.fill('https://github.com/user/repo.git')
  await expect(inlineError).toHaveCount(0)

  // 坏 URL + 非空目录（绊线）点击克隆：不发请求——行内提示仍在、目标目录行内
  // 错误不出现（发了请求就会先命中目录预检 400）、不进克隆运行态、弹窗不关
  await urlInput.fill(BAD_URL)
  await modal.locator('input[placeholder*="D:/workspace"]').fill(serverPath(NONEMPTY_DIR))
  await modal.locator('button').filter({ hasText: /^克隆$/ }).click()
  await expect(inlineError).toBeVisible()
  await expect(modal.locator('[data-testid="clone-dir-error"]')).toHaveCount(0)
  await expect(modal.locator('.clone-running')).toHaveCount(0)
  await expect(modal).toBeVisible()

  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('UI：ssh:// 自定义端口长形放行，请求直达目录预检', async ({ page }) => {
  const modal = await openCloneModal(page)
  const inlineError = modal.locator('[data-testid="clone-url-error"]')

  // 异形但从宽：自定义端口 ssh:// 长形不触发 URL 行内提示
  await modal.locator('input[placeholder*="https://github.com"]').fill('ssh://git@example.com:2222/user/repo.git')
  await expect(inlineError).toHaveCount(0)

  // 非空目录（绊线）点击克隆：请求发出且通过 URL 关——服务端目录预检 400 点亮
  // 目标目录行内错误，任务未启动（clone-running 不出现）
  await modal.locator('input[placeholder*="D:/workspace"]').fill(serverPath(NONEMPTY_DIR))
  await modal.locator('button').filter({ hasText: /^克隆$/ }).click()
  await expect(inlineError).toHaveCount(0)
  const dirError = modal.locator('[data-testid="clone-dir-error"]')
  await expect(dirError).toBeVisible({ timeout: 5000 })
  await expect(dirError).toHaveText('目标目录已存在且非空')
  await expect(modal.locator('.clone-running')).toHaveCount(0)

  await modal.locator('button').filter({ hasText: '取消' }).click()
  await expect(modal).toBeHidden({ timeout: 5000 })
})

test('API：坏 URL 400 稳定原文，任务未创建', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone`, {
    headers,
    data: { url: BAD_URL, dir: serverPath(EMPTY_DIR), name: `${PROJ_PREFIX}-bad` },
  })
  expect(res.status()).toBe(400)
  const body = (await res.json()) as { error?: string }
  expect(body.error).toBe('invalid clone URL')
  // 任务未创建：无任何以本前缀命名的项目注册（兜底断言，快照恢复前清理）
  const list = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const names = ((list?.data || []) as Array<{ name: string }>).map(p => p.name)
  expect(names.filter(n => n.startsWith(PROJ_PREFIX))).toHaveLength(0)
})

test('API：异形合法 URL 放行（SCP 短形 200 + taskId）', async ({ request }) => {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/clone`, {
    headers,
    data: { url: LENIENT_SCP_URL, dir: serverPath(EMPTY_DIR), name: `${PROJ_PREFIX}-scp` },
  })
  expect(res.status()).toBe(200)
  const tid = ((await res.json()) as { taskId?: string }).taskId
  expect(tid).toBeTruthy()
  // 不可达来源任务快速失败，cancel 幂等收尾（已结束返回 404 不影响断言）
  await request.post(`${API_BASE}/api/clone/${tid}/cancel`, { headers })
})
