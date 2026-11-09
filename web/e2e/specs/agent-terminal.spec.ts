import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { closeDshConsoleAndClearState, DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 智能体（系统级多会话终端）E2E：
 *   1. Agent Token API：自动播种存在（exists=true）
 *   2. 活动栏入口 → docked 管理页（空状态引导）→ 新建会话（xterm 渲染）
 *   3. 悬浮窗：多会话 tab 条 + 右下角调大小手柄
 *   4. 收起悬浮条 → 右键样式菜单切「悬浮条」→ 单击展开回悬浮窗
 *   5. tab × 结束会话（确认弹窗）
 * 会话创建会按设置拉起底层运行时（claude/codex/dsh；e2e 机为 claude），
 * 测试只断言终端 UI 链路，不与智能体 TUI 交互；afterEach 兜底销毁残留会话
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux/claude 进程）。
 *  管理页侧栏同时展示项目会话与系统会话，只清 agent 会话会让外部残留的
 *  项目会话混入 .ats-item 计数——这里的用例断言基于「空白会话表」 */
async function cleanupAgentTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; kind?: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 清账 pending 审批（跨用例共享服务端状态，通知中心同款纪律）：本文件三个
 *  审批用例断言 .aprv-card 计数 1/0——任何前序 spec 泄漏的 pending 卡都会把
 *  卡堆顶过折叠阈值（visibleList 只显最新一张）令计数恒 1，且折叠态点的是
 *  可见最新卡（run15 实测五连假败根因）。用例开头先清场防他处残留 */
async function cleanupPendingApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 进入项目页（活动栏挂载宿主） */
async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
}

test.beforeEach(async ({ request }) => {
  await cleanupAgentTerminals(request)
  await cleanupPendingApprovals(request)
})

test('Agent Token：服务端自动播种，管理 API 可用', async ({ request }) => {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/agent-token`, { headers })
  expect(res.ok()).toBeTruthy()
  const meta = ((await res.json()) as { data?: { exists: boolean; prefix: string } }).data
  expect(meta?.exists).toBe(true)
  expect(meta?.prefix?.length).toBe(4)

  // 撤销后 exists=false，再次 GET 重新播种（开箱即用语义）
  await request.delete(`${BASE}/api/agent-token`, { headers })
  const res2 = await request.get(`${BASE}/api/agent-token`, { headers })
  const meta2 = ((await res2.json()) as { data?: { exists: boolean } }).data
  expect(meta2?.exists).toBe(true)
})

test('智能体：管理页新建会话 → 悬浮窗多会话/调大小 → 悬浮条样式切换 → 销毁', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 活动栏入口（registry：agent-terminal / order 50；title 已更名「终端会话管理」）
  const railBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await expect(railBtn).toHaveCount(1)
  await railBtn.click()

  // docked 管理页出现：空状态引导（说明可直接操作本系统）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await expect(view.locator('.atv-empty-hint')).toContainText('操作本系统')

  // 新建会话（对话框主入口）：选纯终端运行时 + 真实临时目录 → 创建 → 列表项出现
  // 工作目录按服务端形态填入（服务端在此 cwd 拉起 shell，linux 实例要 /mnt/c 形态）。
  // 运行时下拉按表单行语义定位（P-20261002-16 对话框加了任务模板第二枚
  // .n-base-selection，裸 locator 会 strict violation）
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-agent-e2e-'))
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  await dlg.locator('input').nth(1).fill(serverPath(tmpDir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 10000 })
  await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
  await expect(view.locator('.xterm').first()).toBeVisible({ timeout: 15000 })

  // 产出面板（B3）：临时目录非 git 仓库 → 打开面板应给出引导文案而非报错
  // 图标渲染断言：组件未导入时 vue 静默渲染为未知空元素（回归教训）
  await expect(
    view.locator('.atv-header-actions [title="会话产出"] svg'),
  ).toHaveCount(1)
  await view.locator('.atv-header-actions [title="会话产出"]').click()
  await expect(view.locator('.aap-root')).toBeVisible({ timeout: 5000 })
  await expect(view.locator('.aap-empty')).toContainText('git 仓库', { timeout: 5000 })
  await view.locator('.aap-header [title="关闭"]').click()
  await expect(view.locator('.aap-root')).toHaveCount(0)

  // 终端右键菜单（与项目终端同层能力）：菜单弹出 + 清屏动作生效不报错
  await view.locator('.xterm').first().click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  // 全局终端末项为纯「清空屏幕」（无「清空并重启」重启语义，重启会终止会话内任务）
  await expect(ctxMenu.getByText('清空屏幕', { exact: true })).toBeVisible()
  await ctxMenu.getByText('清空屏幕', { exact: true }).click()
  await expect(ctxMenu).toHaveCount(0)

  // 切悬浮窗：窗口 + 调大小手柄；单会话无 tab 条
  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  const floatBox = page.locator('.atv-root.is-float')
  await expect(floatBox).toBeVisible({ timeout: 10000 })
  // 缩放手柄存在（终端 canvas z 序覆盖导致 Playwright 判定 hidden，但几何/事件正常）
  await expect(floatBox.locator('.agt-resize')).toHaveCount(1)
  await expect(floatBox.locator('.agt-tab')).toHaveCount(0)
  // float 模式 inline 几何生效（position:fixed + 持久化尺寸）
  const geo = await floatBox.evaluate(el => ({
    isFloat: el.classList.contains('is-float'),
    computedPos: getComputedStyle(el).position,
    w: parseInt(el.style.width),
    h: parseInt(el.style.height),
  }))
  console.log('[FLOAT-GEO]', JSON.stringify(geo))
  expect(geo.isFloat).toBe(true)
  expect(geo.w).toBeGreaterThan(0)
  expect(geo.h).toBeGreaterThan(0)

  // 回管理页开第二个会话（对话框默认 auto）→ 再切悬浮窗 → tab 条出现
  await floatBox.locator('.atv-header-actions [title="打开管理页"]').click()
  await view.getByRole('button', { name: '新建会话' }).first().click()
  await expect(page.locator('.n-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.n-modal').getByRole('button', { name: '创建' }).click()
  await expect(page.locator('.n-modal')).toBeHidden({ timeout: 10000 })
  await expect(view.locator('.ats-item')).toHaveCount(2, { timeout: 10000 })
  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  await expect(floatBox.locator('.agt-tab')).toHaveCount(2, { timeout: 10000 })

  // 收起为悬浮条 → 右键样式菜单切「悬浮条」形态
  await floatBox.locator('.atv-header-actions [title="收起为悬浮球"]').click()
  const mini = page.locator('body > .agm-root')
  await expect(mini).toBeVisible({ timeout: 5000 })
  await mini.click({ button: 'right' })
  await page.locator('.n-dropdown:visible').getByText('悬浮条', { exact: true }).click()
  await expect(mini).toHaveClass(/is-bar/)

  // 单击悬浮条 → 回到上次展开形态（悬浮窗）
  await mini.click()
  await expect(floatBox).toBeVisible({ timeout: 5000 })

  // tab × 结束第二个会话（确认弹窗）→ tab 条随单会话隐藏
  await floatBox.locator('.agt-tab').nth(1).locator('.agt-tab-close').click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(floatBox.locator('.agt-tab')).toHaveCount(0, { timeout: 5000 })
  await expect(floatBox.locator('.xterm').first()).toBeVisible({ timeout: 15000 })
})

// P-20261106-4 失联回归 + P-20261107-3 导航语义改版：打开→回首页→再进项目。
// visible/mode 是 useAgentTerminal 模块级状态（跨路由存活）；P-20261107-3 起
// 回首页=纯首页（路由路过收起 docked，首页 overlay 不因模块态残留自动展开），
// 再进项目=恢复项目此前布局（会话级 per-项目记忆）。重挂实例的 everDocked
// watch immediate（P-20261106-4）仍在此序列上回归：无 immediate 时再进项目
// 面板 v-if 空壳。「再进项目」走 history 后退（SPA 回路由，浏览器返回键路径）
test('终端会话管理：打开→回首页=纯首页→再进项目=布局还原且面板非空', async ({ page, request }) => {
  await fixedLocale(page)
  // dsh 开状态经 uiState 服务端持久化，跨 spec 残留会在进项目时经主区互斥
  // watch 关掉 docked 管理页——先清场保证确定性（页面卸载后 API 清，见 helper 注释）
  await closeDshConsoleAndClearState(page, request, BASE)
  await enterProject(page)

  // 活动栏打开 docked 管理页（beforeEach 已清会话 → 空态引导）
  const railBtn = page.locator('[data-testid="rail-agent-terminal"]')
  await railBtn.click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  await expect(railBtn).toHaveClass(/active/)

  // 回首页=纯首页：导航路过收起 docked，overlay 不自动展开（P-20261107-3 前此处
  // 呈现 home overlay 管理页）。先等首页工具条出现再断言 overlay 缺席，防导航
  // 未完成时计数断言空过
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('.home-action-btn').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.agt-home-overlay')).toHaveCount(0)

  // 再进项目=布局还原：图标选中（registry 读模块态）且面板内容非空——
  // everDocked immediate 保证重挂实例面板非空壳（P-20261106-4 回归面）
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(railBtn).toHaveClass(/active/)
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.atv-empty-hint')).toContainText('操作本系统', { timeout: 10000 })
})

// P-20261107-3 导航语义补面：①记忆为关也恢复——项目内关掉管理页，回首页再进
// 项目不误展开（per-项目记忆记的是开合不是只记开）；②首页工具条图标=主动开，
// overlay 打开是用户动作而非导航残留
test('终端会话管理导航语义：关态记忆不误展开 + 首页主动开', async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, BASE)
  await enterProject(page)

  // 打开再收起：项目记忆=关（toggleDocked 再点=收起；内嵌保活仅 v-show 隐藏）
  const railBtn = page.locator('[data-testid="rail-agent-terminal"]')
  await railBtn.click()
  await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
  await railBtn.click()
  await expect(page.locator('.atv-root')).toBeHidden()

  // 回首页=纯首页；再进项目=关态记忆恢复（不开、图标不选中）
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('.home-action-btn').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.agt-home-overlay')).toHaveCount(0)
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(railBtn).not.toHaveClass(/active/)
  await expect(page.locator('.atv-root')).toHaveCount(0)

  // 回首页后点工具条图标主动开：overlay 打开（主动开语义不受导航收起误伤）
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('.home-action-btn').first()).toBeVisible({ timeout: 10000 })
  await page.locator('.home-action-btn[title="终端会话管理"]').click()
  await expect(page.locator('.agt-home-overlay .atv-root')).toBeVisible({ timeout: 10000 })
})

// P-20261106-4 横向同族回归：dsh 控制台（Layout dshEverOpened，模块级
// showDshConsole）与终端管理页同病——打开→回首页→再进项目面板空壳。
// 断言面一致：活动栏选中态与主区视图内容同步出现
test('dsh 控制台：打开→回首页→再进项目，主区视图随选中态非空', async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, BASE)
  await enterProject(page)

  const railDsh = page.locator('[data-testid="rail-dsh-console"]')
  await railDsh.click()
  await expect(page.locator('.dsh-console-embedded')).toBeVisible({ timeout: 10000 })
  await expect(railDsh).toHaveClass(/active/)

  await page.locator('.ide-header button[title="返回首页"]').click()
  // 回首页：首页浮层随模块态呈现（HomeView dshEverOpened 挂载即同步）
  await expect(page.locator('.dsh-console-home')).toBeVisible({ timeout: 10000 })

  await page.goBack()
  await page.waitForURL('**/project')
  await expect(railDsh).toHaveClass(/active/)
  await expect(page.locator('.dsh-console-embedded')).toBeVisible({ timeout: 10000 })

  // 收尾清场：dsh 开状态已 persist 到 uiState（persistDshConsoleOpen watch），
  // 不清会以全屏/浮层形态污染后续 spec（见 closeDshConsoleAndClearState 注释）
  await closeDshConsoleAndClearState(page, request, BASE)
})

// B4 约定式审批流：API 造 pending → 全局卡片出现 → 「允许一次」→ 状态机落账 + 卡片消失
test('智能体审批：ops-confirm 请求 → 卡片 → 允许', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const created = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'agent-e2e-appr', op: 'reset --hard', target: 'main', detail: 'e2e 审批流验证' },
  })
  expect(created.ok()).toBeTruthy()
  const { data: { id } } = await created.json() as { data: { id: string } }
  expect(id).toContain('sc_ap_')

  // 全局卡片出现（任意页面可见）
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('reset --hard')

  // 允许 → 卡片消失 + 后端状态机落账
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const poll = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers })
  const { data } = await poll.json() as { data: { status: string } }
  expect(data.status).toBe('allowed')
})

test('智能体审批：拒绝路径——卡片拒绝后后端状态机落账 denied', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const created = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'agent-e2e-appr-deny', op: 'push --force', target: 'main', detail: 'e2e 拒绝路径验证' },
  })
  expect(created.ok()).toBeTruthy()
  const { data: { id } } = await created.json() as { data: { id: string } }

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText('push --force')

  // 拒绝（P-20261003-21 可选理由流）：点拒绝展开理由输入行 → 留空确认 = 原行为
  // （无理由拒绝）；exact 匹配避免命中「确认拒绝」按钮
  await card.getByRole('button', { name: '拒绝', exact: true }).click()
  await expect(card.locator('[data-test="aprv-deny-input"]')).toBeVisible()
  await card.locator('[data-test="aprv-deny-confirm"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('.n-message').filter({ hasText: '已拒绝' })).toBeVisible({ timeout: 5000 })
  const poll = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers })
  const { data } = await poll.json() as { data: { status: string; reason?: string } }
  expect(data.status).toBe('denied')
  expect(data.reason || '').toBe('')
})

test('智能体审批：始终允许——审批模式落盘 allow 且用例后还原 ask', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const created = await request.post(`${BASE}/api/ops-confirm`, {
    headers,
    data: { sessionId: 'agent-e2e-appr-always', op: 'clean -fdx', target: '', detail: 'e2e 始终允许验证' },
  })
  expect(created.ok()).toBeTruthy()
  const { data: { id } } = await created.json() as { data: { id: string } }

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 完全允许包三选一放行时限弹层（P-20261003-316，P-20261002-126 升级）：档位明示后才落盘
  await card.getByRole('button', { name: '完全允许' }).click()
  const confirm = page.locator('.aprv-tier-pop')
  await expect(confirm).toBeVisible()
  await confirm.locator('[data-test="aprv-tier-always"]').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const poll = await request.get(`${BASE}/api/ops-confirm/${id}`, { headers })
  const { data } = await poll.json() as { data: { status: string } }
  expect(data.status).toBe('allowed')

  // 还原全局审批模式为 ask（始终允许已持久化改为 allow，防污染其他用例）
  await request.put(`${BASE}/api/settings`, { headers, data: { agentApprovalMode: 'ask' } })
  const after = await request.get(`${BASE}/api/settings`, { headers })
  const mode = ((await after.json()) as { data?: { agentApprovalMode?: string } }).data?.agentApprovalMode
  expect(mode).toBe('ask')
})
