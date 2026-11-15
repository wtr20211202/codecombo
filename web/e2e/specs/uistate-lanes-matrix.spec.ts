import { test, expect, type Page } from '@playwright/test'
import {
  closeDshConsoleAndClearState, closeNotesOverlayIfOpen, fixedLocale, gotoAndUnlock,
  projectCardByName, unlockIfNeeded, waitForAppReady, DEFAULT_PASSWORD,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * UI 状态保持语义矩阵 e2e 关键子集（P-20261114-2-S3）：把注册表
 * web/src/persistence/uiStateLanes.json（docs/PERSISTENCE_LANES.md「UI 状态保持
 * 矩阵」逐行对应）登记的「恢复语义」按族钉进 e2e——钉登记的恢复语义而非实现
 * 细节（注册表重构为等义形态时钉子不红），每钉头注标注对应注册表行 id。
 *
 * 已钉面对账（不重复造）：
 *   - notesView 行 刷新/路由往返 → notes-view.spec（P-20261114-4-S2 场景归属
 *     三用例 + 活动篇持久化/首页开态刷新——home 槽 homeOpen/project 槽 open 分槽）
 *   - dshConsole.open 行 路由往返 → agent-terminal.spec「dsh 控制台：打开→回首页
 *     →再进项目，主区视图随选中态非空」
 *   - ls.panelSidebarWidth / ls.agentTerminal.sidebarWidth 行 同 context 刷新恢复
 *     → remote-sidebar-resize.spec / notes-sidebar-resize.spec
 *   - railOrder.railTop / fileTree.pinnedDirs / layoutLock.locked 等 writer 行
 *     → activity-bar-drag / file-tree-pinned / layout-lock 各 feature spec
 *
 * 本 spec 补钉（族×{刷新/路由往返/双 context} 的缺口面，每用例首注注册表行）：
 *   1. layout.main（collect 轨）：主侧栏宽——刷新恢复 + 路由往返保持 + 双 context
 *      跨浏览器保持（uiState 按实例存，换浏览器跟随）
 *   2. notesView（writer 轨）：双 context——换浏览器上下文按服务端实例记录恢复开态
 *   3. remoteConsole（writer 轨）：刷新恢复守卫——「open+tabs>0 才恢复」两侧
 *      （无 tabs 不拉起 / 有 tabs 拉起并还原 tab 位）
 *   4. remoteConsole（writer 轨）：路由往返工作面保持
 *   5. dshConsole.open（writer 轨）：刷新恢复（restoreDshConsoleOnce）
 *   6. shareManager.open（writer 轨）：刷新恢复 + 路由往返（restoreShareManagerOnce）
 *   7. ls.panelSidebarWidth + ls.agentTerminal.sidebarWidth（localStorage 轨）：
 *      双 context 设备本地——agent/remote/notes 三面板侧栏宽换浏览器回落默认宽
 *      （与用例 1 的 layout.sidePanelWidth 跨浏览器保持构成注册表「按实例/按设备
 *      两档」的 e2e 对照）
 *
 * 纪律：beforeEach 服务端 uiState local 记录全清（workspace-snapshot.spec 同款
 * `{ local: null }`，每用例从出厂态出发）；afterEach 先卸载 SPA 再 API 清场
 * （closeDshConsoleAndClearState 头注同款事故面：unload 路径 forceSave 回写先行
 * 落定，清场才不被覆盖）；双 context 用例显式 Esc 收开态再关 ctx，防 close 触发
 * 的 beforeunload 补丁与清场竞态。零平台分支、零新依赖。
 */

const SEED_PROJECT = 'simple-coding'
const NOTES_W_KEY = 'sc.notes.sidebarWidth'
const AGENT_W_KEY = 'sc.agentTerminal.sidebarWidth'
const REMOTE_W_KEY = 'sc.remoteConsole.sidebarWidth'
const NOTES_W_DEFAULT = 260
const AGENT_W_DEFAULT = 260
const REMOTE_W_DEFAULT = 320
/** 远程刷新守卫夹具：tab 指向的会话 id 恒不存在（auditStaleSessions 对账后置 ended，
 *  tab 位与标题保留——恢复语义钉「tab 位还原」而非会话活性） */
const STALE_TAB = { sessionId: 'e2e-uistate-matrix-stale', title: 'e2e 矩阵 tab' }
const HOST_NAME = 'e2e-uistate-matrix-host'
/** 播种主机的服务端 id（beforeAll 填充，用例 3 的 tab 还原依赖真实主机记录） */
let HOST_ID = ''

type UiStateRecord = Record<string, Record<string, unknown>>

/** 解锁取 token 的 API 头（notes-view.spec 同款） */
async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 服务端 uiState local 实例记录（uiState 按实例键控，'local' = 本机实例） */
async function readLocalUiState(headers: Record<string, string>): Promise<UiStateRecord> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, UiStateRecord> } | null
  return body?.data?.local ?? {}
}

/** GET+合并整键 PATCH 单命名空间（notes-view.spec patchLayout 同款：layout 等顶层
 *  键整体替换，裸发字段会把既有键抹成默认；此处只动目标命名空间，其余保留） */
async function patchUiStateNamespace(ns: string, patch: Record<string, unknown>, headers: Record<string, string>): Promise<void> {
  const local = await readLocalUiState(headers)
  const merged = { ...(local[ns] ?? {}), ...patch }
  const res = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH', headers, body: JSON.stringify({ local: { [ns]: merged } }),
  })
  expect(res.ok).toBeTruthy()
}

/** 首页 → 金态种子项目卡进入项目页（projectCardByName 整词定位防子串误中） */
async function enterProject(page: Page): Promise<void> {
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, SEED_PROJECT).first().click()
  await page.waitForURL('**/project')
}

/** 元素实测宽（bounding box，与内联 width px 值一致——notes/remote-sidebar-resize
 *  同款口径） */
async function elWidth(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox()
  expect(box, `${selector} 应有 boundingBox`).toBeTruthy()
  return box!.width
}

/** 抓住把手水平拖 delta px（pointer 事件链：down → move(steps) → up，
 *  remote-sidebar-resize 同款） */
async function dragResizer(page: Page, selector: string, delta: number): Promise<void> {
  const box = await page.locator(selector).boundingBox()
  expect(box, `${selector} 应有 boundingBox`).toBeTruthy()
  const cx = box!.x + box!.width / 2
  const cy = box!.y + box!.height / 2
  await page.mouse.move(cx, cy)
  await page.mouse.down()
  await page.mouse.move(cx + delta, cy, { steps: 5 })
  await page.mouse.up()
}

/** ARIA slider 把手键盘微调 +16 即落盘（SidebarResizer nudge，notes-sidebar-resize
 *  同链——比鼠标拖拽确定，无命中区/步进摩擦） */
async function nudgeResizer(page: Page, selector: string): Promise<void> {
  await page.locator(selector).focus()
  await page.keyboard.press('ArrowRight')
}

/** 刷新后在原 URL 收敛（等 boot 遮罩退场 + 容忍锁定态——notes-sidebar-resize
 *  openNotesOverlayAfterReload 同款） */
async function settleAfterReload(page: Page): Promise<void> {
  await waitForAppReady(page)
  await unlockIfNeeded(page)
}

// ============ 夹具：远程刷新守卫用例的宿主记录 ============
// API 播种/清理（remote-sidebar-resize.spec 同款口径，不动 WSL 等共享主机）
async function seedMatrixHost(): Promise<void> {
  const headers = await unlockHeaders()
  // 上轮失败中断的残留兜底（幂等）后重播
  const stale = (await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()) as { data?: Array<{ id?: string; name?: string }> }
  for (const h of stale.data ?? []) {
    if (h.name === HOST_NAME && h.id) await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
  }
  const made = await fetch(`${API_BASE}/api/remotehosts`, {
    method: 'POST', headers,
    body: JSON.stringify({ name: HOST_NAME, host: '127.0.0.1', port: 22, user: 'e2e', authType: 'password', protocol: 'ssh', password: 'matrix-e2e-placeholder' }),
  })
  expect([200, 201]).toContain(made.status)
  const list = (await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()) as { data?: Array<{ id?: string; name?: string }> }
  const found = (list.data ?? []).find(h => h.name === HOST_NAME)
  expect(found?.id, '夹具主机应已播种').toBeTruthy()
  HOST_ID = found!.id!
}

async function deleteMatrixHost(): Promise<void> {
  const headers = await unlockHeaders()
  const list = (await (await fetch(`${API_BASE}/api/remotehosts`, { headers })).json()) as { data?: Array<{ id?: string; name?: string }> }
  for (const h of list.data ?? []) {
    if (h.name === HOST_NAME && h.id) await fetch(`${API_BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
  }
}

test.beforeAll(async () => {
  await seedMatrixHost()
})

test.beforeEach(async () => {
  // 服务端 uiState local 记录全清（workspace-snapshot.spec 同款）：本 spec 各钉
  // 都从「无记录 → 用例自身驱动写入」出发，前序用例/前序 spec 的布局、开态、
  // remoteConsole 残留一律不作为输入
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify({ local: null }) })
  expect(res.ok).toBeTruthy()
})

test.afterEach(async ({ page, request }) => {
  // 先卸载 SPA（unload 路径 forceSave 回写先行落定）再 API 清——防清场被回写
  // 覆盖（closeDshConsoleAndClearState 头注同款事故面）；本 helper 清
  // dshConsole/notesView/shareManager 三命名空间，remoteConsole/layout 随后补清
  await closeDshConsoleAndClearState(page, request, API_BASE)
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: { remoteConsole: null, layout: null } }),
  })
})

test.afterAll(async () => {
  await deleteMatrixHost()
})

// ============ 用例 1：layout.main 行（collect 轨） ============
// 注册表行 layout.main：刷新「✓ restoreLayoutOnly」/ 路由往返「✓ 保持」/
// 换浏览器「✓（按实例、跨浏览器）」——主侧栏宽一钉三面。钉恢复语义（宽值恢复）
// 不钉恢复链内部
test('layout.main 行：主侧栏宽刷新恢复 + 路由往返保持 + 换浏览器跟随（按实例存）', async ({ page, browser }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders()
  await enterProject(page)
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 10000 })

  // 侧栏拖窄到钳位下限 180（SidePanel [180,500]，向左拖 120 触发下限——
  // layout-reset/workspace-snapshot 同款手法）
  await dragResizer(page, '.ide-side-resizer', -120)
  await expect(page.locator('#side-panel')).toHaveAttribute('style', /width:\s*180px/)

  // 落盘收敛后再动身：collect auto-save 防抖（P-20261002-8 键级补丁），轮询服务端
  // layout.sidePanelWidth——落定前刷新/往返断的是旧值不算恢复
  await expect.poll(async () => {
    const local = await readLocalUiState(headers)
    return (local.layout as { sidePanelWidth?: number } | undefined)?.sidePanelWidth
  }, { timeout: 10000 }).toBe(180)

  // 路由往返保持：回首页再回项目（内存态跨路由存活，agent-terminal dsh 用例同序列）
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(page.locator('#side-panel')).toHaveAttribute('style', /width:\s*180px/)

  // 刷新恢复：boot 从服务端记录落位
  await page.reload()
  await settleAfterReload(page)
  await expect(page.locator('#side-panel')).toHaveAttribute('style', /width:\s*180px/, { timeout: 10000 })

  // 双 context（= 换浏览器）：uiState 按实例存，换浏览器进项目照样恢复 180
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  try {
    await fixedLocale(pageB)
    await enterProject(pageB)
    await expect(pageB.locator('#side-panel')).toHaveAttribute('style', /width:\s*180px/, { timeout: 10000 })
  } finally {
    await ctxB.close()
  }
})

// ============ 用例 2：notesView 行（writer 轨）双 context ============
// 注册表行 notesView：换浏览器「✓（实例记录）」——刷新/路由往返已由
// notes-view.spec 钉（P-20261114-4-S2 分场景槽），此处只补双 context 互通钉。
// 开态在首页打开 → 落 home 槽 notesView.homeOpen（P-20261114-4-S2 分场景槽，
// 本用例 poll 键随分槽自 notesView.open 换 home 槽位键——如实改钉清单）
test('notesView 行：双 context 互通——开态落服务端实例记录，换浏览器上下文跟随恢复', async ({ page, browser }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await closeNotesOverlayIfOpen(page)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })

  // 开态即时落盘（persistNotesViewOpen watch 统一写，home 场景落 homeOpen 槽；
  // notes-view.spec 同款 poll 原语）
  const headers = await unlockHeaders()
  await expect.poll(async () => {
    const local = await readLocalUiState(headers)
    return (local.notesView as { homeOpen?: boolean } | undefined)?.homeOpen
  }, { timeout: 8000 }).toBe(true)

  // 新浏览器上下文：boot@home 恢复链从实例记录 home 槽拉起 overlay
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  try {
    await fixedLocale(pageB)
    await gotoAndUnlock(pageB, `${API_BASE}/`)
    const overlayB = pageB.locator('[data-testid="notes-home-overlay"]')
    await expect(overlayB).toBeVisible({ timeout: 10000 })
    await expect(overlayB.locator('[data-testid="notes-panel"]')).toBeVisible()

    // B 侧显式关闭（Esc 落盘 homeOpen=false）再关 ctx——beforeunload 补丁不发
    // 新变更，不与 afterEach 清场竞态
    await pageB.keyboard.press('Escape')
    await expect(overlayB).toBeHidden()
  } finally {
    await ctxB.close()
  }
})

// ============ 用例 3：remoteConsole 行（writer 轨）刷新守卫 ============
// 注册表行 remoteConsole：刷新「✓ restoreLayoutOnly（open+tabs>0 才恢复）」——
// 守卫两侧都钉：无 tabs 纯视图标记不拉起（避免把后续进入带进远程视图），
// open+tabs>0 拉起并还原 tab 位。seed 远程主机使 tab 真实可还原（restoreTabs
// 按 hostById 过滤死主机）
test('remoteConsole 行：刷新恢复守卫——open+tabs>0 才恢复（无 tabs 不拉起 / 有 tabs 拉起还原 tab）', async ({ page }) => {
  test.setTimeout(90_000)
  const headers = await unlockHeaders()

  // 负侧：open=true 且 tabs 空 → 刷新后视图不恢复
  await patchUiStateNamespace('remoteConsole', { open: true, tabs: [], groups: [], sidebarCollapsed: false }, headers)
  await fixedLocale(page)
  await enterProject(page)
  await expect(page.locator('.remote-root')).toHaveCount(0)

  // 正侧：open+tabs>0 → 刷新后视图拉起 + tab 位还原（会话过期置 ended 不影响 tab 位）
  await patchUiStateNamespace('remoteConsole', {
    open: true,
    tabs: [{ hostId: HOST_ID, sessionId: STALE_TAB.sessionId, title: STALE_TAB.title }],
  }, headers)
  await page.reload()
  await settleAfterReload(page)
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.remote-tab').filter({ hasText: STALE_TAB.title })).toHaveCount(1, { timeout: 10000 })
})

// ============ 用例 4：remoteConsole 行（writer 轨）路由往返 ============
// 注册表行 remoteConsole：路由往返「✓ 保持」——主区视图内存态跨首页往返存活
// （与 agent-terminal.spec dsh 用例同导航序列）
test('remoteConsole 行：路由往返工作面保持——打开 → 回首页 → 回项目视图仍在', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await enterProject(page)
  await page.locator('[data-testid="rail-remote-console"]').click()
  const view = page.locator('.remote-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="rail-remote-console"]')).toHaveClass(/active/)
})

// ============ 用例 5：dshConsole.open 行（writer 轨）刷新恢复 ============
// 注册表行 dshConsole.open：刷新「✓ restoreDshConsoleOnce（notes 先 dsh 后显式
// 定序）」——路由往返已由 agent-terminal.spec 钉，此处只补刷新恢复钉。
// dsh 令牌未配置态渲染主题化引导卡（8a44349），容器可见性即恢复语义
test('dshConsole.open 行：刷新恢复——boot 定序恢复链拉起控制台视图', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await enterProject(page)
  await page.locator('[data-testid="rail-dsh-console"]').click()
  await expect(page.locator('.dsh-console-embedded')).toBeVisible({ timeout: 10000 })

  // 开态即时落盘（persistDshConsoleOpen watch）——落定后刷新才可信
  const headers = await unlockHeaders()
  await expect.poll(async () => {
    const local = await readLocalUiState(headers)
    return (local.dshConsole as { open?: boolean } | undefined)?.open
  }, { timeout: 8000 }).toBe(true)

  await page.reload()
  await settleAfterReload(page)
  await expect(page.locator('.dsh-console-embedded')).toBeVisible({ timeout: 10000 })
})

// ============ 用例 6：shareManager.open 行（writer 轨）刷新 + 往返 ============
// 注册表行 shareManager.open：刷新「✓ restoreShareManagerOnce（notes→dsh→share
// 定序，异常双真存档后到者胜）」/ 路由往返「✓ 保持」——share 视图无首页形态，
// 回首页主区让位、回项目 v-show 复位
test('shareManager.open 行：刷新恢复 + 路由往返保持', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await enterProject(page)
  await page.locator('[data-testid="rail-share-manager"]').click()
  const view = page.locator('.share-manager-embedded')
  await expect(view).toBeVisible({ timeout: 10000 })

  // 开态即时落盘（persistShareManagerOpen watch）——落定后刷新才可信
  const headers = await unlockHeaders()
  await expect.poll(async () => {
    const local = await readLocalUiState(headers)
    return (local.shareManager as { open?: boolean } | undefined)?.open
  }, { timeout: 8000 }).toBe(true)

  // 刷新恢复
  await page.reload()
  await settleAfterReload(page)
  await expect(view).toBeVisible({ timeout: 10000 })

  // 路由往返保持
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeVisible({ timeout: 10000 })
})

// ============ 用例 7：侧栏宽族（localStorage 轨）双 context ============
// 注册表行 ls.panelSidebarWidth（sc.notes/sc.remoteConsole.sidebarWidth）+
// ls.agentTerminal.sidebarWidth：换浏览器「✗（设备本地）」——三面板各钉默认宽
// 回落；与用例 1 的 layout.sidePanelWidth 跨浏览器保持构成「按实例/按设备两档」
// 对照。同 context 刷新恢复已由 remote/notes-sidebar-resize.spec 钉
test('侧栏宽族：双 context 设备本地——agent/remote/notes 侧栏宽换浏览器不保持（各回落默认宽）', async ({ page, browser }) => {
  test.setTimeout(120_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await closeNotesOverlayIfOpen(page)

  // —— A 上下文：三面板侧栏各改宽（键盘微调/拖拽，useSidebarWidth 统一链）
  // notes：+16 即落盘
  await page.locator('[data-testid="home-notes"]').click()
  const panelA = page.locator('[data-testid="notes-home-overlay"] [data-testid="notes-panel"]')
  await expect(panelA).toBeVisible({ timeout: 8000 })
  await nudgeResizer(page, '[data-testid="notes-home-overlay"] [data-testid="notes-panel"] .sidebar-resizer')
  expect(await elWidth(page, '.np-sidebar')).toBeCloseTo(NOTES_W_DEFAULT + 16, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), NOTES_W_KEY)).toBe(String(NOTES_W_DEFAULT + 16))
  // Esc 显式收 overlay（开态不留 uiState 残留；宽度键留在设备本地）
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toBeHidden()

  // agent：拖 +80
  await enterProject(page)
  await page.locator('[data-testid="rail-agent-terminal"]').click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  await dragResizer(page, '.atv-side-resizer', 80)
  await expect(page.locator('.atv-sidebar')).toHaveAttribute('style', /width:\s*340px/)
  expect(await page.evaluate((k) => localStorage.getItem(k), AGENT_W_KEY)).toBe(String(AGENT_W_DEFAULT + 80))

  // remote：+16 即落盘（开远程按互斥收 agent docked）
  await page.locator('[data-testid="rail-remote-console"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await nudgeResizer(page, '.remote-root .sidebar-resizer')
  expect(await elWidth(page, '.remote-sidebar')).toBeCloseTo(REMOTE_W_DEFAULT + 16, 0)
  expect(await page.evaluate((k) => localStorage.getItem(k), REMOTE_W_KEY)).toBe(String(REMOTE_W_DEFAULT + 16))

  // —— B 上下文（= 换浏览器）：三把宽度键全新（设备本地不随实例记录走），
  // 各面板开出来都是默认宽——「两浏览器上下文各态独立」的直接实证
  const ctxB = await browser.newContext()
  const pageB = await ctxB.newPage()
  try {
    await fixedLocale(pageB)
    await gotoAndUnlock(pageB, `${API_BASE}/`)
    for (const k of [NOTES_W_KEY, AGENT_W_KEY, REMOTE_W_KEY]) {
      expect(await pageB.evaluate((key) => localStorage.getItem(key), k), `${k} 不应跨浏览器跟随`).toBeNull()
    }

    // notes 默认 260（非 A 的 276）
    await pageB.locator('[data-testid="home-notes"]').click()
    const panelB = pageB.locator('[data-testid="notes-home-overlay"] [data-testid="notes-panel"]')
    await expect(panelB).toBeVisible({ timeout: 8000 })
    expect(await elWidth(pageB, '.np-sidebar')).toBeCloseTo(NOTES_W_DEFAULT, 0)
    await pageB.keyboard.press('Escape')
    await expect(pageB.locator('[data-testid="notes-home-overlay"]')).toBeHidden()

    // agent 默认 260（非 A 的 340）
    await enterProject(pageB)
    await pageB.locator('[data-testid="rail-agent-terminal"]').click()
    await expect(pageB.locator('.atv-root')).toBeVisible({ timeout: 10000 })
    expect(await elWidth(pageB, '.atv-sidebar')).toBeCloseTo(AGENT_W_DEFAULT, 0)

    // remote 默认 320（非 A 的 336）
    await pageB.locator('[data-testid="rail-remote-console"]').click()
    await expect(pageB.locator('.remote-root')).toBeVisible({ timeout: 10000 })
    expect(await elWidth(pageB, '.remote-sidebar')).toBeCloseTo(REMOTE_W_DEFAULT, 0)
  } finally {
    await ctxB.close()
  }
})
