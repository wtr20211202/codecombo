import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 自定义敏感模式（P-20261006-11 双端同源）：
 *   1. 设置 API 读写回路：PUT customSensitivePatterns → GET 回读一致；
 *      方言违例（内联旗标 (?i)，Go 支持 JS 不支持）与非法正则均 400
 *   2. 生效面（Go 侧命令历史跳过）：命中自定义模式的命令整条不落盘，
 *      未命中照常（同一落盘链路 API 直播种，terminal-history-search 同款）
 *   3. 默认空列表 = 纯通用表现状：清空后同形态命令恢复落盘（存量零变化）
 *   4. 设置·安全·敏感模式页签 UI（添加→暂存→保存→回读→删除清空）
 * 模式列表是全局共享状态：beforeEach 清空 + afterEach 兜底还原，防污染其他用例
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = 'e2e-custom-sensitive'
// 自定义模式标记词全仓唯一防串扰；形态须避开通用词表（password/token/AKIA/
// sc[a-z]_ 等都不命中——"esc_" 里 s,c 后紧跟 _ 不构成 sc[a-z]_）
const SECRET_MARK = 'e2esc_abcdef1234567890'
const PATTERN = 'e2esc_[A-Za-z0-9]{8,}'
const CMD_CUSTOM = `deploy ${SECRET_MARK} now`   // 仅自定义模式命中
// 对照组须对自定义与通用两表都零命中：连通用贴附口令旗标条款 [-/]p[A-Za-z0-9_$]{4,}\b
// 都不能撞（曾用 "echo e2e-plain-command"，"e2e-plain" 的 -plain 即假命中被整条
// 跳过，对照组假红定性成「跳过逻辑反转」——上轮 :117 卡点根因）
const CMD_PLAIN = 'echo plain-cmd-e2e-check'     // 无任何命中（对照组）

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setPatterns(request: APIRequestContext, patterns: string[]): Promise<number> {
  const res = await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { customSensitivePatterns: patterns },
  })
  return res.status()
}

async function getPatterns(request: APIRequestContext): Promise<string[]> {
  const res = await request.get(`${API_BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const data = (await res.json()) as { data?: { customSensitivePatterns?: string[] } }
  return data.data?.customSensitivePatterns ?? []
}

async function projectId(request: APIRequestContext): Promise<string> {
  const list = await request.get(`${API_BASE}/api/projects`, { headers: await unlockHeaders(request) })
  const found = ((await list.json()) as { data?: Array<{ id: string; name: string }> }).data
    ?.find(p => p.name === PROJ)
  return found?.id ?? ''
}

async function seedHistory(request: APIRequestContext, id: string, command: string): Promise<void> {
  const res = await request.post(`${API_BASE}/api/projects/${id}/terminal-history`, {
    headers: await unlockHeaders(request),
    data: { command, exitCode: 0, durationMs: 100 },
  })
  expect(res.ok()).toBeTruthy()
}

async function historyCommands(request: APIRequestContext, id: string): Promise<string[]> {
  const res = await request.get(`${API_BASE}/api/projects/${id}/terminal-history`, {
    headers: await unlockHeaders(request),
  })
  const data = (await res.json()) as { data?: Array<{ command: string }> }
  return (data.data ?? []).map(e => e.command)
}

test.beforeEach(async ({ request }) => {
  await setPatterns(request, [])
  // 临时空项目（spec 内自备，幂等：实例复用/用例重试不叠加——上轮残留项目
  // 先删再建，terminal-history-search.spec 同款纪律）
  const stale = await projectId(request)
  if (stale) {
    await request.delete(`${API_BASE}/api/projects/${stale}`, { headers: await unlockHeaders(request) })
  }
  const dir = path.resolve(HERE, '../../../.sc-tmp/e2e-custom-sensitive', PROJ)
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(dir, { recursive: true })
  const proj = await request.post(`${API_BASE}/api/projects`, {
    headers: await unlockHeaders(request),
    data: { name: PROJ, path: serverPath(dir) },
  })
  expect([200, 201]).toContain(proj.status())
  const id = await projectId(request)
  await request.delete(`${API_BASE}/api/projects/${id}/terminal-history`, { headers: await unlockHeaders(request) })
})

test.afterEach(async ({ request }) => {
  await setPatterns(request, [])
  const id = await projectId(request)
  if (id) {
    await request.delete(`${API_BASE}/api/projects/${id}`, { headers: await unlockHeaders(request) })
  }
  try { fs.rmSync(path.resolve(HERE, '../../../.sc-tmp/e2e-custom-sensitive'), { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('设置 API 回路：合法列表保存回读一致；方言违例/非法正则 400', async ({ request }) => {
  // 方言纪律：(?i) Go RE2 支持而 JS 不支持——写入口显式拒绝防双端口径分叉
  expect(await setPatterns(request, ['(?i)my_token=.'])).toBe(400)
  // RE2 编译失败
  expect(await setPatterns(request, ['(unclosed'])).toBe(400)
  // 空匹配模式拒绝（遮蔽替换会在任意位置插 ***）
  expect(await setPatterns(request, ['a*'])).toBe(400)
  // 拒绝路径不落盘：GET 仍是清空后的空数组
  expect(await getPatterns(request)).toEqual([])

  expect(await setPatterns(request, [PATTERN, '(MY_APP_TOKEN=)([^ ]+)'])).toBe(200)
  expect(await getPatterns(request)).toEqual([PATTERN, '(MY_APP_TOKEN=)([^ ]+)'])
})

test('生效面：命中自定义模式的命令历史整条跳过；清空后同形态恢复落盘', async ({ request }) => {
  const id = await projectId(request)
  expect(id).toBeTruthy()

  // 未配置模式：自定义形态命令照常落盘（默认零变化的正向证据）
  await seedHistory(request, id, CMD_CUSTOM)
  expect(await historyCommands(request, id)).toContain(CMD_CUSTOM)

  // 配置模式后：新上报的同形态命令整条跳过（静默成功，响应仍 200）
  expect(await setPatterns(request, [PATTERN])).toBe(200)
  await seedHistory(request, id, `${CMD_CUSTOM} again`)
  const withPattern = await historyCommands(request, id)
  expect(withPattern).toContain(CMD_CUSTOM)      // 配置前已落盘条目不受影响
  expect(withPattern).not.toContain(`${CMD_CUSTOM} again`)

  // 对照组：未命中命令照常落盘
  await seedHistory(request, id, CMD_PLAIN)
  expect(await historyCommands(request, id)).toContain(CMD_PLAIN)

  // 清空模式 = 回落纯通用表现状：同形态命令恢复落盘
  expect(await setPatterns(request, [])).toBe(200)
  await seedHistory(request, id, `${CMD_CUSTOM} third`)
  expect(await historyCommands(request, id)).toContain(`${CMD_CUSTOM} third`)
})

test('设置·安全·敏感模式页签：添加→暂存→保存→回读→删除清空', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 设置 → 安全 → 敏感模式页签（approval-rules.spec 同款导航链）
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '敏感模式' }).click()
  const manager = page.getByTestId('sensitive-patterns-manager')
  await expect(manager).toBeVisible({ timeout: 5000 })
  await expect(manager).toContainText('还没有自定义模式')

  // 添加 → 暂存条可见 → 保存 → 服务端回读一致
  await page.getByTestId('sensitive-patterns-input').locator('input').fill(PATTERN)
  await page.getByTestId('sensitive-patterns-add').click()
  await expect(page.getByTestId('sensitive-patterns-list')).toContainText(PATTERN)
  await expect(page.getByTestId('sensitive-patterns-dirty')).toBeVisible()
  await page.getByTestId('sensitive-patterns-save').click()
  await expect(page.getByTestId('sensitive-patterns-dirty')).toHaveCount(0, { timeout: 5000 })
  expect(await getPatterns(request)).toEqual([PATTERN])

  // 删除 → 保存 → 服务端清空（默认零变化形态可从 UI 达成）
  await page.getByTestId('sensitive-patterns-delete').click()
  await expect(page.getByTestId('sensitive-patterns-dirty')).toBeVisible()
  await page.getByTestId('sensitive-patterns-save').click()
  await expect(page.getByTestId('sensitive-patterns-dirty')).toHaveCount(0, { timeout: 5000 })
  await expect(manager).toContainText('还没有自定义模式', { timeout: 5000 })
  expect(await getPatterns(request)).toEqual([])
})
