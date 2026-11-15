import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { closeDshConsoleAndClearState, DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * 笔记独立视图 E2E（P-20261108-2）：笔记脱离侧栏窄条成 notepad 式大区域——
 * 首页近全屏 overlay / 项目页主区第六占用者（占编辑器位），两宿主同一开态与面板主体。
 *   1. 首页工具条入口 → overlay（单库：无数据源切换，P-20261108-3）→ 新建 + Ctrl+S
 *      保存命名 → Esc 关 → 进项目 rail 打开 → 同库数据在；notes-editor/notes-preview/
 *      notes-mode-* 契约与 Ctrl+Alt+M/Ctrl+Alt+R 在新区成立；头部 × 关闭回编辑器
 *   2. 项目页主区互斥双向：开笔记收 agent docked、开 docked 收笔记；Esc 不关项目页
 *      笔记视图（与 Esc 退栈链不抢序，关闭走头部 ×）
 *   3. 首页 overlay 交叉关闭：悬浮球（z 2500 浮于 overlay 之上）展开 docked → 笔记
 *      overlay 收起；Esc 让位 Naive 弹层（命名框先关）后再关 overlay
 *   4. 首页 docked overlay 头部「沉淀到笔记」→ 笔记 overlay 接管（反向交叉关闭）并
 *      聚焦笔记库「[项目名] 交接」单篇（P-20261108-3 沉淀改道 find-or-create）
 *   5. 旧 uiState 存档 sideView='notes'（已退役）→ 恢复归一 files，不渲染死分支
 *   6. 通知动作 panel:notes（入站 Hook 白名单既有面板）→ 直达笔记独立视图
 *   7. tab 条/侧栏空白区双击新建（P-20261112-8）+ 页签双击重命名与 Ctrl+Alt+←/→
 *      键盘循环切 tab（P-20261112-9-S2，空白面/页签本体两链分层）
 *   8. 活动篇持久化（P-20261112-6-S2）：打开篇 A → 刷新 → overlay 恢复且原篇 A
 *      在编（种子 A 更旧——排除「updatedAt 首篇」规则巧合命中）
 *   9. 路由往返工作面保持（P-20261114-1）：项目页开 → 回首页 overlay 呈现 →
 *      回项目仍在；首页开态刷新 overlay 确定性恢复；首页 overlay Esc 关 →
 *      回项目仍关（显式关闭持久化跟随，不复活）
 * 自备临时仓库与项目，afterAll 清理（范式与 notes-global.spec 对称）。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-notes-view')
const PROJ = 'e2e-notes-view'

let projId = ''
let headers: Record<string, string> = { 'Content-Type': 'application/json' }

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

function makeRepo(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  fs.writeFileSync(path.join(dir, 'README.md'), '# notes-view e2e\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 笔记独立视图基线'])
}

interface NoteMeta { id: string; title: string }

async function globalList(trash = false): Promise<NoteMeta[]> {
  const res = await fetch(`${API_BASE}/api/notes${trash ? '?trash=1' : ''}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data?: NoteMeta[] }).data ?? []
}

/** 清空全局库（在册+回收站彻底删除）——面板用例的确定性起点 */
async function purgeAllGlobal(): Promise<void> {
  for (const view of [await globalList(), await globalList(true)]) {
    for (const n of view) {
      await fetch(`${API_BASE}/api/notes/${n.id}?purge=1`, { method: 'DELETE', headers })
    }
  }
}

/** 服务端 notesView 开态槽当前值（P-20261114-4-S2 分场景槽：project 读 open /
 *  home 读 homeOpen；P-20261114-1 时代为单槽 open；undefined = 键缺席） */
async function notesViewOpen(scene: 'home' | 'project' = 'project'): Promise<boolean | undefined> {
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json().catch(() => null)) as { data?: Record<string, { notesView?: { open?: boolean; homeOpen?: boolean } }> } | null
  const ns = body?.data?.local?.notesView
  return scene === 'home' ? ns?.homeOpen : ns?.open
}

/** 清理全部终端会话（服务端全局共享，防残留会话的进度归属混入 docked/悬浮球） */
async function cleanupTerminals(): Promise<void> {
  const list = (await (await fetch(`${API_BASE}/api/terminals`, { headers })).json()) as { data?: { id: string }[] }
  for (const s of list.data ?? []) {
    await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers })
  }
}

/** uiState 布局键播种（layout 是顶层键整体替换——GET+合并整键 PATCH，裸发字段会把
 *  面板宽高等既有布局抹成默认；notes-agent-deposit.spec 同款） */
async function patchLayout(patch: Record<string, unknown>): Promise<void> {
  const stateRes = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await stateRes.json().catch(() => null)) as { data?: Record<string, { layout?: Record<string, unknown> }> } | null
  const layout = { ...(body?.data?.local?.layout || {}), ...patch }
  const res = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PATCH', headers, body: JSON.stringify({ local: { layout } }),
  })
  expect(res.ok).toBeTruthy()
}

test.beforeAll(async () => {
  headers = await unlockHeaders()
  const stale = (await (await fetch(`${API_BASE}/api/projects`, { headers })).json()) as { data?: { id: string; name: string }[] }
  for (const p of stale.data ?? []) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  makeRepo(REPO)
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO) }),
  })
  expect([200, 201]).toContain(res.status)
  projId = ((await res.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projId).not.toBe('')
})

test.afterAll(async () => {
  headers = await unlockHeaders()
  await cleanupTerminals()
  await purgeAllGlobal()
  if (projId) await fetch(`${API_BASE}/api/projects/${projId}`, { method: 'DELETE', headers })
  // uiState notesView 开态键兜底归位（P-20261112-6-S1）：开态已落盘，用例异常中断
  // 留下的开态残留会跨 run 复活（本 spec 多处起始断言 notes 隐藏）；命名空间浅合并
  // 只清本键，其余命名空间不动（closeDshConsoleAndClearState 同款机制）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: { notesView: null } }),
  })
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 首页 → 本 spec 项目卡进入项目页（projectCardByName 整词定位防子串误中） */
async function enterProject(page: Page): Promise<void> {
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
}

/** Ctrl+S 保存未命名篇的命名框：填名确认，等弹层离场收敛（防下一个命名框双命中） */
async function confirmNameDialog(page: Page, name: string, expectedSuggest?: string): Promise<void> {
  const dlgInput = page.locator('.n-dialog input')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  if (expectedSuggest !== undefined) await expect(dlgInput).toHaveValue(expectedSuggest)
  await dlgInput.fill(name)
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
}

test('首页入口 overlay：编辑保存 → Esc 关 → 项目页打开同库数据在（契约面 + 快捷键）', async ({ page, request }) => {
  await purgeAllGlobal()
  await fixedLocale(page)
  // dsh 开态经 uiState 持久化：首页挂载期恢复若迟到落地会按主区互斥收掉刚开的
  // 笔记 overlay——先清场保证确定性（helper 注释同款）
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 首页工具条入口 → 近全屏 overlay；单库化（P-20261108-3）后无「全局库|项目库」切换
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-testid="notes-source-switch"]')).toHaveCount(0)
  // 大区域形态：管理侧栏默认常显（空库 → 合成 default 占位，loadList 已收口）
  await expect(panel.locator('[data-testid="notes-search"]')).toBeVisible()
  await expect(panel.locator('[data-testid="notes-tab-default"]')).toBeVisible({ timeout: 8000 })

  // 快捷新建 → 编辑 → Ctrl+S 命名（预填正文首行建议）。create 是异步 POST + 广播
  // 重拉——等占位 tab 消失即三面收敛（notes-global.spec 同款时序）
  await panel.locator('[data-testid="notes-create-quick"]').click()
  await expect(panel.locator('[data-testid="notes-tab-default"]')).toBeHidden({ timeout: 8000 })
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toBeVisible()
  await editor.fill('# 首页随手记\n\n- 来自首页 notepad')
  await editor.press('Control+s')
  await confirmNameDialog(page, '首页笔记', '首页随手记')
  await expect.poll(async () => (await globalList()).some(n => n.title === '首页笔记'), { timeout: 8000 }).toBe(true)

  // Esc（首页 overlay 专属）关闭
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()

  // 进项目页：笔记视图不自动展开（首页关态带入）；rail 打开 → 主区占编辑器位
  await enterProject(page)
  const railNotes = page.locator('[data-testid="rail-notes"]')
  await expect(railNotes).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-testid="notes-view"]')).toBeHidden()
  await railNotes.click()
  const view = page.locator('[data-testid="notes-view"]')
  await expect(view).toBeVisible({ timeout: 8000 })
  await expect(railNotes).toHaveClass(/active/)
  await expect(page.locator('.ide-editor-area')).toBeHidden()
  const vPanel = view.locator('[data-testid="notes-panel"]')

  // 同库数据在：笔记是项目无关的单库，首页写的篇在项目页列表里
  const item = vPanel.locator('[data-testid="notes-list-item"]').filter({ hasText: '首页笔记' })
  await expect(item).toHaveCount(1, { timeout: 8000 })
  await item.click()
  const vEditor = vPanel.locator('[data-testid="notes-editor"]')
  await expect(vEditor).toHaveValue(/首页随手记/, { timeout: 8000 })

  // notes-mode-* / notes-preview 契约：预览渲染 h1，切回编辑
  await vPanel.locator('[data-testid="notes-mode-preview"]').click()
  await expect(vPanel.locator('[data-testid="notes-preview"] h1')).toHaveText('首页随手记')
  await vPanel.locator('[data-testid="notes-mode-edit"]').click()
  await expect(vEditor).toBeVisible()

  // Ctrl+Alt+M 新建（焦点域 = 面板根 contains，宿主无关）→ Ctrl+Alt+R 重命名
  await vEditor.click()
  await vEditor.press('Control+Alt+m')
  await expect(vPanel.locator('[data-testid^="notes-tab-"]')).toHaveCount(2, { timeout: 8000 })
  await vEditor.fill('项目页新篇草稿')
  await vEditor.press('Control+Alt+r')
  await confirmNameDialog(page, '项目页命名')
  await expect.poll(async () => (await globalList()).some(n => n.title === '项目页命名'), { timeout: 8000 }).toBe(true)

  // 头部 × 关闭 → 主区回到编辑器
  await vPanel.locator('[data-testid="notes-close"]').click()
  await expect(view).toBeHidden()
  await expect(page.locator('.ide-editor-area')).toBeVisible()
  await expect(railNotes).not.toHaveClass(/active/)
})

test('项目页主区互斥双向：笔记 ↔ agent docked；Esc 不关项目页笔记视图', async ({ page, request }) => {
  await cleanupTerminals()
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const railNotes = page.locator('[data-testid="rail-notes"]')
  const railAgent = page.locator('[data-testid="rail-agent-terminal"]')
  const view = page.locator('[data-testid="notes-view"]')
  const docked = page.locator('.atv-root')

  // 先开 docked，再开笔记 → docked 收起（开笔记关 agent docked）
  await railAgent.click()
  await expect(docked).toBeVisible({ timeout: 10000 })
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })
  await expect(docked).toBeHidden()
  await expect(railAgent).not.toHaveClass(/active/)
  await expect(railNotes).toHaveClass(/active/)

  // 反向：开 docked → 笔记收起
  await railAgent.click()
  await expect(docked).toBeVisible({ timeout: 10000 })
  await expect(view).toBeHidden()
  await expect(railNotes).not.toHaveClass(/active/)

  // 再开笔记：Esc 不关（项目页关闭走头部 ×，不与 useLayoutKeyboard 退栈链抢序）。
  // 焦点先移出 rail 按钮落 body（不点坐标——左上角是实例切换器热区）
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
  await page.keyboard.press('Escape')
  await expect(view).toBeVisible()

  // rail 再点 = 收起（toggle 语义），编辑器回位
  await railNotes.click()
  await expect(view).toBeHidden()
  await expect(page.locator('.ide-editor-area')).toBeVisible()
})

test('首页 overlay 交叉关闭：悬浮球展开 docked 收起笔记；Esc 让位命名框后再关 overlay', async ({ page, request }) => {
  await cleanupTerminals()
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  // 悬浮球形态播种（openState 持久化键，挂载时消费恢复）+ 上次展开形态 = docked：
  // 单击球（无任务归属）即 open() 回到 docked——首页 overlay 交叉关闭的真实入口
  //（球 z 2500 浮于 z 900 的笔记 overlay 之上，工具条被 overlay 覆盖不可点）
  await page.addInitScript(() => {
    try {
      localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' }))
      localStorage.setItem('sc.agentTerminal.expandedMode', 'docked')
    } catch { /* ignore */ }
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  const ball = page.locator('.agm-root.is-ball')
  await expect(ball).toBeVisible({ timeout: 8000 })

  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })

  // 球展开为 docked overlay → 笔记 overlay 收起（closeMainViews 一处收口）
  await ball.click()
  await expect(page.locator('.agt-home-overlay .atv-root')).toBeVisible({ timeout: 10000 })
  await expect(overlay).toBeHidden()

  // Esc 收 docked overlay（既有链）→ 再开笔记 overlay
  await page.keyboard.press('Escape')
  await expect(page.locator('.agt-home-overlay')).toBeHidden()
  await page.locator('[data-testid="home-notes"]').click()
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(editor).toBeVisible({ timeout: 8000 })

  // Esc 让位：重命名框（Naive n-dialog）在场时 Esc 只关弹框，overlay 保持
  await editor.click()
  await editor.press('Control+Alt+r')
  await expect(page.locator('.n-dialog input')).toBeVisible({ timeout: 4000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
  await expect(overlay).toBeVisible()

  // 弹框收尾后 Esc 关 overlay
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
})

test('首页 docked overlay 头部「沉淀到笔记」→ 笔记 overlay 接管（反向交叉关闭）', async ({ page, request }) => {
  await cleanupTerminals()
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  // 先进本 spec 项目再回首页：当前项目 = 本项目（沉淀落「[本项目] 交接」——不与种子
  // 项目的交接篇混同；afterAll purgeAllGlobal 清场）
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })

  // 首页工具条打开 docked overlay
  await page.locator('.home-action-btn[title="终端会话管理"]').click()
  const dockedOverlay = page.locator('.agt-home-overlay')
  await expect(dockedOverlay.locator('.atv-root')).toBeVisible({ timeout: 10000 })

  // agent 会话（cwd = 本项目根，归属解析同项目）+ task.progress 终态上报（真实
  // ops-notify → WS → assistantTask 链）→ 头部「沉淀到笔记」出现
  const session = await createAgentSessionApi(request, { name: 'e2e-notes-view-agent', runtime: 'shell', dir: REPO })
  const reported = await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST', headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task: 'e2e 首页沉淀', status: 'done', terminalId: session.id } }),
  })
  expect(reported.ok).toBeTruthy()
  const depositBtn = dockedOverlay.locator('[data-testid="agent-notes-deposit"]')
  await expect(depositBtn).toBeVisible({ timeout: 10000 })
  await depositBtn.click()

  // 落盘 toast + 笔记 overlay 打开并聚焦「[项目名] 交接」单篇，docked overlay 收起
  await expect(page.locator('.n-message').filter({ hasText: '已写入笔记' })).toBeVisible({ timeout: 8000 })
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  await expect(dockedOverlay).toBeHidden()
  const panel = overlay.locator('[data-testid="notes-panel"]')
  await expect(panel.locator('[data-testid="notes-editor"]')).toHaveValue(/## \d{4}-\d{2}-\d{2} e2e 首页沉淀/, { timeout: 8000 })
  // 落笔记库（项目无关单库）且一项目一篇：标题带项目名前缀
  await expect.poll(async () => (await globalList()).filter(n => n.title === `[${PROJ}] 交接`).length, { timeout: 8000 }).toBe(1)

  // 收尾关闭（P-20261112-6-S1：笔记开态落 uiState——开态残留会让本 spec 后续用例
  // 及下一轮 run 恢复出开态，与「旧存档归一」「panel:notes」用例的起始隐藏断言互踩）
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()
})

test("旧 uiState 存档 sideView='notes'（已退役）恢复归一 files，不渲染死分支", async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  // 页面加载前写入旧形态存档（笔记曾是侧栏视图）：恢复时须归一，否则 SidePanel
  // 分发链落末位 v-else 渲染提交面板（与活动栏高亮错位）
  await patchLayout({ sideView: 'notes', showSidePanel: true })
  try {
    await gotoAndUnlock(page, `${API_BASE}/`)
    await enterProject(page)
    const side = page.locator('#side-panel')
    await expect(side).toBeVisible({ timeout: 10000 })
    await expect(side.locator('.file-tree')).toBeVisible({ timeout: 10000 })
    await expect(side.locator('[data-testid="commit-panel"]')).toHaveCount(0)
    await expect(page.locator('[data-testid="rail-files"]')).toHaveClass(/active/)
    // 笔记视图不因旧存档自动展开（P-20261112-6-S1：开态落 uiState notesView.open，
    // 旧存档无此键 = 不恢复按关处理——归一断言对新键同样成立）
    await expect(page.locator('[data-testid="notes-view"]')).toBeHidden()
    await expect(page.locator('[data-testid="rail-notes"]')).not.toHaveClass(/active/)
  } finally {
    // 存档归位：恢复期对齐基线后不会自动回写，残值留给后续 spec 无意义
    await patchLayout({ sideView: 'files' }).catch(() => { /* 尽力归位 */ })
  }
})

// 第六消费方回归（实施自查补全）：入站 Hook 白名单既有 panel:notes 动作——曾落
// usePanelLayout.togglePanel 侧栏分支，侧栏 notes 退役后由 useLayoutShell 通知
// 动作处理器单独接 openNotesView（不接则点通知静默 no-op）。协议值不变（增量兼容）
test('通知行动作 panel:notes（入站 Hook）：点行直达笔记独立视图', async ({ page, request }) => {
  headers = await unlockHeaders()
  await request.delete(`${API_BASE}/api/hook-token`, { headers })
  const rot = await request.post(`${API_BASE}/api/hook-token/rotate`, { headers })
  expect(rot.ok()).toBeTruthy()
  const token = ((await rot.json()) as { data?: { token?: string } }).data?.token || ''
  expect(token.startsWith('sch_'), `expect sch_ token, got ${token}`).toBeTruthy()
  try {
    const title = 'E2E hook panel notes'
    const posted = await request.post(`${API_BASE}/api/hooks`, {
      headers: { 'X-Hook-Token': token, 'Content-Type': 'application/json' },
      data: { title, action: 'panel:notes' },
    })
    expect(posted.status()).toBe(200)

    await fixedLocale(page)
    await closeDshConsoleAndClearState(page, request, API_BASE)
    await gotoAndUnlock(page, `${API_BASE}/`)
    await enterProject(page)
    await expect(page.locator('[data-testid="notes-view"]')).toBeHidden()
    await page.locator('button[title="通知中心"]').first().click()
    await expect(page.locator('.nc-card')).toBeVisible({ timeout: 5000 })
    const row = page.locator('.nc-item').filter({ hasText: title }).first()
    await expect(row).toBeVisible({ timeout: 5000 })
    // 行可点（action 存在）→ pendingAction 分发 panel:notes → 主区笔记视图打开
    await row.click()
    await expect(page.locator('[data-testid="notes-view"]')).toBeVisible({ timeout: 8000 })
    await expect(page.locator('[data-testid="rail-notes"]')).toHaveClass(/active/)

    // 收尾关闭（P-20261112-6-S1：开态落 uiState——本用例是文件收尾，开态残留会
    // 跨 spec/跨 run 复活；项目页关闭走头部 ×，不接 Esc）
    await page.locator('[data-testid="notes-close"]').click()
    await expect(page.locator('[data-testid="notes-view"]')).toBeHidden()
  } finally {
    await request.delete(`${API_BASE}/api/hook-token`, { headers }).catch(() => { /* 尽力撤销 */ })
    await request.post(`${API_BASE}/api/notifications/clear`, { headers }).catch(() => { /* 尽力清场 */ })
  }
})

// P-20261112-8 笔记快捷新建：tab 条/侧栏列表空白区双击建篇（Notepad++ 标签条同款
// 心智）——双击空白 → 新篇激活（新建篇 prepend 首位）→ 编辑器聚焦；页签本体双击
// 是重命名（P-20261112-9-S2，-8 时代为幂等 select），容器 target 守卫保证不建篇
test('tab 条/侧栏空白区双击新建：建篇即激活+编辑器聚焦；页签双击不建篇（出重命名框）', async ({ page, request }) => {
  await purgeAllGlobal()
  // API 直播两篇种子（tab 条/侧栏有内容，空白区才存在；afterAll purgeAllGlobal 清场）
  for (const title of ['双击种子一', '双击种子二']) {
    const made = await fetch(`${API_BASE}/api/notes`, { method: 'POST', headers, body: JSON.stringify({ title }) })
    expect([200, 201]).toContain(made.status)
  }
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)

  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  const tabs = panel.locator('[data-testid="notes-tabs"]')
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(tabs).toBeVisible({ timeout: 8000 })
  const before = await panel.locator('[data-testid^="notes-tab-"]').count()
  expect(before).toBe(2)

  // 页签本体双击 = 重命名（P-20261112-9-S2），容器空白守卫拦住不建篇：出重命名框
  //（promptDialog 预填原标题，侧栏行内重命名同链），取消收场
  const seedTab = panel.locator('[data-testid^="notes-tab-"]').filter({ hasText: '双击种子一' })
  await seedTab.dblclick()
  const dlgInput = page.locator('.n-dialog input')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  await expect(dlgInput).toHaveValue('双击种子一')
  await page.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
  await expect(panel.locator('[data-testid^="notes-tab-"]')).toHaveCount(2)

  // tab 条空白区双击（右缘内侧剩余面——两篇页签远不到右缘）→ 建篇即激活+聚焦
  const box = await tabs.boundingBox()
  if (!box) throw new Error('notes-tabs 未渲染出可点几何')
  await tabs.dblclick({ position: { x: box.width - 8, y: box.height / 2 } })
  await expect(panel.locator('[data-testid^="notes-tab-"]')).toHaveCount(before + 1, { timeout: 8000 })
  await expect(panel.locator('[data-testid^="notes-tab-"]').first()).toHaveClass(/active/)
  await expect(editor).toBeFocused()

  // 侧栏列表空白区双击（容器底部剩余面——行/回收站段都在上部）→ 同链建篇+聚焦
  const sidebar = panel.locator('[data-testid="notes-sidebar"]')
  await expect(sidebar).toBeVisible()
  const sbox = await sidebar.boundingBox()
  if (!sbox) throw new Error('notes-sidebar 未渲染出可点几何')
  await sidebar.dblclick({ position: { x: sbox.width / 2, y: sbox.height - 8 } })
  await expect(panel.locator('[data-testid^="notes-tab-"]')).toHaveCount(before + 2, { timeout: 8000 })
  await expect(panel.locator('[data-testid^="notes-tab-"]').first()).toHaveClass(/active/)
  await expect(editor).toBeFocused()
})

// P-20261112-9-S2 笔记页签双击重命名 + tab 键盘循环：双击页签 → 重命名框预填
// 原标题 → 改名在 tab 条/侧栏行/服务端三面同步；ctrl+alt+→/← 沿页签条可见序
// 循环切篇（首尾相连），textarea 是 v-show 同一 DOM 节点——编辑面焦点不丢。
// 循环序断言从 DOM 现算（updatedAt 降序会因改名/广播重拉而重排，不硬编码绝对序）
test('页签双击重命名（tab/侧栏/服务端同步）+ Ctrl+Alt+←/→ 键盘循环切 tab', async ({ page, request }) => {
  await purgeAllGlobal()
  for (const title of ['循环甲', '循环乙', '循环丙']) {
    const made = await fetch(`${API_BASE}/api/notes`, { method: 'POST', headers, body: JSON.stringify({ title }) })
    expect([200, 201]).toContain(made.status)
  }
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  const tabs = panel.locator('[data-testid^="notes-tab-"]')
  const editor = panel.locator('[data-testid="notes-editor"]')
  await expect(tabs).toHaveCount(3, { timeout: 8000 })

  // 双击页签重命名（侧栏行内重命名 promptDialog 同链）：预填原标题 → 确认改名
  await tabs.filter({ hasText: '循环乙' }).dblclick()
  const dlgInput = page.locator('.n-dialog input')
  await expect(dlgInput).toBeVisible({ timeout: 4000 })
  await expect(dlgInput).toHaveValue('循环乙')
  await dlgInput.fill('循环乙改')
  await page.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
  // 三呈现面同步：tab 条、侧栏行、服务端清单
  await expect(tabs.filter({ hasText: '循环乙改' })).toHaveCount(1)
  await expect(panel.locator('[data-testid="notes-list-item"]').filter({ hasText: '循环乙改' })).toHaveCount(1)
  await expect.poll(async () => (await globalList()).some(n => n.title === '循环乙改'), { timeout: 8000 })
    .toBe(true)

  // 键盘循环（notesNextTab/notesPrevTab 默认 ctrl+alt+←/→，焦点域消费）：焦点落
  // 编辑面后连续按 →，逐篇后移并在末尾回绕到首位
  await editor.click()
  const titlesInOrder = async (): Promise<string[]> =>
    (await panel.locator('.np-tab .np-tab-title').allTextContents()).map(s => s.trim())
  const activeTitle = async (): Promise<string> =>
    ((await panel.locator('.np-tab.active .np-tab-title').textContent()) ?? '').trim()
  const step = async (delta: 1 | -1): Promise<void> => {
    const list = await titlesInOrder()
    const cur = await activeTitle()
    const next = list[(list.indexOf(cur) + delta + list.length) % list.length]
    await editor.press(delta === 1 ? 'Control+Alt+ArrowRight' : 'Control+Alt+ArrowLeft')
    await expect(panel.locator('.np-tab.active')).toContainText(next, { timeout: 4000 })
  }
  await step(1)
  await step(1)
  await step(1) // 三篇连按三次 = 回绕一圈回到起点
  await expect(editor).toBeFocused() // v-show textarea 同一 DOM 节点，焦点不挪
  await step(-1)
  await step(-1)
  await expect(editor).toBeFocused()
})

// P-20261112-6-S2 活动篇持久化：打开篇 A → 刷新 → 恢复篇 A（写作现场零丢失，
// 智能体 frontend.reload 同受益）。种子两篇且 A 更旧：无持久化时 boot 保底选篇
// 回落 updatedAt 首篇 B——恢复后选中 A 即两段式第一段真实生效（排除首篇规则的
// 巧合命中）
test('活动篇持久化：打开篇 A → 刷新 → 笔记 overlay 恢复且原篇 A 在编', async ({ page, request }) => {
  await purgeAllGlobal()
  await fixedLocale(page)
  // 清 notesView 键族（open+activeId，helper 是开态清场口）——起点确定性
  await closeDshConsoleAndClearState(page, request, API_BASE)
  // API 直播两篇：A 先建（更旧）、B 后建（更新）
  const madeA = await fetch(`${API_BASE}/api/notes`, { method: 'POST', headers, body: JSON.stringify({ title: '恢复种子A' }) })
  expect([200, 201]).toContain(madeA.status)
  const noteA = ((await madeA.json()) as { data?: NoteMeta }).data
  expect(noteA?.id, '种子 A 建篇应返回 id').toBeTruthy()
  const madeB = await fetch(`${API_BASE}/api/notes`, { method: 'POST', headers, body: JSON.stringify({ title: '恢复种子B' }) })
  expect([200, 201]).toContain(madeB.status)
  const noteB = ((await madeB.json()) as { data?: NoteMeta }).data
  expect(noteB?.id, '种子 B 建篇应返回 id').toBeTruthy()

  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  const panel = overlay.locator('[data-testid="notes-panel"]')
  await expect(panel.locator('[data-testid="notes-tabs"]')).toBeVisible({ timeout: 8000 })
  await expect(panel.locator('[data-testid^="notes-tab-"]')).toHaveCount(2)

  // 打开篇 A（页签点击 = select → 活动篇即时落盘）
  await panel.locator(`[data-testid="notes-tab-${noteA.id}"]`).click()
  await expect(panel.locator('[data-testid="notes-editor"]')).toBeVisible()

  // 活动篇已落盘（PATCH 即时写）——落定后刷新才可信
  await expect.poll(async () => {
    const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
    const body = (await res.json().catch(() => null)) as { data?: Record<string, { notesView?: { activeId?: string } }> } | null
    return body?.data?.local?.notesView?.activeId ?? ''
  }, { timeout: 8000 }).toBe(noteA.id)

  // 刷新：S1 开态恢复（overlay 重开）+ S2 活动篇随 loadList 两段式落位——
  // 恢复选中 A 而非首篇 B
  await page.reload()
  await expect(overlay).toBeVisible({ timeout: 10000 })
  const panelAfter = overlay.locator('[data-testid="notes-panel"]')
  await expect(panelAfter.locator(`[data-testid="notes-tab-${noteA.id}"]`)).toHaveClass(/active/, { timeout: 8000 })
  await expect(panelAfter.locator(`[data-testid="notes-tab-${noteB.id}"]`)).not.toHaveClass(/active/)
})

// P-20261114-4-S2 路由往返场景归属（三用例，P-20261114-1「首页 overlay 呈现」
// 旧口径已翻转）——工作面归属打开它的场景：①项目页笔记开态跨首页往返保持，
// 回首页**不呈现**（首页纯导航），回项目恢复；②首页开态刷新按 home 槽确定性
// 恢复；③首页显式关闭落 home 槽（Esc 落盘 homeOpen=false），回项目恢复 project
// 槽开态——两场景槽互不覆写，恢复 once-per-load 按发起场景分桶
test('路由往返场景归属：项目页笔记开 → 回首页不呈现 → 回项目恢复', async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  const railNotes = page.locator('[data-testid="rail-notes"]')
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })

  // 回首页：工作面归属打开它的场景（P-20261114-4）——项目开态不越界到首页，
  // overlay 不呈现（NotesView context=home 宿主 everOpened 只随本场景开关）
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toHaveCount(0)

  // 回项目（浏览器返回键是既有回家路径——agent-terminal.spec 导航序列同款）：
  // 场景快照恢复，主区视图仍在且 rail 选中态同步
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeVisible({ timeout: 8000 })
  await expect(railNotes).toHaveClass(/active/)

  // 收尾关闭（开态已落 uiState，防残留跨用例/跨 run 复活遮首页入口——同族收尾纪律）
  await page.locator('[data-testid="notes-close"]').click()
  await expect(view).toBeHidden()
})

test('首页开态刷新：overlay 确定性恢复（按 home 槽 homeOpen，P-20261114-4-S2 分场景槽）', async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)

  // 首页工具条打开笔记 overlay
  await page.locator('[data-testid="home-notes"]').click()
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toBeVisible({ timeout: 8000 })
  await expect(overlay.locator('[data-testid="notes-panel"]')).toBeVisible()

  // 开态已落盘（persistNotesViewOpen watch 即时写，home 场景落 notesView.homeOpen
  // 槽；严格断言 home 槽键而非 project 槽——分场景槽位断言）——落定后刷新才可信
  //（活动篇持久化用例同款时序）
  await expect.poll(() => notesViewOpen('home'), { timeout: 8000 }).toBe(true)
  expect(await notesViewOpen('project')).toBeUndefined() // project 槽不被首页开态覆写

  // 刷新：恢复链 once-per-load 在新页面重走（boot@home 读 home 槽，notes 先、
  // dsh 后），overlay 确定性呈现
  await page.reload()
  await expect(overlay).toBeVisible({ timeout: 10000 })
  await expect(overlay.locator('[data-testid="notes-panel"]')).toBeVisible()
})

test('首页 overlay Esc 显式关闭落 home 槽：回项目恢复 project 槽开态（P-20261114-4-S2）', async ({ page, request }) => {
  await fixedLocale(page)
  await closeDshConsoleAndClearState(page, request, API_BASE)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await enterProject(page)

  const view = page.locator('[data-testid="notes-view"]')
  const railNotes = page.locator('[data-testid="rail-notes"]')
  await railNotes.click()
  await expect(view).toBeVisible({ timeout: 8000 })

  // 项目开态落 project 槽（严格断言 open:true——显式写持久化态而非清场归零）
  await expect.poll(() => notesViewOpen('project'), { timeout: 8000 }).toBe(true)

  // 回首页：场景归属不呈现（P-20261114-4 翻转 P-20261114-1「overlay 呈现」）；
  // 首页显式打开后才有关闭面——首页工具条入口 → Esc（此处无 Naive 弹层，
  // hasBlockingOverlay 让位逻辑不触发）
  await page.locator('.ide-header button[title="返回首页"]').click()
  await expect(page.locator('[data-testid="home-notes"]')).toBeVisible({ timeout: 10000 })
  const overlay = page.locator('[data-testid="notes-home-overlay"]')
  await expect(overlay).toHaveCount(0)
  await page.locator('[data-testid="home-notes"]').click()
  await expect(overlay).toBeVisible({ timeout: 8000 })
  await page.keyboard.press('Escape')
  await expect(overlay).toBeHidden()

  // 显式关闭落 home 槽（统一 watch 即时写，严格断言 homeOpen:false——区分
  // 「显式关闭写持久化态」与「清场归零」两形态；project 槽开态不被回声覆写）
  await expect.poll(() => notesViewOpen('home'), { timeout: 8000 }).toBe(false)
  expect(await notesViewOpen('project')).toBe(true)

  // 回项目恢复 project 槽开态：Esc 只落 home 槽，project 场景快照与槽位开态
  // 均未动（P-20261114-1「回项目仍关」旧口径随分场景槽翻转——显式关闭跟随的
  // 是关闭所在场景）
  await page.goBack()
  await page.waitForURL('**/project')
  await expect(view).toBeVisible({ timeout: 8000 })
  await expect(railNotes).toHaveClass(/active/)
})
