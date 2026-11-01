import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 舰队并行 agent 任务（P-20261003-291）E2E：
 *   1. 命令面板「批量 agent 任务」→ 多选浮层：两个项目 + 一段 prompt 发起 →
 *      弹层内联回告「已发起 2 个会话」→ 服务端两会话创建且名字以
 *      「fleet: <prompt 头部>」为统一基名（编队名事实源在服务端，UI 与 API
 *      对账一致）；P-20261023-3 同名消歧下次成员步进「·2」
 *   2. API 边界：超 cap（21 个项目）→ 400 拒绝；prompt 必填
 *   3. 逐条回告：项目清单混入缺失项目 → 200 但该条进 skipped（reason=project
 *      not found）、不中断其余项目；长 prompt 服务端保尾截断 + 编队名头部
 *      24 rune 截断加省略号（次成员同名步进「·2」）
 * runtime 显式用纯终端（shell 一等选项）保证确定性：不依赖 e2e 机的 agent
 * 可用性（选型降级/预检语义由单测与 runtime-precheck spec 守门）；自备两个
 * 临时 git 仓库注册为项目，afterEach 清理全部终端会话，afterAll 清项目与夹具
 */

const REPO_DIR_A = path.join(os.tmpdir(), 'sc-e2e-fleet-a')
const REPO_DIR_B = path.join(os.tmpdir(), 'sc-e2e-fleet-b')
const PROJ_A = 'e2e-fleet-alpha'
const PROJ_B = 'e2e-fleet-beta'
// 短 prompt（≤24 rune）：编队名 = 「fleet: 」+ 原文，无省略号
const PROMPT_SHORT = '审计依赖 e2e'
// 长 prompt（25 rune > 24）：编队名头部截断到 24 rune + …
const PROMPT_LONG = '给全部项目跑依赖审计并列出过时包清单和统一升级建议'

let projAId = ''
let projBId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话：本 spec 断言基于「空白会话表」，残留会话会污染计数 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 按 name 查找已注册项目（find 幂等 upsert 语义，残留不重复建） */
async function findProjectId(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await fetch(`${API_BASE}/api/projects`, { headers })
  const body = (await res.json()) as { data?: { id: string; name: string }[] }
  return body.data?.find(p => p.name === name)?.id || ''
}

async function createRepoWithProject(
  request: APIRequestContext,
  repoDir: string,
  projName: string,
): Promise<string> {
  const headers = await unlockHeaders(request)
  const stale = await findProjectId(request, projName)
  if (stale) await fetch(`${API_BASE}/api/projects/${stale}`, { method: 'DELETE', headers })
  try { fs.rmSync(repoDir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(repoDir, { recursive: true })
  git(repoDir, ['init'])
  fs.writeFileSync(path.join(repoDir, 'README.md'), `# ${projName}\n`)
  git(repoDir, ['add', '.'])
  git(repoDir, ['commit', '-m', `c1: init ${projName}`])
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: projName, path: serverPath(repoDir) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async ({ request }) => {
  projAId = await createRepoWithProject(request, REPO_DIR_A, PROJ_A)
  projBId = await createRepoWithProject(request, REPO_DIR_B, PROJ_B)
  expect(projAId).toBeTruthy()
  expect(projBId).toBeTruthy()
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  for (const id of [projAId, projBId]) {
    if (id) await fetch(`${API_BASE}/api/projects/${id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR_A, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  try { fs.rmSync(REPO_DIR_B, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** 服务端 agent 会话名清单（对账事实源） */
async function agentSessionNames(request: APIRequestContext): Promise<string[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string; kind?: string }[] }).data || []
  return list.filter(s => s.kind === 'agent').map(s => s.name)
}

/** 进项目页（命令面板挂载宿主；活动栏 agent 开合是 localStorage 状态，新
 *  context 天然干净，无需显式清理） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

test('UI：命令面板 → 批量 agent 任务 → 两项目发起 → 两会话创建且名含 fleet 前缀', async ({ page, request }) => {
  await enterProject(page)

  // 命令面板命令模式 → 「批量 agent 任务」→ 弹层
  await page.keyboard.press('Control+Shift+P')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>批量 agent')
  const item = page.locator('.palette-item').filter({ hasText: '批量 agent 任务' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  const dlg = page.locator('.n-modal').filter({ hasText: '批量 agent 任务' })
  await expect(dlg).toBeVisible({ timeout: 5000 })

  // 多选两个项目（下拉选项按项目名点选；multiple 下拉保持展开，选完 Esc 收起）
  await dlg.locator('[data-testid="fleet-bulk-projects"]').click()
  await page.locator('.n-base-select-option').filter({ hasText: PROJ_A }).click()
  await page.locator('.n-base-select-option').filter({ hasText: PROJ_B }).click()
  await page.keyboard.press('Escape')

  // 填任务指令并发起（runtime 保持默认 auto；编队名来自服务端显式命名链）
  await dlg.locator('[data-testid="fleet-bulk-prompt"] textarea').fill(PROMPT_SHORT)
  await dlg.locator('[data-testid="fleet-bulk-launch"]').click()

  // 内联回告：已发起 2 个、无跳过
  const result = dlg.locator('[data-testid="fleet-bulk-result"]')
  await expect(result).toBeVisible({ timeout: 15000 })
  await expect(result).toContainText('已发起 2 个会话')
  await expect(result).not.toContainText('跳过')

  // 服务端对账：两个 agent 会话、编队名统一「fleet: <prompt 头部>」基名。
  // P-20261023-3 同名消歧：编队显式名经 WithDisplayNameDedup 参与同名步进，
  // 顺序创建下首成员得基名、次成员得基名+「·2」（侧栏一眼分清第 N 个成员）
  const names = await agentSessionNames(request)
  const fleetBase = `fleet: ${PROMPT_SHORT}`
  expect(names.filter(n => n === fleetBase)).toHaveLength(1)
  expect(names.filter(n => n === `${fleetBase}·2`)).toHaveLength(1)
})

test('API：超 cap 400 拒绝 + prompt 必填', async ({ request }) => {
  const headers = await unlockHeaders(request)
  // 21 个项目 ID（无需真实存在——cap 校验先于项目解析）
  const ids = Array.from({ length: 21 }, (_, i) => `p-${i}`)
  const res = await request.post(`${API_BASE}/api/terminals/bulk-agent`, {
    headers, data: { projectIds: ids, prompt: PROMPT_SHORT },
  })
  expect(res.status()).toBe(400)
  expect(await res.text()).toContain('too many projects: max 20')

  const res2 = await request.post(`${API_BASE}/api/terminals/bulk-agent`, {
    headers, data: { projectIds: [projAId], prompt: '   ' },
  })
  expect(res2.status()).toBe(400)
  expect(await res2.text()).toContain('prompt is required')
})

test('API：缺失项目逐条回告跳过不中断编队 + 长 prompt 保尾截断与编队名截断', async ({ request }) => {
  const headers = await unlockHeaders(request)
  // runtime 显式纯终端（shell 一等选项）：不依赖 e2e 机 agent 可用性，确定性创建
  const res = await request.post(`${API_BASE}/api/terminals/bulk-agent`, {
    headers,
    data: { projectIds: [projAId, 'no-such-fleet-proj', projBId], runtime: 'shell', prompt: PROMPT_LONG },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as {
    data?: {
      created: Array<{ projectId: string; terminalId: string; name: string }>
      skipped: Array<{ projectId: string; reason: string }>
    }
  }
  // 缺失项目逐条回告、编队不中断
  expect(body.data?.skipped).toHaveLength(1)
  expect(body.data?.skipped[0].projectId).toBe('no-such-fleet-proj')
  expect(body.data?.skipped[0].reason).toContain('project not found')
  // 其余两项目照常创建；名字统一 fleet: 前缀 + 24 rune 头部截断加省略号基名。
  // P-20261023-3 同名消歧：编队显式名参与同名步进——两成员 = 基名 + 基名「·2」
  //（名字集合断言与项目顺序解耦；排序后基名在前——前缀码元序）
  expect(body.data?.created).toHaveLength(2)
  const fleetBaseName = `fleet: ${PROMPT_LONG.slice(0, 24)}…`
  expect((body.data?.created ?? []).map(c => c.name).sort()).toEqual([fleetBaseName, `${fleetBaseName}·2`])
  for (const c of body.data?.created ?? []) {
    expect([projAId, projBId]).toContain(c.projectId)
  }
  // 会话 dir=项目根（编队语义核心，目录决定侧栏分组与产出归属）
  const detail = await (await fetch(`${API_BASE}/api/terminals`, { headers })).json() as {
    data?: Array<{ id: string; path: string }>
  }
  for (const c of body.data?.created ?? []) {
    const s = detail.data?.find(x => x.id === c.terminalId)
    if (!s) throw new Error(`fleet session not found: ${c.terminalId}`)
    const expected = c.projectId === projAId ? REPO_DIR_A : REPO_DIR_B
    expect(s.path.replace(/\\/g, '/')).toBe(serverPath(expected).replace(/\\/g, '/'))
  }
})
