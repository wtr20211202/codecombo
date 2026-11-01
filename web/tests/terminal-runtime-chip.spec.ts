import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, unlockIfNeeded, waitForAppReady, projectCardByName } from './helpers'

/**
 * 会话列表 runtime 筛选芯片 E2E（P-20261004-84）：侧栏筛选区多选 OR 维度过滤。
 * - 芯片候选 = 当前会话集合动态去重（无该 runtime 会话不产芯片）
 * - 点选 runtime 芯片 → 仅该 runtime 会话可见（多选命中任一）；「全部」恢复档
 * - 与既有名称过滤 AND 叠加（正交）
 * - 选中态 localStorage 持久化，刷新后保持（SORT_KEY 惯例）
 *
 * 运行时夹具确定性：第二会话不走 claude/codex（探测缺失的环境会 400）——
 * 注册自定义运行时（POST /api/settings/custom-agents，命令原样启动、跳过可用性
 * 门控），产物会话 runtime 落自定义注册名，与 shell 形成两个稳定键。会话经
 * API 直建，等 meta 异步落库（快照反查携带 runtime）再驱动 UI，防竞态假败。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const FAKE_RUNTIME = 'e2efake'
const FAKE_COMMAND = 'node -e "console.log(\'sc-runtime-chip-fixture\')"'
const SHELL_SESSION_NAME = '芯片-shell'
const FAKE_SESSION_NAME = '芯片-e2efake'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清场：agent 会话 + 项目会话全删，并轮询等待列表归零（兄弟 spec 同款——
 *  DELETE 是异步杀进程，不等待会把幽灵会话泄入下一用例） */
async function cleanupSessions(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; kind?: string; projectId?: string }[] }).data || []
    const stale = list.filter(s => s.kind === 'agent' || !!s.projectId)
    if (stale.length === 0) return
    for (const s of stale) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
    await new Promise(r => setTimeout(r, 600))
  }
}

/** 注册自定义运行时（原样启动免探测）；失败让用例显式红而非静默走错键 */
async function registerFakeRuntime(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/settings/custom-agents`, {
    headers,
    data: { name: FAKE_RUNTIME, displayName: 'E2E Fake', command: FAKE_COMMAND },
  })
  expect(res.ok()).toBeTruthy()
}

async function removeFakeRuntime(request: APIRequestContext) {
  const headers = await unlockHeaders(request)
  await request.delete(`${BASE}/api/settings/custom-agents/${FAKE_RUNTIME}`, { headers })
}

/** 建指定 runtime 的 agent 会话，返回 id */
async function createAgentSession(request: APIRequestContext, name: string, runtime: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name, runtime },
  })
  expect(res.ok()).toBeTruthy()
  const body = (await res.json()) as { data?: { id?: string } }
  expect(body.data?.id).toBeTruthy()
  return body.data!.id!
}

/** 轮询等会话 meta 异步落库（快照 runtime 字段就位）——meta 是创建后异步
 *  落库的（前端 UI 创建路径由创建响应先行携带，API 直建只能等快照反查） */
async function waitRuntimeInSnapshot(request: APIRequestContext, want: Record<string, string>) {
  const headers = await unlockHeaders(request)
  for (let attempt = 0; attempt < 20; attempt++) {
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; runtime?: string }[] }).data || []
    const ok = Object.entries(want).every(([id, rt]) => list.find(s => s.id === id)?.runtime === rt)
    if (ok) return
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`runtime meta 未在快照就位: ${JSON.stringify(want)}`)
}

/** 打开管理页（项目视图 rail 入口），等待侧栏就绪。展开态可能已被上用例/
 *  uiState 持久为打开（rail 是 toggle），先探可见性防点关（sort spec 同款守卫） */
async function openManager(page: import('@playwright/test').Page) {
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await ensureManagerOpen(page)
}

/** /project 已就位时确保管理页可见（reload 恢复态：无项目卡可点） */
async function ensureManagerOpen(page: import('@playwright/test').Page) {
  const view = page.locator('.atv-root')
  if (!(await view.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端会话管理"]').click()
  }
  await expect(view).toBeVisible({ timeout: 10000 })
}

test.describe('会话列表 runtime 筛选芯片（P-20261004-84）', () => {
  let shellId = ''
  let fakeId = ''

  test.beforeEach(async ({ page, request }) => {
    await cleanupSessions(request)
    await removeFakeRuntime(request).catch(() => { /* 首跑无残留 */ })
    await registerFakeRuntime(request)
    shellId = await createAgentSession(request, SHELL_SESSION_NAME, 'shell')
    fakeId = await createAgentSession(request, FAKE_SESSION_NAME, FAKE_RUNTIME)
    await waitRuntimeInSnapshot(request, { [shellId]: 'shell', [fakeId]: FAKE_RUNTIME })

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await openManager(page)
    const view = page.locator('.atv-root')
    await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 15000 })
  })

  test.afterEach(async ({ request }) => {
    await cleanupSessions(request)
    await removeFakeRuntime(request)
  })

  test('芯片动态候选 → 点选过滤 → 多选 OR → 与名称过滤叠加', async ({ page }) => {
    const view = page.locator('.atv-root')
    const chips = view.locator('[data-test="session-runtime-chips"]')
    const names = () => view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item-title')

    // 候选 = 当前会话集合去重：两个 runtime 键 + 「全部」恢复档（无 claude/codex
    // 会话则无其芯片——动态清单语义）
    await expect(chips).toBeVisible()
    await expect(view.locator('[data-test="session-runtime-chip-all"]')).toBeVisible()
    await expect(view.locator('[data-test="session-runtime-chip-shell"]')).toBeVisible()
    await expect(view.locator(`[data-test="session-runtime-chip-${FAKE_RUNTIME}"]`)).toBeVisible()
    await expect(view.locator('[data-test="session-runtime-chip-claude"]')).toHaveCount(0)

    // 点 shell 芯片：仅 shell 会话可见
    await view.locator('[data-test="session-runtime-chip-shell"]').click()
    await expect(names()).toHaveText([SHELL_SESSION_NAME], { timeout: 10000 })

    // 再点 e2efake 芯片：多选 OR = 命中任一，两会话齐显（default 排序 = 创建序）
    await view.locator(`[data-test="session-runtime-chip-${FAKE_RUNTIME}"]`).click()
    await expect(names()).toHaveText([SHELL_SESSION_NAME, FAKE_SESSION_NAME], { timeout: 10000 })

    // 取消 e2efake：回到仅 shell
    await view.locator(`[data-test="session-runtime-chip-${FAKE_RUNTIME}"]`).click()
    await expect(names()).toHaveText([SHELL_SESSION_NAME], { timeout: 10000 })

    // 与名称过滤 AND 叠加：shell 芯片激活下检索 fake 会话名 → 无匹配提示；
    // 检索 shell 会话名 → 命中照常
    await view.locator('.ats-filter input').fill(FAKE_SESSION_NAME)
    await expect(view.locator('.ats-no-match')).toBeVisible()
    await view.locator('.ats-filter input').fill('芯片-shell')
    await expect(names()).toHaveText([SHELL_SESSION_NAME])

    // 「全部」恢复档只重置 runtime 维度：名称过滤是正交维度不随之清空——
    // 仍只剩名称命中的会话；再清名称查询，两会话齐显（正交组合的收口语义）
    await view.locator('[data-test="session-runtime-chip-all"]').click()
    await expect(names()).toHaveText([SHELL_SESSION_NAME], { timeout: 10000 })
    await expect(view.locator('.ats-no-match')).toHaveCount(0)
    await view.locator('.ats-filter input').fill('')
    await expect(names()).toHaveText([SHELL_SESSION_NAME, FAKE_SESSION_NAME], { timeout: 10000 })
  })

  test('选中态 localStorage 持久化：刷新后芯片激活态与过滤结果保持', async ({ page }) => {
    const view = page.locator('.atv-root')
    const names = () => view.locator('.ats-section', { hasText: '未分组' }).locator('.ats-item-title')

    await view.locator('[data-test="session-runtime-chip-shell"]').click()
    await expect(names()).toHaveText([SHELL_SESSION_NAME], { timeout: 10000 })
    // SORT_KEY 惯例键位：safeStorage 直写 localStorage
    await expect.poll(() => page.evaluate(() => localStorage.getItem('sc.terminalSessions.runtimeFilter')))
      .toBe(JSON.stringify(['shell']))

    // 刷新重载：选中集自 localStorage 恢复，过滤在首屏即生效。
    // 原地 reload 防「经首页导航落进 agt-home-overlay 悬浮遮挡」——管理页开着时
    // 回首页会以悬浮层形态盖住项目卡（点击被拦截），reload 保持 /project 直达
    await page.reload()
    await waitForAppReady(page)
    await unlockIfNeeded(page)
    await ensureManagerOpen(page)
    await expect(view.locator('[data-test="session-runtime-chip-shell"]')).toHaveClass(/active/, { timeout: 15000 })
    await expect(names()).toHaveText([SHELL_SESSION_NAME], { timeout: 10000 })
    await expect(view.locator('.ats-item')).toHaveCount(1)
  })
})
