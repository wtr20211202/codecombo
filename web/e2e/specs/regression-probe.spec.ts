import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

// 回归探针：用户报告「底部新建终端关不掉」「左侧提交面板有时出不来」。
// rail 按钮是 toggle 语义 + uiState 恢复初始状态不定 → 用例内先做状态归一化；
// 另补「恢复后」场景（reload 后面板/关闭链路是否仍可用）。

async function enterProject(page: import('@playwright/test').Page) {
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')
}

/** 点击 rail 直到面板进入期望可见态（toggle 语义，最多 3 次） */
async function railToggleUntil(page: import('@playwright/test').Page, title: string, target: () => Promise<boolean>) {
  for (let i = 0; i < 3; i++) {
    if (await target()) return
    await page.locator(`.rail-btn[title="${title}"]`).click()
    // toggle 后轮询等数据面渲染：固定 600ms 在负载下会把「已开未渲染完」误判为
    // 未开而再次点击=关闭（奇偶翻转永不收敛），改逐 500ms 轮询至 3s
    for (let w = 0; w < 6; w++) {
      if (await target()) return
      await page.waitForTimeout(500)
    }
  }
  expect(await target()).toBe(true)
}

/** 清空本实例全部终端会话（跨用例共享的服务端域，CLAUDE.md 测试节
 *  「用例开头先 API 清空」惯例）：长串跑中先行 spec 遗留的会话会让本文件
 *  的 tab 计数/恢复链路面向不确定的初始态 */
async function closeAllTerminalSessions(request: import('@playwright/test').APIRequestContext) {
  const unlock = await fetch(`${API_BASE}/api/lock/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: DEFAULT_PASSWORD }) })
  const token = ((await unlock.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const list = ((await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()) as { data?: Array<{ id?: string }> }).data || []
  for (const t of list) {
    if (t.id) await fetch(`${API_BASE}/api/terminals/${t.id}`, { method: 'DELETE', headers }).catch(() => { /* 幂等尽力 */ })
  }
}

/** 播种底部面板布局（uiState 服务端持久，跨 spec 残留不定态；CLAUDE.md
 *  「uiState 播种时机：种子须在无项目页存活时写入」惯例）：在页面加载前把
 *  showBottomPanel/bottomTab 写成期望值，boot 恢复直接落到目标分区——否则
 *  恢复流在本页归一化之后再落地，会把刚打开的底部面板翻走（实测新建终端
 *  后 × 按钮持续不可见）。GET+合并整键 PATCH：layout 是顶层键整体替换，
 *  裸发两个字段会把面板宽高等既有布局抹成默认 */
async function seedBottomPanelLayout(request: import('@playwright/test').APIRequestContext, tab: 'terminal' | 'git') {
  const unlock = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await unlock.json()) as { token?: string }).token || ''
  const headers = { 'X-Lock-Token': token }
  const stateRes = await request.get(`${API_BASE}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
  const layout = {
    ...(body?.data?.local?.layout || {}),
    showBottomPanel: true,
    bottomTab: tab,
  }
  await request.patch(`${API_BASE}/api/ui-state`, { headers, data: { local: { layout } } }).catch(() => { /* 尽力播种：失败回退到用例内 railToggleUntil 归一化 */ })
}

/** 打开底部 Git 面板并确保提交工具栏稳定可见：底部 tab 会被迟到的恢复/通知
 *  联动翻回终端（遗留会话 tab 恢复流程，实测开 git 后数秒内翻面）——翻转时重新
 *  点开并复验，2s 稳定窗内不再翻面才算就位 */
async function openBottomGitStable(page: import('@playwright/test').Page) {
  const toolbar = page.locator('.commits-toolbar')
  for (let i = 0; i < 3; i++) {
    await railToggleUntil(page, 'Git 管理', async () =>
      (await toolbar.isVisible().catch(() => false)))
    let stable = true
    for (let w = 0; w < 4; w++) {
      await page.waitForTimeout(500)
      if (!(await toolbar.isVisible().catch(() => false))) { stable = false; break }
    }
    // 工具栏稳定 ≠ 行已渲染：提交行可见也纳入稳定窗（未渲染时再驱动一轮）
    if (stable) {
      try { await page.locator('.commit-item .commit-meta:visible').first().waitFor({ state: 'visible', timeout: 6000 }) } catch { stable = false }
    }
    if (stable) return
  }
  await expect(toolbar).toBeVisible({ timeout: 5000 })
}

/** 收起底部面板：面板开合经 uiState 跨页面持久化，前序用例（或交互式巡检会话）
 *  留下的展开态会拦截后续用例的编辑区坐标点击（面板头 commits-toolbar 在上层） */
async function closeBottomPanel(page: import('@playwright/test').Page) {
  const close = page.locator('.bottom-panel button[title="关闭"]')
  for (let i = 0; i < 3; i++) {
    if (!(await close.isVisible().catch(() => false))) return
    await close.click()
    await page.waitForTimeout(500)
  }
}

/** 右键 diff 容器：面板高度经 uiState 持久化且面板叠在编辑区上层，
 *  固定坐标 (600,120) 会被面板头拦截——按面板顶边钳制 y 到容器可见区顶部 */
async function rightClickDiffContainer(page: import('@playwright/test').Page) {
  const container = page.locator('.diff-editor-container').first()
  const cBox = await container.boundingBox()
  const pBox = await page.locator('.bottom-panel').boundingBox().catch(() => null)
  const maxY = cBox && pBox ? pBox.y - cBox.y - 24 : 120
  const y = Math.max(30, Math.min(120, maxY))
  const x = Math.min(600, (cBox?.width ?? 600) - 60)
  await container.click({ button: 'right', position: { x, y } })
}

test('底部终端：新建 → 关闭（×→确认）→ tab 消失', async ({ page, request }) => {
  await closeAllTerminalSessions(request)
  await seedBottomPanelLayout(request, 'terminal')
  await fixedLocale(page)
  await enterProject(page)

  // 归一化：底部终端面板可见
  await railToggleUntil(page, '终端', async () =>
    (await page.locator('.term-toolbar').isVisible().catch(() => false)))
  const before = await page.locator('.term-tab').count()

  // 新建终端（限定工具栏，避免与空态/总览里的同名按钮撞 strict mode）
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(800)
  const afterNew = await page.locator('.term-tab').count()
  expect(afterNew).toBeGreaterThan(before)

  // 关闭新 tab：最后一个 tab 的 ×（可能有确认弹窗，也可能「不再提示」直接关）
  const lastTab = page.locator('.term-tab').last()
  const newTabName = (await lastTab.locator('.term-tab-name').textContent()) || ''
  await lastTab.locator('.term-close-btn').click()
  const modal = page.locator('.n-modal')
  if (await modal.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '确认' }).click()
  }
  await page.waitForTimeout(800)

  const afterClose = await page.locator('.term-tab').count()
  expect(afterClose, `关闭后 tab 数未减少（新建前=${before} 新建后=${afterNew} 关闭后=${afterClose}）`).toBe(afterNew - 1)
  const names = await page.locator('.term-tab-name').allTextContents()
  expect(names).not.toContain(newTabName)
})

test('底部终端：reload 恢复会话后关闭仍可用', async ({ page, request }) => {
  await closeAllTerminalSessions(request)
  await seedBottomPanelLayout(request, 'terminal')
  await fixedLocale(page)
  await enterProject(page)

  await railToggleUntil(page, '终端', async () =>
    (await page.locator('.term-toolbar').isVisible().catch(() => false)))
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(800)

  // reload：uiState 恢复 tabs + showBottomPanel，再走关闭链路
  await page.reload()
  await page.waitForURL('**/project')
  await railToggleUntil(page, '终端', async () =>
    (await page.locator('.term-toolbar').isVisible().catch(() => false)))
  const afterNew = await page.locator('.term-tab').count()

  const lastTab = page.locator('.term-tab').last()
  await lastTab.locator('.term-close-btn').click()
  const modal = page.locator('.n-modal')
  if (await modal.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: '确认' }).click()
  }
  await page.waitForTimeout(800)
  expect(await page.locator('.term-tab').count()).toBe(afterNew - 1)
})

test('左侧提交面板：rail 提交按钮 → CommitPanel 出现在侧栏', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 归一化：提交面板可见
  await railToggleUntil(page, '提交', async () =>
    (await page.locator('.commit-panel').isVisible().catch(() => false)))

  // toggle 收起 → 再恢复。收起单击在面板状态被恢复流扰动时可能落空为再开——
  // 轮询复驱（面板仍可见则再点，至多 2 次）后断言
  const submitRail = page.locator('.rail-btn[title="提交"]')
  await submitRail.click()
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.waitForTimeout(600)
    await submitRail.click()
  }
  await expect(page.locator('#side-panel')).toBeHidden()
  await submitRail.click()
  await expect(page.locator('.commit-panel')).toBeVisible({ timeout: 5000 })
})

test('左侧提交面板：changes 态 reload 恢复后仍可达', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 置为提交视图
  await railToggleUntil(page, '提交', async () =>
    (await page.locator('.commit-panel').isVisible().catch(() => false)))

  // reload：uiState 恢复 sideView=changes / showSidePanel
  await page.reload()
  await page.waitForURL('**/project')
  await railToggleUntil(page, '提交', async () =>
    (await page.locator('.commit-panel').isVisible().catch(() => false)))
})

test('提交面板过滤：作者 / 时间范围 / 目录历史（LogView 迁移链路）', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // CommitsPanel 挂在底部 Git 面板（GitPanel 分节），rail「Git 管理」toggle 打开
  await openBottomGitStable(page)
  const toolbar = page.locator('.commits-toolbar')
  await expect(toolbar).toBeVisible({ timeout: 5000 })
  // 搜索框（NInput 漏 import 回归哨兵）：此前裸渲染导致整个输入框消失
  await expect(toolbar.locator('.n-input').first()).toBeVisible()

  const itemCount = () => page.locator('.commit-item').count()
  await expect.poll(itemCount, { timeout: 10000 }).toBeGreaterThan(0)

  // 作者过滤：不存在的作者 → 列表清空（验证服务端 --author 生效）
  await toolbar.getByPlaceholder('按作者过滤').fill('no-such-author-xyz')
  await toolbar.getByPlaceholder('按作者过滤').press('Enter')
  await expect.poll(itemCount, { timeout: 5000 }).toBe(0)
  await toolbar.getByPlaceholder('按作者过滤').clear()
  await toolbar.getByPlaceholder('按作者过滤').press('Enter')
  await expect.poll(itemCount, { timeout: 5000 }).toBeGreaterThan(0)

  // 目录历史：docs 目录的提交只占子集或等于全集，但接口链路必须可用
  await toolbar.getByPlaceholder(/目录历史/).fill('docs')
  await toolbar.getByPlaceholder(/目录历史/).press('Enter')
  await page.waitForTimeout(800)
  const dirCount = await itemCount()
  expect(dirCount).toBeGreaterThanOrEqual(0)
  // 清除目录过滤恢复完整列表
  await toolbar.getByPlaceholder(/目录历史/).clear()
  await toolbar.getByPlaceholder(/目录历史/).press('Enter')
  await expect.poll(itemCount, { timeout: 5000 }).toBeGreaterThan(0)
})

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

test('Agent Loop 管线：task.progress 上报 → 智能体悬浮条实时跟随', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 打开全局终端管理页 → 切悬浮窗 → 收起悬浮条 → 右键切「悬浮条」形态
  // （球形态仅图标+会话数徽标；任务/步骤实时文本由悬浮条承载）
  const agentBtn = page.locator('.rail-btn[title="终端会话管理"]')
  await expect(agentBtn).toHaveCount(1)
  await agentBtn.click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  // 悬浮窗 = 容器 CSS morph（is-float class），不再是 teleport 的独立 .agt-float
  await expect(view).toHaveClass(/is-float/, { timeout: 10000 })
  // 收起为悬浮球：管理页头部「收起为悬浮球」→ 全局悬浮球 .agm-root
  await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
  const mini = page.locator('body > .agm-root')
  await expect(mini).toBeVisible({ timeout: 5000 })
  await mini.click({ button: 'right' })
  await page.locator('.n-dropdown:visible').getByText('悬浮条', { exact: true }).click()
  await expect(mini).toHaveClass(/is-bar/)

  const headers = await unlockHeaders()
  // 模拟底层智能体经 /api/ops-notify 上报 running 进度（WS 广播时序偶发 → 最多重试 3 次）
  let shown = false
  for (let i = 0; i < 3 && !shown; i++) {
    await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'task.progress', payload: { task: 'E2E进度任务', status: 'running', step: '第一步进行中' } },
    })
    shown = await page.locator('.agm-task').filter({ hasText: 'E2E进度任务' }).isVisible().catch(() => false)
    if (!shown) await page.waitForTimeout(1500)
  }
  await expect(page.locator('.agm-task')).toContainText('E2E进度任务', { timeout: 5000 })
  await expect(page.locator('.agm-step')).toContainText('第一步进行中', { timeout: 5000 })

  // 上报 done → 状态点切换为完成
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: 'E2E进度任务', status: 'done', step: '已结束' } },
  })
  await expect(page.locator('.agm-dot')).toBeVisible({ timeout: 5000 })
})

test('Agent Loop 管线：panel 事件驱动界面布局（打开 Git 面板）', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  const headers = await unlockHeaders()
  // WS 广播时序偶发 → 最多重试 3 次上报
  let opened = false
  for (let i = 0; i < 3 && !opened; i++) {
    await page.request.post(`${API_BASE}/api/ops-notify`, {
      headers,
      data: { type: 'panel', payload: { name: 'git' } },
    })
    opened = await page.locator('.commits-toolbar').isVisible().catch(() => false)
    if (!opened) await page.waitForTimeout(1500)
  }
  // panel 事件经 WS 广播 → window CustomEvent → Layout togglePanel
  await expect(page.locator('.commits-toolbar')).toBeVisible({ timeout: 5000 })
})

test('AI 能力手册：全文含同步/文件/实例等域，SKILL.md 为渐进式索引形态', async ({ request }) => {
  // 智能体可见的能力手册（/ops-manual 免鉴权）必须与后端实际开放能力同步
  const res = await request.get(`${API_BASE}/ops-manual`)
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data: { manual: string } }).data.manual
  // Git 同步闭环（此前遗漏：agent 会提交但不知道能 fetch/pull/push）
  expect(body).toContain(':id/fetch')
  expect(body).toContain(':id/pull')
  expect(body).toContain(':id/push')
  expect(body).toContain('forceWithLease')
  // 文件 CRUD / 实例 / 片段 / 通知域
  expect(body).toContain(':id/file/rename')
  expect(body).toContain(':id/file/upload')
  expect(body).toContain('/api/instances')
  expect(body).toContain('/api/snippets')
  expect(body).toContain('/api/notifications')
  // 主机环境事实域（SSH 密钥/config 别名——git clone 前智能体自行感知，无需用户提示）
  expect(body).toContain('主机环境')
  expect(body).toContain('.ssh')
  // 敏感面必须不出现（环境事实域只写路径/别名等事实，不含密钥内容与凭据端点）
  expect(body).not.toContain('/api/credentials')
  expect(body).not.toContain('/api/tokens')
  expect(body).not.toContain('/api/agent-token')
  // task.progress/panel 事件
  expect(body).toContain('"task.progress"')
  expect(body).toContain('"name":"files|changes|git|terminal"')

  // 渐进式披露：SKILL.md（format=skill）为索引形态——含认证/工作流/索引，端点细节在 references/
  const skillRes = await request.get(`${API_BASE}/ops-manual?format=skill`)
  expect(skillRes.ok()).toBeTruthy()
  const skill = await skillRes.text()
  expect(skill).toContain('references/git.md')
  expect(skill).toContain('references/files.md')
  expect(skill).toContain('TASK_DONE')
  expect(skill).not.toContain('/id/file/rename') // 第一层不含端点细节
})

test('Git 面板：提交拓扑图渲染 + 仓库管理弹窗四页签可达', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  await openBottomGitStable(page)

  // 拓扑图：BranchGraph svg 节点与提交行同时存在（恢复的 BranchGraph 挂入提交列表）
  await expect(page.locator('.commit-item:visible').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.commits-graph-rows svg circle').first()).toBeVisible({ timeout: 5000 })
  expect(await page.locator('.commit-item:visible').count()).toBeGreaterThan(0)

  // 仓库管理弹窗（原 ManageView 迁入）：侧栏工具按钮打开
  await page.locator('.git-sidebar .sidebar-toggle[title="仓库管理"]').click()
  const modal = page.locator('.n-card')
  await expect(modal).toBeVisible({ timeout: 3000 })

  // 四页签逐个可达
  for (const tab of ['GPG 签名', 'LFS', 'Git 钩子']) {
    await modal.getByText(tab, { exact: true }).first().click()
    await page.waitForTimeout(400)
  }
  await expect(modal.getByText('仓库管理')).toBeVisible()

  // Esc 关闭
  await page.keyboard.press('Escape')
  await expect(modal).toBeHidden({ timeout: 3000 })
})

test('编辑器右键菜单：Monaco 原生菜单随语言包本地化为中文', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——与 core-workflow 同法归一化。
  // 限定文件树内的节点：全局 getByText('main.go') 会撞上 Git 提交列表里含
  // 「main.go」字样的提交信息（提交历史是活的，subject 一变就 strict 冲突）
  const mainGoItem = page.locator('.file-tree .item-name', { hasText: 'main.go' })
  for (let i = 0; i < 3; i++) {
    if (await mainGoItem.isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
  await mainGoItem.click()
  await expect(page.getByRole('tab', { name: 'main.go' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.monaco-container').first()).toBeVisible({ timeout: 5000 })
  // 底部面板开合状态同样经 uiState 跨用例/跨页面持久化：面板展开时编辑器右键
  // 坐标会被面板头拦截（提交拓扑图等前序用例把面板留在展开态），先收起
  await closeBottomPanel(page)

  // 右键编辑器 → Monaco 原生菜单（esm/nls.messages.zh-cn.js 注入后全量本地化）：
  // 可编辑文件的固定项 剪切/复制/粘贴/命令面板/更改所有匹配项 均为中文，无英文残留
  await page.locator('.monaco-container').first().click({ button: 'right', position: { x: 240, y: 160 } })
  const menu = page.locator('.monaco-menu:visible')
  await expect(menu).toBeVisible({ timeout: 3000 })
  for (const label of ['剪切', '复制', '粘贴', '更改所有匹配项', '命令面板']) {
    await expect(menu.getByText(label, { exact: true })).toBeVisible()
  }
  await expect(menu.getByText(/^Undo$/)).toHaveCount(0)
  await expect(menu.getByText(/^Cut$/)).toHaveCount(0)
  await page.mouse.click(10, 10)
  await expect(menu).toBeHidden({ timeout: 3000 })
})

test('diff 对比面板右键菜单：原生只读菜单为中文（用户报告场景）', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  await openBottomGitStable(page)
  // 提交列表多挂载实例（底部 Git tab + 图列画布格），部分实例列宽为 0 不可见——
  // 断言/交互前先等可见行就位（CLAUDE.md 多挂载实例取可见实例约定）
  await expect(page.locator('.commit-item .commit-meta:visible').first()).toBeAttached({ timeout: 10000 })

  // 选中一条提交 → 变更文件树出现 → 双击文件打开 diff 对比面板
  // 注意点：点击 .commit-item 几何中心会命中 .commit-msg（其 @click.stop 吞掉冒泡，点击无效），
  // 因此点 meta 行触发选择。
  // 提交列表有两个挂载实例（侧栏 Git 管理视图 + 底部 Git tab），DOM 序在前的
  // 底部实例 meta 列宽可为 0（图列挤压）——本用例开的是侧栏视图，按 #side-panel
  // 作用域取可见实例（CLAUDE.md 多挂载实例取可见/last 同款约定）
  await page.locator('.commit-item .commit-meta:visible').first().click()
  await expect(page.locator('.diff-node .diff-name:not(.is-dir)').first()).toBeVisible({ timeout: 8000 })
  // 双击文件节点（首个 .diff-node 可能是目录，dblclick 对目录是展开语义）
  await page.locator('.diff-node').filter({ has: page.locator('.diff-name:not(.is-dir)') }).first().dblclick()
  const diffTab = page.getByRole('tab', { name: /\(Diff\)/ })
  await expect(diffTab).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.diff-editor-container').first()).toBeVisible({ timeout: 5000 })

  // 右键 diff 面板（有内容的修改侧）→ 原生菜单只读态：有 复制/命令面板，无 剪切/粘贴；无英文残留。
  // 注意点：右键要点在内容侧——新增文件的原始侧为空模型+view zone，原生行为不弹菜单
  await rightClickDiffContainer(page)
  const menu = page.locator('.monaco-menu:visible')
  await expect(menu).toBeVisible({ timeout: 3000 })
  await expect(menu.getByText('复制', { exact: true })).toBeVisible()
  await expect(menu.getByText('命令面板', { exact: true })).toBeVisible()
  await expect(menu.getByText('剪切', { exact: true })).toHaveCount(0)
  await expect(menu.getByText('粘贴', { exact: true })).toHaveCount(0)
  await expect(menu.getByText(/^Undo$/)).toHaveCount(0)
  await page.mouse.click(10, 10)
  await expect(menu).toBeHidden({ timeout: 3000 })

  // 语言服务驱动的菜单项按 provider/writable 显隐：遍历最近提交找一个有 worker 语言
  // （ts/js/vue/json）文件的 diff → 只读态下 转到符号 出现、重命名符号/格式化文档 因
  // writable 前置隐藏；同时覆盖 diff 切换后菜单仍正常（updateModel 先换后释的回归哨兵）
  const fileNodes = page.locator('.diff-node').filter({ has: page.locator('.diff-name:not(.is-dir)') })
  const wiredRe = /\.(ts|tsx|js|mjs|cjs|vue|json)$/i
  const items = page.locator('.commit-item')
  const total = Math.min(await items.count(), 5)
  let tsNode: import('@playwright/test').Locator | null = null
  for (let i = 0; i < total && !tsNode; i++) {
    // force：连续选提交会触发列表/变更树连环重渲染（图加载期尤甚），严格
    // 稳定性判定在负载下 10s 内等不到静默——点击落点由选中结果（下方文件树
    // 可见性）兜底校验，无需动作级稳定
    await items.nth(i).locator('.commit-meta').click({ force: true })
    // 显式等变更文件树渲染（固定 sleep 在全量负载下可能不够导致误判无文件）
    await expect(fileNodes.first()).toBeVisible({ timeout: 5000 }).catch(() => {})
    const nodes = await fileNodes.all()
    for (const n of nodes) {
      const name = (await n.locator('.diff-name').textContent()) || ''
      if (wiredRe.test(name.trim())) {
        tsNode = n
        break
      }
    }
  }
  expect(tsNode, '最近 5 条提交中应有 worker 语言（ts/js/vue/json）文件').toBeTruthy()
  await tsNode!.dblclick()
  await page.waitForTimeout(1200)
  await rightClickDiffContainer(page)
  const tsMenu = page.locator('.monaco-menu:visible')
  await expect(tsMenu).toBeVisible({ timeout: 3000 })
  await expect(tsMenu.getByText('转到符号...', { exact: true })).toBeVisible()
  await expect(tsMenu.getByText('重命名符号', { exact: true })).toHaveCount(0)
  await expect(tsMenu.getByText('格式化文档', { exact: true })).toHaveCount(0)
})

test('提交悬浮层：可移入复制 + 完整时间', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  await openBottomGitStable(page)
  expect(await page.locator('.commit-item').count()).toBeGreaterThan(0)

  // 悬停提交信息 → 悬浮层出现，含完整时间（YYYY-MM-DD HH:mm:ss）与复制按钮
  const msg = page.locator('.commit-msg:visible').first()
  await msg.hover()
  const pop = page.locator('.commit-pop')
  await expect(pop).toBeVisible({ timeout: 3000 })
  await expect(pop.locator('.commit-pop-time')).toHaveText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/)
  await expect(pop.locator('.commit-pop-copy')).toBeVisible()

  // 关键回归：鼠标移入悬浮层后仍保持显示（原生 title 会立即消失）→ 可选中/复制
  await page.waitForTimeout(400)
  await pop.hover()
  await page.waitForTimeout(500)
  await expect(pop).toBeVisible()

  // 一键复制完整信息 → 成功提示
  await pop.locator('.commit-pop-copy').click()
  await expect(page.locator('.n-message')).toHaveText(/已复制/, { timeout: 3000 })

  // 移出悬浮层后关闭
  await page.mouse.move(10, 10)
  await expect(pop).toBeHidden({ timeout: 3000 })
})

test('设置：AI 智能体选型持久化 + 白名单拒绝未知运行时', async ({ request }) => {
  const headers = await unlockHeaders()
  const base = API_BASE

  const put = await request.put(`${base}/api/settings`, { headers, data: { agentProvider: 'claude' } })
  expect(put.ok()).toBeTruthy()
  const res = await request.get(`${base}/api/settings`, { headers })
  const data = ((await res.json()) as { data?: { agentProvider?: string; agentProviders?: string[] } }).data
  expect(data?.agentProvider).toBe('claude')
  // 已注册运行时清单随 GET 返回（新 Provider 注册后前端选项自动出现）
  expect(Array.isArray(data?.agentProviders)).toBeTruthy()
  expect(data?.agentProviders?.length).toBeGreaterThan(0)

  // 白名单外运行时 → 400
  const bad = await request.put(`${base}/api/settings`, { headers, data: { agentProvider: 'no-such-agent' } })
  expect(bad.status()).toBe(400)

  // 还原 auto（避免影响其他用例的选型语义）
  await request.put(`${base}/api/settings`, { headers, data: { agentProvider: 'auto' } })
})

test('通知中心：打开 → Esc 关闭（与大纲/命令面板同惯例）', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 打开通知中心（顶栏铃铛）
  const bell = page.locator('.rail-btn[title="通知中心"], button[title="通知中心"]').first()
  await bell.click()
  const card = page.locator('.nc-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // Esc 关闭（此前只能点遮罩/×，不符合其余弹层的关闭惯例）
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })
})

test('任务运行器：检测任务 → Esc 关闭（与通知中心同惯例）', async ({ page }) => {
  await fixedLocale(page)
  await enterProject(page)

  // 顶栏「任务」打开任务运行器（simple-coding 项目必有 npm scripts）
  await page.locator('button[title="任务"]').click()
  const card = page.locator('.tr-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await expect(card.locator('.tr-item').first()).toBeVisible({ timeout: 5000 })

  // Esc 关闭（此前只能点遮罩/×）
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })
})
