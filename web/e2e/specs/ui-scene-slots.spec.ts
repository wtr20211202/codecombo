import { test, expect, type Page } from '@playwright/test'
import {
  closeDshConsoleAndClearState, closeNotesOverlayIfOpen, fixedLocale, gotoAndUnlock,
  projectCardByName, unlockIfNeeded, waitForAppReady, DEFAULT_PASSWORD,
} from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 工作面场景归属隔离 S2：分场景持久化槽 e2e（P-20261114-4-S2）。
 *
 * 提案七例清单中 ①②③④⑤⑦ 落本 spec；⑥ = uistate-lanes-matrix.spec 往返钉
 * 回归（:192/:277/:301/:321/:344/:377 六钉绿 + :237 落盘 poll 键随分槽换 home
 * 槽位键——改钉在该 spec 内随本提案落地，如实清单）。
 *
 * 语义基线（评审六点修订定案）：工作面归属打开它的场景——notesView/dsh 开态键族
 * 按场景分槽（open=project 槽，旧单槽值原位向后兼容零迁移；homeOpen=home 槽，旧
 * 存档无键按关恢复）；恢复读取点从「仅 boot」升格「每场景每 load 首进读该场景槽
 * 一次」（boot=首进特例；S1 per-scene 内存快照覆盖路由往返，本 spec 钉跨刷新与
 * 跨场景槽位隔离面）。
 *
 * 纪律：beforeEach 服务端 uiState local 记录全清（uistate-lanes-matrix.spec 同款
 * `{ local: null }`，每用例从出厂态出发）；afterEach 先卸载 SPA 再 API 清场
 * （closeDshConsoleAndClearState 头注同款事故面：unload 路径 forceSave 回写先行
 * 落定，清场才不被覆盖）。零平台分支、零新依赖。
 */

const SEED_PROJECT = 'simple-coding'

type UiStateRecord = Record<string, Record<string, unknown>>

/** 解锁取 token 的 API 头（uistate-lanes-matrix.spec 同款） */
async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 服务端 uiState local 实例记录 */
async function readLocalUiState(headers: Record<string, string>): Promise<UiStateRecord> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, UiStateRecord> } | null
  return body?.data?.local ?? {}
}

/** notesView 双槽现值（open=project 槽 / homeOpen=home 槽） */
async function notesSlots(headers: Record<string, string>): Promise<{ open?: boolean; homeOpen?: boolean }> {
  const local = await readLocalUiState(headers)
  const ns = local.notesView as { open?: boolean; homeOpen?: boolean } | undefined
  return { open: ns?.open, homeOpen: ns?.homeOpen }
}

/** GET+合并整键 PATCH 单命名空间（uistate-lanes-matrix.spec patchUiStateNamespace
 *  同款：顶层键整体替换，裸发字段会把既有键抹成默认；此处只动目标命名空间） */
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
  await projectCardByName(page, SEED_PROJECT).first().click()
  await page.waitForURL('**/project')
}

/** 回首页并等工具条收敛（防导航未完成时计数断言空过——agent-terminal 同款序列） */
async function goHome(page: Page): Promise<void> {
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
}

/** 刷新后在原 URL 收敛（等 boot 遮罩退场 + 容忍锁定态） */
async function settleAfterReload(page: Page): Promise<void> {
  await waitForAppReady(page)
  await unlockIfNeeded(page)
}

test.beforeEach(async () => {
  // 服务端 uiState local 记录全清：本 spec 各例都从「无记录 → 用例自身驱动写入」
  // 出发，前序用例/前序 spec 的开态残留一律不作为输入
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { method: 'PUT', headers, body: JSON.stringify({ local: null }) })
  expect(res.ok).toBeTruthy()
})

test.afterEach(async ({ page, request }) => {
  // 先卸载 SPA（unload 路径 forceSave 回写先行落定）再 API 清——防清场被回写覆盖；
  // ④ 开过远程视图，remoteConsole 一并补清（uistate-lanes-matrix afterEach 同款）
  await closeDshConsoleAndClearState(page, request, API_BASE)
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: { remoteConsole: null } }),
  })
})

// ============ ① 项目开笔记 → 回首页不显示 → 回项目恢复 ============
// 注册表行 notesView（P-20261114-4-S2 分场景槽）：项目开态落 project 槽（open），
// 回首页 overlay 不呈现（首页纯导航——P-20261114-1「overlay 呈现」旧口径翻转），
// 回项目经场景快照恢复（S1）——跨场景运行态互不越界
test('① 项目开笔记 → 回首页不显示 → 回项目恢复', async ({ page }) => {
  test.setTimeout(60_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  const railNotes = page.locator('[data-testid="rail-notes"]')
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })

  // 项目开态落 project 槽（严格断言 open:true——显式写持久化态而非清场归零）
  const headers = await unlockHeaders()
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(true)

  await goHome(page)
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toHaveCount(0)

  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeVisible({ timeout: 8000 })
  await expect(railNotes).toHaveClass(/active/)

  // 收尾关闭（开态残留会跨用例复活遮首页入口——同族收尾纪律）
  await page.locator('[data-testid="notes-close"]').click()
  await expect(view).toBeHidden()
})

// ============ ② 首页开笔记 → 去项目不显示 → 回首页恢复 ============
// 双向对称面：首页显式开态落 home 槽（homeOpen），去项目主区不跟随（project 槽
// 缺席 → boot/首进恢复链不拉起）；整页导航模拟「离开首页」，回首页（SPA 后退）
// 首进 home 桶读 homeOpen 槽恢复 overlay
test('② 首页开笔记 → 去项目不显示 → 回首页恢复', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await closeNotesOverlayIfOpen(page)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })

  // 首页开态落 home 槽，project 槽不被回声覆写（分场景槽位断言）
  const headers = await unlockHeaders()
  await expect.poll(async () => (await notesSlots(headers)).homeOpen, { timeout: 8000 }).toBe(true)
  expect((await notesSlots(headers)).open).toBeUndefined()

  // 去项目（整页导航 = 跨刷新进项目）：boot@project 恢复链读 project 槽（缺席）
  // → 主区笔记不出现——home 开态不跟随
  await page.goto(`${API_BASE}/project`)
  await settleAfterReload(page)
  await expect(page.locator('[data-testid="notes-view"]')).toBeHidden({ timeout: 10000 })

  // 回首页（SPA 后退）：NotesView context=home 宿主重挂 → home 桶首进读 homeOpen
  // 槽 → overlay 恢复
  await page.goBack()
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('[data-testid="notes-panel"]')).toBeVisible()

  // 收尾：Esc 显式关闭落 home 槽（防残留跨用例/跨 run 复活）
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
  await expect.poll(async () => (await notesSlots(headers)).homeOpen, { timeout: 8000 }).toBe(false)
})

// ============ ③ 显式关闭跟随（project 侧） ============
// project 槽显式关闭（头部 ×）落 open=false：跨场景往返不复活、跨刷新不复活；
// home 槽独立不受 project 关闭扰动
test('③ 显式关闭跟随：项目内关闭落 project 槽，跨往返/刷新不复活，home 槽不受扰', async ({ page }) => {
  test.setTimeout(90_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  const railNotes = page.locator('[data-testid="rail-notes"]')
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })
  const headers = await unlockHeaders()
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(true)

  // 项目内显式关闭（头部 ×）→ project 槽 open=false 落盘
  await page.locator('[data-testid="notes-close"]').click()
  await expect(view).toBeHidden()
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(false)
  expect((await notesSlots(headers)).homeOpen).toBeUndefined() // home 槽不受扰

  // 回首页（不显示）→ 回项目：显式关闭跟随，不复活（恢复链仅仍为关态置开，
  // 槽值已是关）
  await goHome(page)
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toHaveCount(0)
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeHidden({ timeout: 8000 })
  await expect(railNotes).not.toHaveClass(/active/)

  // 跨刷新仍关（boot@project 读 project 槽 open=false）
  await page.reload()
  await settleAfterReload(page)
  await expect(page.locator('[data-testid="notes-view"]')).toBeHidden({ timeout: 10000 })
})

// ============ ④ 互斥回归 ============
// 主区互斥族在分场景槽下的回归：project 侧——开远程收笔记（互斥隐式关闭落
// project 槽 open=false），回首页不显示远程 overlay、回项目远程恢复笔记不复活；
// home 侧——笔记 overlay 开态被悬浮球展开的 docked 互斥收起（z 900 全屏浮层互斥
// 下工具条不可点，悬浮球 z 2500 是唯一浮于其上的交叉关闭入口，notes-view.spec
// 交叉关闭用例同款路径），dsh 浮层经工具条按钮打开（Esc 收 docked 后可达）——
// 各写落各自 home 槽
test('④ 互斥回归：开远程收笔记（project 槽）+ 首页悬浮球收笔记/dsh 浮层开（home 槽）', async ({ page }) => {
  test.setTimeout(120_000)
  await fixedLocale(page)
  // 悬浮球形态播种（openState 持久化键，挂载时消费恢复）：单击球（无任务归属）
  // 即 open() 回到 docked——首页笔记 overlay 之上的唯一可达交叉关闭入口
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' }))
      localStorage.setItem('sc.agentTerminal.expandedMode', 'docked')
    } catch { /* ignore */ }
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  await page.locator('[data-testid="rail-notes"]').click()
  await expect(view).toBeVisible({ timeout: 8000 })
  const headers = await unlockHeaders()
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(true)

  // project 侧互斥：开远程收笔记 → project 槽 open=false 落盘
  await page.locator('[data-testid="rail-remote-console"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(false)

  // 回首页：场景归属——远程 overlay 不呈现（home 场景无此开态）
  await goHome(page)
  await expect(page.locator('.remote-console-overlay')).toHaveCount(0)
  await expect(page.locator('.dsh-console-home')).toHaveCount(0)

  // 回项目：远程恢复（场景快照）、笔记不复活（槽值已是关）
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(view).toBeHidden({ timeout: 8000 })

  // home 侧互斥一：回首页开笔记 overlay → 悬浮球展开 docked 收笔记——
  // notesView.homeOpen=false 落 home 槽（closeMainViews 统一收口），project 槽不受扰
  await goHome(page)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => (await notesSlots(headers)).homeOpen, { timeout: 8000 }).toBe(true)
  await page.locator('.agm-root.is-ball').click()
  await expect(page.locator('.agt-home-overlay .atv-root')).toBeVisible({ timeout: 10000 })
  await expect(overlay).toBeHidden()
  await expect.poll(async () => (await notesSlots(headers)).homeOpen, { timeout: 8000 }).toBe(false)
  expect((await notesSlots(headers)).open).toBe(false) // project 槽不被首页互斥回声覆写

  // home 侧互斥二：Esc 收 docked overlay（既有链，工具条恢复可达）→ dsh 浮层
  // 按钮打开 → dshConsole.homeOpen=true 落 home 槽（笔记本已关，closeNotesView
  // 无 ref 变化零写）
  await page.keyboard.press('Escape')
  await expect(page.locator('.agt-home-overlay')).toBeHidden()
  await page.locator('.home-action-btn[title="dsh 控制台"]').click()
  await expect(page.locator('.dsh-console-home')).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => {
    const local = await readLocalUiState(headers)
    return (local.dshConsole as { homeOpen?: boolean } | undefined)?.homeOpen
  }, { timeout: 8000 }).toBe(true)
  expect((await notesSlots(headers)).homeOpen).toBe(false) // 笔记 home 槽不被 dsh 开态回声覆写
})

// ============ ⑤ 刷新按所在场景恢复 ============
// 恢复读取点升格「每场景每 load 首进读该场景槽」：刷新落在哪个场景就恢复哪个
// 场景槽——项目页刷新恢复 project 槽、首页刷新按 home 槽（缺席不恢复/开态恢复），
// 双槽并存互不干扰
test('⑤ 刷新按所在场景恢复：项目页刷新读 project 槽，首页刷新读 home 槽', async ({ page }) => {
  test.setTimeout(120_000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  await page.locator('[data-testid="rail-notes"]').click()
  await expect(view).toBeVisible({ timeout: 8000 })
  const headers = await unlockHeaders()

  // 段1：项目页刷新 → project 槽恢复
  await page.reload()
  await settleAfterReload(page)
  await expect(view).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="rail-notes"]')).toHaveClass(/active/)

  // 段2：回首页（overlay 不呈现）→ 首页刷新 → home 槽缺席不恢复
  await goHome(page)
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toHaveCount(0)
  await page.reload()
  await settleAfterReload(page)
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toHaveCount(0)

  // 段3：首页开笔记 → 首页刷新 → home 槽恢复；此时双槽并存（open=true 且
  // homeOpen=true），互不覆写
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  await expect.poll(async () => (await notesSlots(headers)).homeOpen, { timeout: 8000 }).toBe(true)
  await page.reload()
  await settleAfterReload(page)
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('[data-testid="notes-panel"]')).toBeVisible()
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(true)

  // 收尾 home overlay（Esc 显式关闭——z 900 遮罩挡项目卡点击；关闭落 home 槽）
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()

  // 尾：进项目仍恢复 project 槽开态（双槽并存下场景快照+槽位读取各归各）
  await enterProject(page)
  await expect(view).toBeVisible({ timeout: 10000 })
})

// ============ ⑦ boot@home → 首进 project 恢复 project 槽开态 ============
// 评审修订点③：boot 恢复链只落 boot 场景，boot@home 后首进 project 不读槽则
// 「进入项目恢复之前状态」跨刷新断裂——project 槽预置开态（上一次会话遗留形态，
// API 直播 = 旧数据面），boot@home overlay 不呈现（读 home 槽缺席），首进 project
// 时 project 桶首进读槽 open=true 拉起主区视图
test('⑦ boot@home → 首进 project 恢复 project 槽开态', async ({ page }) => {
  test.setTimeout(60_000)
  const headers = await unlockHeaders()
  // project 槽预置开态（旧数据面形态：只有 open 子键，无 homeOpen——升级兼容面）
  await patchUiStateNamespace('notesView', { open: true }, headers)

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  // boot@home：home 槽缺席 → overlay 不呈现（project 槽值不越界到首页）；
  // 先等首页收敛再计数断言（agent-terminal 同款防导航未完成空过）
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="notes-home-overlay"]')).toHaveCount(0)

  // 首进 project：场景宿主挂载 → project 桶首进读 open 槽 → 主区视图恢复
  await enterProject(page)
  await expect(page.locator('[data-testid="notes-view"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="rail-notes"]')).toHaveClass(/active/)
  // 槽位未被恢复回声腐化：open 仍 true、homeOpen 仍缺席
  await expect.poll(async () => (await notesSlots(headers)).open, { timeout: 8000 }).toBe(true)
  expect((await notesSlots(headers)).homeOpen).toBeUndefined()

  // 收尾关闭（开态残留会跨用例复活遮首页入口——同族收尾纪律）
  await page.locator('[data-testid="notes-close"]').click()
  await expect(page.locator('[data-testid="notes-view"]')).toBeHidden()
})
