import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'

/**
 * 智能体运行时不可用安装引导 E2E（P-20261003-296）：
 *   1. mock /api/agent-runtimes 全部不可用 → 新建会话对话框出顶部提示卡
 *      （未检测到任何智能体运行时 + 安装指引链接）；缺失项灰化禁选
 *      （P-20261004-85 可用态注入——死路选择前置归零）；
 *   2. 指引链接经 sc-open-help 打开帮助中心并锚定「如何安装/配置智能体运行时」
 *      FAQ（条目展开 + 安装命令可见——真实 /api/help，前后端契约端到端走通）；
 *   3. 混合可用性（部分可用）→ 无提示卡；有预检豁免（自定义命令覆盖）的
 *      不可用项仍可选，选中出说明行 + 指引链接（P-20261004-85：无豁免缺失项
 *      禁选，说明行只在这类豁免项上可达）；可用项不出说明行；
 *   4. 「纯终端」仍可选且能创建（shell 一等出路，死胡同变有出路）。
 * 对话框级 UI mock（page.route），创建走真实服务端；afterEach 清理会话防残留
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

interface RtItem {
  name: string
  displayName?: string
  available: boolean
  version?: string
  defaultCommand: string
  customCommand: string
}

function rt(partial: Pick<RtItem, 'name' | 'available' | 'defaultCommand'> & Partial<RtItem>): RtItem {
  return { version: '', displayName: '', customCommand: '', ...partial }
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话污染 .ats-item 计数） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

/** 进项目页，打开终端会话管理页与新建会话对话框（路由 mock 由调用方先行安装） */
async function openDialogOnProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  const view = page.locator('.atv-root')
  // 活动栏入口（agent-terminal.spec 同款语义定位）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  return dlg
}

/** mock 运行时清单后进项目页，打开终端会话管理页与新建会话对话框 */
async function openDialog(page: Page, items: RtItem[]) {
  await page.route('**/api/agent-runtimes*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: items }),
  }))
  return openDialogOnProject(page)
}

/** 从运行时下拉选中指定项（P-20261002-16 起对话框有两枚 .n-base-selection，
 *  按表单行语义定位运行时下拉——agent-terminal.spec:90 先例） */
async function pickRuntime(page: Page, dlg: ReturnType<Page['locator']>, optionText: string) {
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: optionText }).click()
}

test('全部不可用：提示卡 + 指引链接锚定帮助中心 FAQ + 缺失项禁选 + 纯终端仍可创建', async ({ page }) => {
  const allUnavailable = (['claude', 'codex', 'dsh'] as const).map(name =>
    rt({ name, available: false, defaultCommand: name }))
  const dlg = await openDialog(page, allUnavailable)

  // 顶部提示卡：标题 + shell 出路 + 指引链接
  const guide = dlg.locator('[data-testid="agent-runtime-guide"]')
  await expect(guide).toBeVisible({ timeout: 5000 })
  await expect(guide).toContainText('未检测到任何智能体运行时')
  await expect(guide).toContainText('纯终端')
  const guideLink = guide.locator('[data-testid="agent-runtime-guide-link"]')
  await expect(guideLink).toBeVisible()

  // 指引链接 → 帮助中心抽屉锚定 FAQ 条目（展开 + 安装命令可见）
  await guideLink.click()
  const drawer = page.locator('.n-drawer').filter({ hasText: '帮助中心' })
  await expect(drawer).toBeVisible({ timeout: 5000 })
  const faq = drawer.locator('[data-help-entry="agent-runtime-install"]')
  await expect(faq).toBeVisible({ timeout: 5000 })
  await expect(faq).toContainText('如何安装/配置智能体运行时')
  await expect(faq.locator('..').locator('.help-a')).toBeVisible()
  await expect(faq.locator('..').locator('.help-a')).toContainText('npm install -g @anthropic-ai/claude-code')
  await drawer.locator('.n-base-close').click()
  await expect(drawer).toBeHidden({ timeout: 5000 })

  // P-20261004-85：缺失项（裸名命令、无覆盖）灰化禁选——死路选择前置归零。
  // 原行为「选中不可用项出说明行」随禁选退位（说明行只在豁免可选的缺失项
  // 上可达，混合用例覆盖）；tooltip 同源文案由 agent-runtime-badge.spec 断言
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  const claudeOpt = page.locator('.n-base-select-option').filter({ hasText: 'claude' })
  await expect(claudeOpt).toBeVisible({ timeout: 5000 })
  await expect(claudeOpt).toHaveClass(/-disabled/)
  await claudeOpt.click() // 禁选项点击无效果：选择保持 auto、菜单不关
  await expect(dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection'))
    .toContainText('自动（按可用性）')

  // 纯终端仍可选可创建（shell 一等出路）：禁选点击后菜单仍开着，直选纯终端
  //（勿走 pickRuntime——它先点选择框，会把开着的菜单关掉）
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  await expect(dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection'))
    .toContainText('纯终端')
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 10000 })
  await expect(page.locator('.atv-root').locator('.ats-item')).toHaveCount(1, { timeout: 10000 })
})

test('混合可用性：无提示卡；豁免缺失项可选出说明行，无豁免缺失项禁选', async ({ page }) => {
  const mixed = [
    rt({ name: 'claude', available: true, version: '1.2.3', defaultCommand: 'claude' }),
    // codex 有 per-runtime 自定义命令覆盖（预检豁免：原样启动承诺）→ 仍可选
    rt({ name: 'codex', available: false, defaultCommand: 'codex', customCommand: '/opt/e2e-wrap.sh' }),
    // dsh 裸名缺失无覆盖（显式选择必被预检 400）→ 禁选（P-20261004-85）
    rt({ name: 'dsh', available: false, defaultCommand: 'dsh' }),
  ]
  const dlg = await openDialog(page, mixed)

  // 至少一个可用 → 不出「全部不可用」提示卡
  await expect(dlg.locator('[data-testid="agent-runtime-guide"]')).toHaveCount(0)

  // 打开运行时下拉：豁免项可选、无豁免缺失项禁选
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await expect(page.locator('.n-base-select-option').filter({ hasText: 'dsh' })).toHaveClass(/-disabled/, { timeout: 5000 })
  const codexOpt = page.locator('.n-base-select-option').filter({ hasText: 'codex' })
  await expect(codexOpt).not.toHaveClass(/-disabled/)
  await codexOpt.click()

  // 选中豁免的不可用项：说明行带该项展示名与指引链接（禁选项不可达此行——
  // tooltip 承载其说明，agent-runtime-badge.spec 断言）
  const note = dlg.locator('[data-testid="agent-runtime-note"]')
  await expect(note).toBeVisible()
  await expect(note).toContainText('codex')
  await expect(note).toContainText('未检测到')
  await expect(note.locator('[data-testid="agent-runtime-note-link"]')).toBeVisible()

  // 选中可用项：无检测说明
  await pickRuntime(page, dlg, 'claude')
  await expect(note).toHaveCount(0)
})

// ============== 重新检测（P-20261005-167）：安装引导闭环最后一钮 ==============

const ALL_UNAVAILABLE = (['claude', 'codex', 'dsh'] as const).map(name =>
  rt({ name, available: false, defaultCommand: name }))

test('重新检测：loading 态 + 仍全不可用卡片文案保持 + 强制 refresh=1', async ({ page }) => {
  // 打开对话框的首轮 ensure 也带 refresh=1（lastRuntimeRefreshAt 初值 0 触发
  // 节流窗刷新）——强制探测按次计数，点击前后差值才归属按钮
  let forcedProbes = 0
  await page.route('**/api/agent-runtimes*', async (route) => {
    if (new URL(route.request().url()).searchParams.get('refresh') === '1') {
      forcedProbes++
      // 延迟应答让 loading 态可观察（本地 mock 即时应答时翻牌一闪而过）
      await new Promise(resolve => setTimeout(resolve, 400))
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data: ALL_UNAVAILABLE }),
    })
  })
  const dlg = await openDialogOnProject(page)
  const guide = dlg.locator('[data-testid="agent-runtime-guide"]')
  await expect(guide).toBeVisible({ timeout: 5000 })
  const redetect = guide.locator('[data-testid="agent-runtime-guide-redetect"]')
  await expect(redetect).toBeVisible()
  // 卡片可见 ⇒ 首轮 ensure 已完成，此后计数增量全归按钮点击
  const forcedBefore = forcedProbes

  // 点重探：在途 loading 文案翻牌 + 禁点（防重复起探测子进程）
  await redetect.click()
  await expect(redetect).toHaveText('检测中…')
  await expect(redetect).toBeDisabled()
  // 探测返回仍全不可用：loading 复位，卡片文案保持（不播报失败性结论）
  await expect(redetect).toHaveText('重新检测', { timeout: 5000 })
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('未检测到任何智能体运行时')
  await expect(page.locator('.n-message')).toHaveCount(0)
  // 按钮语义成立的关键：绕开 60s 节流强制重探（refresh=1 必带，否则吃缓存旧结论）
  expect(forcedProbes).toBe(forcedBefore + 1)
})

test('模拟安装后重检：卡消失 + 轻 toast + 运行时可选', async ({ page }) => {
  // 调用计数区分首轮（返回全不可用出卡）与按钮重探（返回装好清单）——
  // 按钮必须走强制重探通道，装完的运行时才可见
  let probeCalls = 0
  const installed: RtItem[] = [
    rt({ name: 'claude', available: true, version: '1.2.3', defaultCommand: 'claude' }),
    rt({ name: 'codex', available: false, defaultCommand: 'codex' }),
    rt({ name: 'dsh', available: false, defaultCommand: 'dsh' }),
  ]
  await page.route('**/api/agent-runtimes*', (route) => {
    probeCalls++
    const body = probeCalls > 1 ? installed : ALL_UNAVAILABLE
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) })
  })
  const dlg = await openDialogOnProject(page)
  const guide = dlg.locator('[data-testid="agent-runtime-guide"]')
  await expect(guide).toBeVisible({ timeout: 5000 })

  await guide.locator('[data-testid="agent-runtime-guide-redetect"]').click()
  // 部分可用 → 提示卡响应式自消 + 轻 toast 确认改善
  await expect(guide).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.n-message').filter({ hasText: '已检测到可用运行时' })).toBeVisible({ timeout: 5000 })
  // 下拉可选：装好的 claude 不再禁选（死路变通路）
  await pickRuntime(page, dlg, 'claude')
  await expect(dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection'))
    .toContainText('claude')
})

test('单项说明行重探：豁免缺失项装好后说明行自消', async ({ page }) => {
  // 初始混合清单：claude 可用（无卡）、codex 缺失但有自定义命令覆盖（豁免可选
  // → 选中出说明行）、dsh 缺失无豁免（禁选）；按钮重探返回 codex 已装好
  let probeCalls = 0
  const mixed: RtItem[] = [
    rt({ name: 'claude', available: true, version: '1.2.3', defaultCommand: 'claude' }),
    rt({ name: 'codex', available: false, defaultCommand: 'codex', customCommand: '/opt/e2e-wrap.sh' }),
    rt({ name: 'dsh', available: false, defaultCommand: 'dsh' }),
  ]
  await page.route('**/api/agent-runtimes*', (route) => {
    probeCalls++
    const body = probeCalls > 1
      ? mixed.map(r => (r.name === 'codex' ? { ...r, available: true, version: '0.4.0' } : r))
      : mixed
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: body }) })
  })
  const dlg = await openDialogOnProject(page)
  await expect(dlg.locator('[data-testid="agent-runtime-guide"]')).toHaveCount(0, { timeout: 5000 })

  // 选中豁免的不可用项：说明行 + 同款重探入口
  await pickRuntime(page, dlg, 'codex')
  const note = dlg.locator('[data-testid="agent-runtime-note"]')
  await expect(note).toBeVisible()
  const noteRedetect = note.locator('[data-testid="agent-runtime-note-redetect"]')
  await expect(noteRedetect).toBeVisible()

  // 说明行重探：codex 已装 → 清单刷新覆盖说明行（响应式自消）+ 轻 toast
  await noteRedetect.click()
  await expect(note).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.n-message').filter({ hasText: '已检测到可用运行时' })).toBeVisible({ timeout: 5000 })
})
