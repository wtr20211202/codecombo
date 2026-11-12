import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话中心按 runtime 分组视图 E2E（P-20261003-238）：
 * - 分组 toggle：平铺（默认）→ 按运行时分组（组头 = 运行时显示名 + 计数徽标，
 *   会话按 meta runtime 归组），切回平铺还原既有呈现；toggle 态 localStorage
 *   持久化，刷新后保持。
 * - 正交组合：名称即时筛选与时间 chips（今天）在分组视图下照常 AND 叠加
 *   （组段随筛选收窄/消失、计数徽标跟随；无匹配出空态提示）。
 * - 服务端数据面：GET /terminals 快照携 runtime（applySessionMetaSnapshot meta
 *   反查）——创建响应的 runtime 是内存态，快照不落则刷新后分组退化单组，本
 *   spec 的「开页即分组」断言同时守门该字段。
 * - 共存提示与 agent 分组操作面（P-20261111-1-S3）：runtime 视图下自定义分组
 *   整区让位时的弱提示行（只计数不渲染组内容，点击切回平铺）；以及分组成为
 *   智能体可操作实体——session-groups API 建组/移入/移出/删组写 uiState 后
 *   广播 agent.groups.changed，live 侧栏经既有 OPS_AGENT_GROUPS_CHANGED 重读
 *   链就地跟随（免 reload 全链）。
 *
 * 测试数据：注册自定义运行时（command=node，e2e 环境前端构建必备二进制，
 * agent-runtime-version.spec 同款），API 直建 2 shell + 1 自定义 runtime 会话；
 * beforeAll 先清空全部终端会话保证行数/计数确定（侧栏同显项目会话，
 * session-time-chips.spec 同款约定），meta 异步落库——开页前 API 轮询等快照
 * 携带 runtime（agent-runtime-version.spec 同款防闪断）。时间窗排除语义
 * （窗口外会话被隐藏）终端会话 createdAt 无法回拨，由 P-174 spec 的 Claude
 * 侧 20 天前 fixture 覆盖，此处只验证组合正交。
 */

const RT = 'e2e-rt-group'
const SHELL_A = 'e2e-rtg-shell-a'
const SHELL_B = 'e2e-rtg-shell-b'
const NODE = 'e2e-rtg-node'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清空全部终端会话（服务端全局共享；侧栏同显项目会话，session-time-chips
 *  spec 同款约定——不这样就数不准 .ats-item） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 解锁后延迟出现的「建议修改默认密码」提醒遮罩会拦截点击（时序不定，
 *  用例中途 reload 时 prefs 已就绪即刻弹出）——既有惯例 waitFor + 收起 */
async function dismissPwdTip(page: Page): Promise<void> {
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
}

/** 进项目页 → 打开终端会话管理（首页侧栏/管理页共用的进入路径） */
async function openManager(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await dismissPwdTip(page)
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** 原地重开管理页面板（reload 后用：跨页 goto 会撞 uiState 记忆的首页
 *  agt-home-overlay 浮层遮项目卡；面板开关是 toggle 语义，active 即已开勿盲点） */
async function reopenManagerInPlace(page: Page) {
  await dismissPwdTip(page)
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  const cls = await railBtn.getAttribute('class')
  if (!cls?.includes('active')) await railBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  return view
}

/** shell 组段（:has CSS 锚定组头——filter({ has: view.locator() }) 链式内层
 *  定位器会被再定根到外层元素，带祖先链的内层定位器不命中，:has 一次到位） */
function runtimeGroup(view: ReturnType<Page['locator']>, key: string) {
  return view.locator(`[data-test="session-runtime-group"]:has([data-test="session-runtime-group-head"][data-runtime="${key}"])`)
}
function headCount(head: ReturnType<Page['locator']>) {
  return head.locator('[data-test="session-runtime-group-count"]')
}

test.describe('会话中心按 runtime 分组视图（P-20261003-238）', () => {
  test.beforeAll(async ({ request }) => {
    await cleanupTerminals(request)
    // 注册自定义运行时（upsert：重跑残留同名项直接覆盖，agent-runtime-version.spec 同款）
    const res = await request.post(`${API_BASE}/api/settings/custom-agents`, {
      headers: await unlockHeaders(request),
      data: { name: RT, displayName: 'E2E RT Group', command: 'node' },
    })
    if (!res.ok()) throw new Error(`register custom runtime failed: ${res.status()}`)
    for (const [name, runtime] of [[SHELL_A, 'shell'], [SHELL_B, 'shell'], [NODE, RT]] as const) {
      const created = await request.post(`${API_BASE}/api/terminals`, {
        headers: await unlockHeaders(request),
        data: { kind: 'agent', name, runtime },
      })
      if (!created.ok()) throw new Error(`create ${name} failed: ${created.status()}`)
    }
    // meta 异步落库：快照反查携 runtime 后再开页（否则首屏 boot 拉到的快照
    // 无 runtime，分组视图退化单组——防闪断，agent-runtime-version.spec 同款）
    await expect(async () => {
      const res = await request.get(`${API_BASE}/api/terminals`, { headers: await unlockHeaders(request) })
      const sessions = ((await res.json()) as { data?: { name?: string; runtime?: string }[] }).data || []
      expect(sessions.find(s => s.name === SHELL_A)?.runtime).toBe('shell')
      expect(sessions.find(s => s.name === SHELL_B)?.runtime).toBe('shell')
      expect(sessions.find(s => s.name === NODE)?.runtime).toBe(RT)
    }).toPass({ timeout: 10_000 })
  })

  test.afterAll(async ({ request }) => {
    await cleanupTerminals(request).catch(() => { /* 服务不在：无残留面 */ })
    await request.delete(`${API_BASE}/api/settings/custom-agents/${RT}`, {
      headers: await unlockHeaders(request),
    }).catch(() => { /* 不存在即目标态 */ })
  })

  test('分组 toggle：归组+组头计数、刷新保持、切回平铺', async ({ page }) => {
    test.setTimeout(60000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const view = await openManager(page)
    const toggle = view.locator('[data-test="session-group-toggle"]')

    // 平铺（默认）：无组段，三行都在既有呈现里
    await expect(toggle).toBeVisible()
    await expect(toggle).not.toHaveClass(/active/)
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(0)
    await expect(view.locator('.ats-item')).toHaveCount(3)

    // 切分组：两组段（内置 shell + 自定义 runtime），组头计数归位
    await toggle.click()
    const shellHead = view.locator('[data-test="session-runtime-group-head"][data-runtime="shell"]')
    const customHead = view.locator(`[data-test="session-runtime-group-head"][data-runtime="${RT}"]`)
    await expect(shellHead).toBeVisible()
    await expect(headCount(shellHead)).toHaveText('2')
    await expect(customHead).toBeVisible()
    await expect(headCount(customHead)).toHaveText('1')
    // 归位：shell 会话在 shell 组段内、自定义 runtime 会话不在其中
    await expect(runtimeGroup(view, 'shell').locator('.ats-item', { hasText: SHELL_A })).toBeVisible()
    await expect(runtimeGroup(view, 'shell').locator('.ats-item', { hasText: SHELL_B })).toBeVisible()
    await expect(runtimeGroup(view, 'shell').locator('.ats-item', { hasText: NODE })).toHaveCount(0)
    // 组头标签：内置走 agentLabelOf 既有显示名映射，自定义运行时显注册名
    await expect(shellHead).toContainText('Shell')
    await expect(customHead).toContainText(RT)

    // 持久化：原地刷新（同 context，localStorage 存活）后分组视图保持
    await page.reload()
    const view2 = await reopenManagerInPlace(page)
    await expect(view2.locator('[data-test="session-group-toggle"]')).toHaveClass(/active/)
    await expect(headCount(view2.locator('[data-test="session-runtime-group-head"][data-runtime="shell"]'))).toHaveText('2')

    // 切回平铺：组段消失、既有呈现还原
    await view2.locator('[data-test="session-group-toggle"]').click()
    await expect(view2.locator('[data-test="session-runtime-group"]')).toHaveCount(0)
    await expect(view2.locator('.ats-item')).toHaveCount(3)
  })

  test('分组视图与名称筛选/时间 chips 正交组合', async ({ page }) => {
    test.setTimeout(60000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const view = await openManager(page)
    // 新测试 context：localStorage 干净，从平铺默认态进入分组视图
    await view.locator('[data-test="session-group-toggle"]').click()
    const shellHead = view.locator('[data-test="session-runtime-group-head"][data-runtime="shell"]')
    await expect(shellHead).toBeVisible()

    // 名称筛选 AND：命中行留组内、计数跟随、未命中的自定义组段整体消失
    await view.locator('.ats-filter input').fill(SHELL_A)
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(1)
    await expect(headCount(shellHead)).toHaveText('1')
    await expect(view.locator('.ats-item', { hasText: SHELL_A })).toBeVisible()
    // 无匹配：组段全收 + 空态提示（退出过滤的入口仍在）
    await view.locator('.ats-filter input').fill('绝无匹配的会话名xyz')
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(0)
    await expect(view.locator('.ats-no-match')).toBeVisible()
    await view.locator('.ats-filter input').fill('')
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(2)

    // 时间 chips 组合：今天（会话皆新建）→ 组段与行全保持，chips 与分组互不干扰
    await view.locator('[data-test="session-time-chip-today"]').click()
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(2)
    await expect(view.locator('.ats-item')).toHaveCount(3)
    // 切回平铺后时间 chips 仍独立可用（toggle 与 chips 正交）
    await view.locator('[data-test="session-time-chip-all"]').click()
    await view.locator('[data-test="session-group-toggle"]').click()
    await expect(view.locator('.ats-item')).toHaveCount(3)
    await expect(view.locator('[data-test="session-time-chips"]')).toBeVisible()
  })

  test('共存提示：runtime 视图让位区提示行计数、点击切回平铺（P-20261111-1-S3）', async ({ page, request }) => {
    test.setTimeout(60000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const headers = await unlockHeaders(request)
    // 防残留：既有分组全清（dogfood 新端点），保证计数断言确定
    await cleanupGroups(request, headers)
    const view = await openManager(page)

    // 平铺视图建一个分组（footer 内联输入，S2 spec 同款）
    await view.locator('.ats-footer button').click()
    const input = view.locator('.ats-footer input')
    await expect(input).toBeVisible()
    await input.fill('提示组甲')
    await input.press('Enter')
    await expect(view.locator('.ats-section:has(.ats-group-name:text-is("提示组甲"))')).toBeVisible()

    // 切 runtime 视图：自定义分组整区让位 → 提示行在场携计数（只计数，
    // 组头/组内容不渲染——不双渲染）；toggle 仍在激活态
    await view.locator('[data-test="session-group-toggle"]').click()
    const hint = view.locator('[data-test="session-runtime-groups-hint"]')
    await expect(hint).toBeVisible()
    await expect(hint).toContainText('1')
    await expect(hint).toContainText('自定义分组')
    await expect(view.locator('.ats-section:has(.ats-group-name:text-is("提示组甲"))')).toHaveCount(0)
    await expect(view.locator('[data-test="session-runtime-group"]').first()).toBeVisible()

    // 点击提示行 → 切回平铺：组段还原、toggle 退出激活态（与 toggle 点击同语义）
    await hint.click()
    await expect(view.locator('[data-test="session-runtime-group"]')).toHaveCount(0)
    await expect(view.locator('.ats-section:has(.ats-group-name:text-is("提示组甲"))')).toBeVisible()
    await expect(view.locator('[data-test="session-group-toggle"]')).not.toHaveClass(/active/)

    // 清场（dogfood DELETE）
    await cleanupGroups(request, headers)
  })

  test('agent 分组操作面：API 建组/移入/移出/删组，live 侧栏就地跟随（P-20261111-1-S3）', async ({ page, request }) => {
    test.setTimeout(60000)
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    const headers = await unlockHeaders(request)
    await cleanupGroups(request, headers)

    // 先开页再动 API：建组/移入的断言才能证明「广播→重读链」live 跟随
    //（组若先建后开页，出现走的是 boot 而非广播）
    const view = await openManager(page)

    // 会话 id 取自 GET /terminals（手册配方：先列清单核对 id）
    const listRes = await request.get(`${API_BASE}/api/terminals`, { headers })
    const sessions = ((await listRes.json()) as { data?: { id?: string; name?: string }[] }).data || []
    const byName = (n: string) => sessions.find(s => s.name === n)!.id!
    const shellA = byName(SHELL_A)
    const node = byName(NODE)

    // API 校验语义：空名 400 / 组不存在 404
    const emptyRes = await request.post(`${API_BASE}/api/terminals/session-groups`, { headers, data: { name: '  ' } })
    expect(emptyRes.status()).toBe(400)
    const ghostRes = await request.put(`${API_BASE}/api/terminals/session-groups/at_missing_x/sessions`, {
      headers, data: { sessionIds: [shellA] },
    })
    expect(ghostRes.status()).toBe(404)

    // 建组：201 + 服务端铸 id；live 侧栏就地出现（广播→OPS_AGENT_GROUPS_CHANGED
    // 重读链，免 reload——页已开，出现只能来自广播）
    const createRes = await request.post(`${API_BASE}/api/terminals/session-groups`, { headers, data: { name: 'api归置组' } })
    expect(createRes.status()).toBe(201)
    const created = ((await createRes.json()) as { data?: { id?: string } }).data!
    expect(created.id).toMatch(/^at_\d+/)
    const group = view.locator('.ats-section:has(.ats-group-name:text-is("api归置组"))')
    await expect(group).toBeVisible({ timeout: 10000 })

    // 移入 2 会话：侧栏组内出现两行；服务端清单同形（读到的是落盘后真值）
    const moveRes = await request.put(`${API_BASE}/api/terminals/session-groups/${created.id}/sessions`, {
      headers, data: { sessionIds: [shellA, node] },
    })
    expect(moveRes.status()).toBe(200)
    await expect(group.locator('.ats-item', { hasText: SHELL_A })).toBeVisible({ timeout: 10000 })
    await expect(group.locator('.ats-item', { hasText: NODE })).toBeVisible()
    await expect(group.locator('.ats-item')).toHaveCount(2)
    const groupsAfterMove = await listGroups(request, headers)
    expect(groupsAfterMove.find(g => g.id === created.id)?.sessionIds.sort()).toEqual([shellA, node].sort())

    // 移出 1 会话（回未分组）：行实时归位
    const removeRes = await request.delete(`${API_BASE}/api/terminals/session-groups/${created.id}/sessions/${shellA}`, { headers })
    expect(removeRes.status()).toBe(200)
    await expect(group.locator('.ats-item', { hasText: SHELL_A })).toHaveCount(0, { timeout: 10000 })
    await expect(group.locator('.ats-item')).toHaveCount(1)
    await expect(view.locator('.ats-item', { hasText: SHELL_A }).first()).toBeVisible()

    // 删组：组段消失，余下成员自然回未分组（归属随组消失归位）；全程未移动的
    // SHELL_B 始终在未分组区
    const delRes = await request.delete(`${API_BASE}/api/terminals/session-groups/${created.id}`, { headers })
    expect(delRes.status()).toBe(200)
    await expect(group).toHaveCount(0, { timeout: 10000 })
    await expect(view.locator('.ats-item', { hasText: NODE }).first()).toBeVisible()
    await expect(view.locator('.ats-item', { hasText: SHELL_B }).first()).toBeVisible()
  })
})

/** 分组清单 dogfood helper：GET /api/terminals/session-groups */
async function listGroups(request: APIRequestContext, headers: Record<string, string>) {
  const res = await request.get(`${API_BASE}/api/terminals/session-groups`, { headers })
  expect(res.status()).toBe(200)
  return ((await res.json()) as { data?: { id?: string }[] }).data || []
}

/** 清空全部分组（防残留：重复跑/他 spec 残留分组影响计数断言） */
async function cleanupGroups(request: APIRequestContext, headers: Record<string, string>): Promise<void> {
  for (const g of await listGroups(request, headers)) {
    await request.delete(`${API_BASE}/api/terminals/session-groups/${g.id}`, { headers })
  }
}
