import { test, expect } from '@playwright/test'
import net from 'node:net'
import { gotoAndUnlock, fixedLocale, DEFAULT_PASSWORD, fetchWslHost } from '../../tests/helpers'
import { TERMINAL_THEME_FOLLOW_KEY } from '../../src/stores/terminal-theme'

/**
 * 远程管理（项目页内嵌视图）E2E——回归：
 *   0. 入口：项目页 ActivityBar「远程管理」按钮切换主区视图，左侧工具栏保留；
 *      面板按钮（项目文件等）与远程主区互不影响（同一功能族切换）
 *   1. 渲染：标题 + 主机卡片（预配置 WSL）+ 在线徽章 + 无终端空态
 *   2. 实流（WSL sshd 可达时）：卡片快捷钮开终端 → xterm 渲染 → 命令回显 → 刷新恢复
 *   3. 会话管理：新建目录 + 主机移动 + 复制粘贴主机（duplicate）+ 常用命令发送执行
 *   4. palette「连接主机」命令跨页一步直连（P-20261005-218）：动态主机命令第三形态，
 *      跳远程视图 + 复用卡片点击语义（有终端聚焦最近、无则新开）
 * 环境敏感用例（实流）在 sshd 不可达时条件跳过，渲染/分组用例不受影响
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

// WSL sshd 端口可达性预检（端口取播种的主机记录，槽位专用实例非 23）
function tcpReachable(port: number, timeout = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port })
    const done = (ok: boolean) => { s.destroy(); resolve(ok) }
    s.setTimeout(timeout, () => done(false))
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

let wslUp = false
// 卡面地址断言与探针共用播种记录端口（槽位专用实例非 23，P-20261004-115）。
// 记录缺失（播种未跑，如跨拓扑金态无 WSL 域）= 环境边界 → 按门控 skip 而非
// 落到 :23 探测后让卡片断言失败（记录才是卡片/会话数据源，端口通也不可跑；
// P-20261005-187 收口）
let wslPort = 23
test.beforeAll(async () => {
  const wslHost = await fetchWslHost(BASE)
  wslPort = wslHost?.port || 23
  wslUp = !!wslHost && await tcpReachable(wslPort)
})

/** 清理远程管理持久化状态（服务端 uiState），保证用例从空态开始 */
async function clearRemoteConsoleState() {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  if (!unlockRes.ok) return
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const res = await fetch(BASE + '/api/ui-state', { headers })
  // 响应体是 { data: { <instanceId>: UIStateData } }——按实例遍历内层
  const body = (await res.json().catch(() => null)) as { data?: Record<string, { remoteConsole?: unknown }> } | null
  const map = body?.data
  if (map) {
    const clear: Record<string, { remoteConsole: null }> = {}
    for (const k of Object.keys(map)) {
      // PUT 是按命名空间浅合并：未携带的键原样保留，delete 无效；
      // 清空必须显式传 null（服务端约定，见 UpdateUIState 注释）
      if (map[k]?.remoteConsole !== undefined) clear[k] = { remoteConsole: null }
    }
    if (Object.keys(clear).length > 0) {
      await fetch(BASE + '/api/ui-state', { method: 'PUT', headers, body: JSON.stringify(clear) })
    }
  }
}

// 每个用例前清理（跨用例/跨文件的 remoteConsole 残留会让空态断言与 tab 序号漂移）
test.beforeEach(async () => {
  await clearRemoteConsoleState()
})

/** 清理会话管理用例产生的副本主机（用例失败中断时兜底） */
async function deleteDuplicateHosts() {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  if (!unlockRes.ok) return
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = await (await fetch(BASE + '/api/remotehosts', { headers })).json()
  for (const h of list?.data || []) {
    if (String(h.name).includes('副本')) {
      await fetch(`${BASE}/api/remotehosts/${h.id}`, { method: 'DELETE', headers })
    }
  }
}

test.afterEach(async () => {
  await deleteDuplicateHosts()
})

// 整个 spec 结束后清掉 remoteConsole 视图残留：实流用例会把这个状态写进服务端
// uiState，不清会让后续 spec 打开 /project 时恢复远程视图（遮住编辑器主区）
test.afterAll(async () => {
  await clearRemoteConsoleState()
})

/** 打开项目页并经 ActivityBar 进入远程管理内嵌视图 */
async function openRemoteView(page: Parameters<typeof gotoAndUnlock>[0]) {
  await gotoAndUnlock(page, BASE + '/project')
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  // 左侧工具栏仍然保留（内嵌视图而非独立页面）
  await expect(page.locator('.rail-btn[title="远程管理"]')).toBeVisible()
}

/** 直写 remoteConsole.groups：把主机移入目录（node 侧）。
 * 调用前提：页面已卸载（about:blank）且 beacon 落定——SPA 卸载路径的
 * beforeunload sendBeacon 会把内存里的旧分组原样写回，先写必被覆盖。
 * 不走 UI 拖拽/子菜单：HTML5 合成拖拽与 naive-ui 子菜单合成点击在本环境
 * 均不可用（真实鼠标正常，见台账 Run 109 观察项） */
async function moveHostToGroup(groupName: string, hostName: string) {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  const hosts = (await (await fetch(BASE + '/api/remotehosts', { headers })).json())?.data || []
  const hostId = hosts.find((h: { name?: string }) => h.name === hostName)?.id
  expect(hostId, '目标主机应存在').toBeTruthy()
  const uiBody = await (await fetch(BASE + '/api/ui-state', { headers })).json()
  const map = (uiBody?.data || {}) as Record<string, { remoteConsole?: { groups?: Array<{ id: string; name: string; hostIds: string[] }> } }>
  const patch: Record<string, { remoteConsole: { groups: Array<{ id: string; name: string; hostIds: string[] }> } }> = {}
  for (const [k, inst] of Object.entries(map)) {
    const groups = inst?.remoteConsole?.groups || []
    if (!groups.some(g => g.name === groupName)) continue
    patch[k] = {
      remoteConsole: {
        groups: groups.map(g => (g.name === groupName ? { ...g, hostIds: [...g.hostIds, hostId!] } : g)),
      },
    }
  }
  expect(Object.keys(patch).length, '应找到目标分组所在的实例').toBeGreaterThan(0)
  const put = await fetch(BASE + '/api/ui-state', { method: 'PUT', headers, body: JSON.stringify(patch) })
  expect(put.ok).toBeTruthy()
}

/** 读写全局设置（页面上下文 fetch，带解锁 token） */
async function putSetting(page: Parameters<typeof gotoAndUnlock>[0], body: Record<string, unknown>) {
  await page.evaluate(async (payload) => {
    await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' } /* 同源自动带 HttpOnly 锁 cookie（P-20261019-2） */,
      body: JSON.stringify(payload),
    })
  }, body)
}
async function getSetting(page: Parameters<typeof gotoAndUnlock>[0], key: string): Promise<unknown> {
  return page.evaluate(async (k) => {
    // 同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    const r = await fetch('/api/settings')
    return (await r.json())?.data?.[k]
  }, key)
}

test('首页远程管理 overlay：不进项目直接使用，按钮/Esc 均可退出', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.home-action-btn[title="远程管理"]').click()
  const overlay = page.locator('.remote-console-overlay')
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('.remote-title')).toHaveText('远程管理')
  // 主机卡片渲染：不进项目即可管理主机/开终端
  await expect(overlay.locator('.host-card').filter({ hasText: 'WSL' }).first()).toBeVisible({ timeout: 10000 })
  // 关闭按钮退出
  await overlay.getByRole('button', { name: '关闭' }).click()
  await expect(overlay).toBeHidden()
  // 重开 + Esc 退出（保活隐藏，重开秒显）
  await page.locator('.home-action-btn[title="远程管理"]').click()
  await expect(overlay).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
})

test('内嵌入口与渲染：ActivityBar 切换 / 主机卡片 / 在线徽章 / 空态', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  await fixedLocale(page)
  await openRemoteView(page)

  await expect(page.locator('.remote-title')).toHaveText('远程管理')
  const card = page.locator('.host-card').filter({ hasText: 'WSL' }).first()
  await expect(card).toBeVisible({ timeout: 10000 })
  await expect(card.locator('.host-card-addr')).toHaveText(new RegExp(`root@127\\.0\\.0\\.1:${wslPort}`))
  if (wslUp) {
    // 三态状态点语义：绿 is-online=SSH 认证连通；黄 is-auth-pending=TCP 可达
    // 但本进程内尚未完成过认证（服务重启后粘性位清零即转黄）——两者均为「在线」
    await expect(
      card.locator('.host-status.is-online, .host-status.is-auth-pending').first(),
    ).toBeVisible({ timeout: 10000 })
  }
  // 有主机无终端 → 空态引导
  await expect(page.locator('.remote-main-empty-text')).toBeVisible()

  // 终端主题全局生效：设置改主题 → 重载后 boot 从服务端设置加载 →
  // 远程管理视图与底部终端共用同一 document 级主题（body data-terminal-theme）。
  // P-20261002-144：跟随应用明暗默认开（浏览器本地偏好）会盖过服务端
  // terminalTheme——本段验证服务端持久化链路，先关跟随再 reload
  const originalTheme = await getSetting(page, 'terminalTheme')
  await putSetting(page, { terminalTheme: 'dracula' })
  await page.addInitScript(([key]) => {
    localStorage.setItem(key, 'off')
  }, [TERMINAL_THEME_FOLLOW_KEY])
  await page.reload()
  await gotoAndUnlock(page, page.url())
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('body[data-terminal-theme="dracula"]')).toBeVisible({ timeout: 5000 })
  await putSetting(page, { terminalTheme: typeof originalTheme === 'string' && originalTheme ? originalTheme : 'classic-dark' })

  // 切换体系：面板按钮与远程主区互不影响（同一功能族，点击「项目文件」远程不消失）
  await page.locator('.rail-btn[title="项目文件"]').click()
  await expect(page.locator('.remote-root')).toBeVisible()
  await page.locator('.rail-btn[title="项目文件"]').click()
  await expect(page.locator('.remote-root')).toBeVisible()

  // 再点一次 ActivityBar 按钮切回编辑器主区
  await page.locator('.rail-btn[title="远程管理"]').click()
  await expect(page.locator('.remote-root')).toBeHidden()
})

test('会话管理：目录分组 + 主机移动 + 复制粘贴', async ({ page }) => {
  test.skip(!wslUp, 'WSL 主机记录未播种或 sshd 不可达（跨拓扑金态无 WSL 域），跳过')
  await fixedLocale(page)
  await openRemoteView(page)
  const card = page.locator('.host-card').filter({ hasText: 'WSL' }).first()
  await expect(card).toBeVisible({ timeout: 10000 })

  // 新建目录
  await page.locator('.sidebar-actions button').filter({ hasText: '新建目录' }).click()
  await page.locator('.n-input input:visible').last().fill('生产环境')
  await page.locator('button:visible').filter({ hasText: '确认' }).last().click()
  const group = page.locator('.host-group').filter({ hasText: '生产环境' })
  await expect(group).toBeVisible({ timeout: 5000 })

  // 主机移动到目录：卸载页面（beacon 落定）→ uiState 直写归属 → 重进读回。
  // 不走拖拽/子菜单点击（本环境合成事件不可用，见 moveHostToGroup 注）
  await page.goto('about:blank')
  await page.waitForTimeout(400)
  await moveHostToGroup('生产环境', 'WSL')
  await openRemoteView(page)
  await expect(group.locator('.host-card').filter({ hasText: 'WSL' })).toBeVisible({ timeout: 10000 })
  // 根级不再有该卡片
  await expect(page.locator('.host-root .host-card')).toHaveCount(0, { timeout: 5000 })

  // 复制主机 → 目录菜单粘贴 → 副本出现在同目录
  await group.locator('.host-card').first().locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '复制主机' }).first().click()
  await group.locator('.group-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '粘贴主机副本' }).first().click()
  await expect(group.locator('.host-card').filter({ hasText: '副本' })).toBeVisible({ timeout: 10000 })
  // 删除目录与副本主机清理由 afterEach / 下一用例的 beforeEach 完成
})

test('页内主机管理：添加主机（弹窗）→ 卡片出现 → 菜单删除', async ({ page }) => {
  await fixedLocale(page)
  await openRemoteView(page)

  // 头部「添加主机」→ 页内弹窗（不再跳设置面板）
  await page.locator('.remote-header button').filter({ hasText: '添加主机' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: '新增远程主机' })
  await expect(modal).toBeVisible({ timeout: 5000 })

  // 填表保存（仅 CRUD，不发起连接；名称用 e2e 专属便于清理）
  const name = 'e2e-console-host'
  const fieldInput = (label: string) =>
    modal.locator('.n-form-item').filter({
      has: page.locator('.n-form-item-label', { hasText: label }),
    }).locator('input')
  // naive-ui 内置 placeholder 跟随应用 locale：中文环境下名称空输入框显示「请输入」而非「Please Input」
  await expect(fieldInput('名称')).toHaveAttribute('placeholder', '请输入')
  await fieldInput('名称').fill(name)
  await fieldInput('主机').fill('203.0.113.99')
  await fieldInput('登录用户').fill('root')
  await modal.locator('button').filter({ hasText: '保存' }).click()
  await expect(modal).toBeHidden({ timeout: 10000 })
  await expect(page.locator('.host-card').filter({ hasText: name })).toBeVisible({ timeout: 10000 })

  // 卡片菜单删除（确认弹窗「确认」= common.confirm）
  const card = page.locator('.host-card').filter({ hasText: name }).first()
  await card.locator('.host-card-more').click()
  await page.locator('.n-dropdown-option').filter({ hasText: '删除' }).first().click()
  await page.locator('.n-modal button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.host-card').filter({ hasText: name })).toHaveCount(0, { timeout: 10000 })
})

test('palette「连接主机」命令跨页一步直连（P-20261005-218）', async ({ page }) => {
  test.skip(!wslUp, 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  // 关 tab 免确认：用例结束清场，防残留 tab 影响后续运行（恢复出 WSL · 2 之类）
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  // 跨页直达语义：从项目页编辑器上下文出发，不经 ActivityBar 远程按钮——
  // palette 过滤「连接：」形态命令（动态主机命令第三形态）点击执行
  await gotoAndUnlock(page, BASE + '/project')
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>连接：WSL')
  const item = page.locator('.palette-item').filter({ hasText: '连接：WSL' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 远程视图直达（ensure-open）+ 自动连主机（复用预选主机语义：无已开终端 → 新开）
  await expect(page.locator('.remote-root')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.remote-tab').filter({ hasText: 'WSL · 1' })).toBeVisible({ timeout: 20000 })

  // 二次执行聚焦最近终端（防重复开会话）：tab 数不增、不产生 WSL · 2
  await page.keyboard.press('Control+k')
  await input.fill('>连接：WSL')
  await page.locator('.palette-item').filter({ hasText: '连接：WSL' }).first().click()
  await expect(page.locator('.remote-tab')).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator('.remote-tab').filter({ hasText: 'WSL · 1' })).toBeVisible()

  // 清场：关掉打开的 tab（免确认已设置）
  while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
    await page.locator('.remote-tab .remote-tab-close').first().click()
    await page.waitForTimeout(400)
  }
})

test('远程管理实流：开终端 → 回显 → 刷新恢复 → 常用命令发送执行 → 关 tab', async ({ page }) => {
  test.skip(!wslUp, 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(180000)
  await fixedLocale(page)
  // 关 tab 免确认（init script 对同页后续 reload 同样生效）
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await openRemoteView(page)

  // 开终端走卡片 hover 快捷钮（P-20261030-3 卡片点击改开编辑弹窗，按卡片名精确
  // 匹配原始 WSL，避免命中复制产生的「WSL 副本」）
  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()

  // 远程 tmux 持久化：开启开关后再开终端，终端应运行在远端 tmux 会话内（TMUX 变量非空）；
  // finally 还原开关（全局设置，避免污染其他用例）
  const originalTmux = await getSetting(page, 'terminalRemoteTmux')
  await putSetting(page, { terminalRemoteTmux: true })
  const xterm = page.locator('.remote-pane-wrap:visible .xterm').first()
  try {
    await wslCard.locator('.host-card-term').click()
    await expect(xterm).toBeVisible({ timeout: 20000 })
    // 45s：WSL 刚启动后第一次 PTY 建连 + 远端 tmux 会话创建可能超过 20s（冷启动），
    // 链路热身后稳定在数秒内
    await expect(xterm).toContainText('#', { timeout: 45000 })
    await xterm.click()
    await page.keyboard.type('echo T:${TMUX:+IN_TMUX}\r')
    await expect(xterm).toContainText('T:IN_TMUX', { timeout: 10000 })
    await xterm.click()
    await page.keyboard.press('Control+c')
    await page.waitForTimeout(300)
  } finally {
    await putSetting(page, { terminalRemoteTmux: !!originalTmux })
  }

  // tab 标题 = 主机名 · 序号
  await expect(page.locator('.remote-tab').first()).toContainText('WSL · 1')

  // 常用命令直接发送执行：片段面板点击「claude」→ 终端立即回显执行（command not found 也是执行证据）
  await page.locator('.remote-header button').filter({ hasText: '命令片段' }).click()
  const snippetPanel = page.locator('.snippet-panel')
  await expect(snippetPanel).toBeVisible()
  // 用命令行内容严格区分两个「启动 agent」片段（tmux 片段的描述里也含 claude 字样）
  await snippetPanel.locator('.snippet-item').filter({
    has: page.locator('.snippet-item-cmd', { hasText: 'claude' }),
  }).first().click()
  await expect(xterm).toContainText('claude', { timeout: 10000 })
  // 清掉执行残留（若是交互进程按 Ctrl+C）
  await xterm.click()
  await page.keyboard.press('Control+c')
  await page.waitForTimeout(300)

  // 刷新 → tab 恢复（重连 + scrollback 回放仍能看到刚才的输出）
  await page.reload()
  await gotoAndUnlock(page, page.url())
  const restored = page.locator('.remote-tab').filter({ hasText: 'WSL · 1' })
  await expect(restored).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.remote-pane-wrap:visible .xterm').first()).toContainText('claude', { timeout: 20000 })

  // tab 拖拽重排序：再开一个终端 → 把「WSL · 2」拖到最前（开终端走 hover 快捷钮）
  await wslCard.locator('.host-card-term').click()
  const tab2 = page.locator('.remote-tab').filter({ hasText: 'WSL · 2' })
  await expect(tab2).toBeVisible({ timeout: 20000 })
  await tab2.dragTo(page.locator('.remote-tab').first())
  await expect(page.locator('.remote-tab').first()).toContainText('WSL · 2', { timeout: 5000 })
  await expect(page.locator('.remote-tab').nth(1)).toContainText('WSL · 1')

  // 清理：关 tab（closeNoConfirm 已由 init script 设置，reload 后仍生效）
  while (await page.locator('.remote-tab .remote-tab-close').count() > 0) {
    await page.locator('.remote-tab .remote-tab-close').first().click()
    await page.waitForTimeout(400)
  }
})

test('断线重连：强断 WS → 「立即重连」浮层 → 点击恢复会话', async ({ page, request }) => {
  test.skip(!wslUp, 'WSL sshd 不可达，跳过实流用例')
  test.setTimeout(120000)
  await fixedLocale(page)
  // 关 tab 免确认（清理步骤直关，不弹确认框）
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  // 重置持久化 UI 状态（页面启动前经 API 请求上下文——若在页面内 reset，
  // reload 的 beforeunload forceSave 会把旧内存状态立刻写回，重置被覆盖）：
  // 前序用例/本用例重试遗留的 remoteConsole tabs 经恢复流程开额外窗格，
  // 输入聚焦窗格与断言读取的首个窗格可能不一致
  {
    const res = await request.post(`${BASE}/api/lock/unlock`, {
      data: { password: DEFAULT_PASSWORD },
    })
    const token = ((await res.json()) as { token?: string }).token || ''
    await request.put(`${BASE}/api/ui-state`, {
      headers: { 'X-Lock-Token': token },
      data: { local: { instanceId: 'local' } },
    })
  }
  // 测试侧插桩（仅本页生效）：包装 WebSocket 构造器登记实例，便于强断活动连接模拟网络故障
  await page.addInitScript(() => {
    const sockets = []
    window.__scSockets = sockets
    const Orig = window.WebSocket
    window.WebSocket = class extends Orig {
      constructor(...args) {
        super(...args)
        sockets.push(this)
      }
    }
  })
  await openRemoteView(page)

  const wslCard = page.locator('.host-card').filter({
    has: page.locator('.host-card-name', { hasText: /^WSL$/ }),
  }).first()
  // 开终端走卡片 hover 快捷钮（P-20261030-3 卡片点击改开编辑弹窗）
  await wslCard.locator('.host-card-term').click()
  const xterm = page.locator('.remote-pane-wrap:visible .xterm').first()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('#', { timeout: 20000 })

  // 强断活动终端 WS（客户端 close 与网络断开同样触发 onclose）→ 自动重连退避期 → 浮层出现
  await page.evaluate(() => {
    const sockets = window.__scSockets
    const live = sockets.filter((w) => w.readyState === 1)
    if (live.length === 0) throw new Error('no open ws to close')
    live[live.length - 1].close()
  })
  const overlay = page.locator('.remote-pane-wrap:visible .term-pane-error').first()
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('button')).toHaveText('立即重连')

  // 点击「立即重连」→ 新 WS 建立 → 浮层消失，终端可继续输入（会话仍存活）
  await overlay.locator('button').click()
  await expect(page.locator('.remote-pane-wrap:visible .term-pane-error')).toHaveCount(0, { timeout: 15000 })
  // 等重连后的新 WS 真正 OPEN 再输入：disconnected 状态切换会重建窗格，
  // 过早 focus 会落在被替换的旧 textarea 上，击键全部丢失
  await expect.poll(() => page.evaluate(() => {
    const ws = (window.__scSockets || []).filter((w) => w.url.includes('remote-terminal'))
    return ws.length ? ws[ws.length - 1].readyState : -1
  }), { timeout: 15000 }).toBe(1)
  // 重连后 xterm 重新挂载：直接聚焦 helper textarea（点击容器在初始化完成前
  // 可能不产生焦点，键盘输入会丢失到 body）
  const ta = page.locator('.remote-pane-wrap:visible textarea.xterm-helper-textarea').first()
  await expect(ta).toBeVisible({ timeout: 10000 })
  await ta.focus()
  await expect(ta).toBeFocused()
  await page.keyboard.type('echo RC:$((20+2))\r')
  await expect(xterm).toContainText('RC:22', { timeout: 10000 })

  // 清理：关 tab
  await page.locator('.remote-tab.is-active .remote-tab-close').click()
  await expect(page.locator('.remote-tab')).toHaveCount(0, { timeout: 5000 })
})
