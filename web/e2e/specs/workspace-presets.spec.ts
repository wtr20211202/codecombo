import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 工作区预设 E2E（P-20261003-68）：在 P-20261002-84 存档点链上验证预设语义净增量——
 *   ① 主链：保存预设（带分屏）→ 改动现场（关分屏/收底栏/开别文件/改宽度）→ 恢复
 *      → 布局/打开集/分屏开合就地还原；快照带 schema 版本号与分屏开合维度
 *   ② 恢复前自动档：恢复后服务端快照表头出现「恢复前」条目（恢复前现场快照）
 *   ③ 未保存修改确认流出现：确认后主组整表换签
 *   ④ 会话组结构恢复：仅写结构不自动拉起会话（服务端 agentTerminal.groups 变化
 *      + 终端会话表计数不变）
 *   ⑤ 行内改名（可删改的「改」）：改名落盘 + 重名拒绝
 *   ⑥ Ctrl+Alt+数字直达恢复（P-20261004-49）：弹层序号提示 + 一键恢复列表第 N 个
 *   ⑦ 会话组恢复即时生效（P-20261004-79）：管理页挂着 → 恢复预设 → 侧栏组结构
 *      即时变化（全程不重载，OPS_AGENT_GROUPS_CHANGED 广播消费链）
 * 自备临时仓库（workspace-snapshot 先例），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-workspace-presets')
const PROJ = 'e2e-workspace-presets'
const PRESET_NAME = 'e2e-preset'
const AUTO_ARCHIVE_NAME = '恢复前'
/** #side-panel 内联宽度样式断言（出厂 280 / 拖窄钳位下限 180） */
const widthStyle = (w: number) => new RegExp(`width:\\s*${w}px`)

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

async function registerProject(headers: Record<string, string>, name: string, dir: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  expect([200, 201]).toContain(res.status)
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.join(REPO_DIR, 'src'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'workspace presets baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'util.ts'), 'export const x = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 工作区预设基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
    }
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 读服务端 ui-state 实例级字段（snapshots / agentTerminal 断言源） */
async function readLocalUIState(): Promise<{
  snapshots?: Record<string, Array<Record<string, unknown>>>
  agentTerminal?: { groups?: Array<Record<string, unknown>> }
}> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as { data?: { local?: Record<string, unknown> } }
  return (body.data?.local || {}) as {
    snapshots?: Record<string, Array<Record<string, unknown>>>
    agentTerminal?: { groups?: Array<Record<string, unknown>> }
  }
}

/** API 直播快照（确认流/会话组/改名用例的种子；服务端按命名空间浅合并） */
async function seedSnapshots(snaps: Array<Record<string, unknown>>) {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers,
    body: JSON.stringify({ local: { snapshots: { [projectId]: snaps } } }),
  })
  expect(res.ok).toBeTruthy()
}

function fakeSnap(name: string, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: `wsnap-${name}`,
    version: 1,
    name,
    savedAt: Date.now(),
    branch: '',
    editor: { openFiles: [] as string[], activeFile: '', splitOpen: false },
    layout: {
      sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true,
      showBottomPanel: false, sideView: 'files', bottomTab: 'git',
    },
    fileTree: { expandedDirs: [] },
    ...overrides,
  }
}

/** 服务端终端会话表（「会话组仅恢复结构不自动拉起会话」的计数断言源） */
async function terminalCount(): Promise<number> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: unknown[] }).data || []
  return list.length
}

/** 进入项目页并保证文件树可见（每用例先清 uiState 再 reload：前序残留的快照/
 *  agentTerminal 会与本用例的存档/恢复断言竞态——清空后进入，行为只由本用例驱动） */
async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

/** 侧栏拖到钳位下限 180（SidePanel 钳位 [180, 500]，向左拖 120px 触发下限） */
async function dragSidebarTo180(page: import('@playwright/test').Page) {
  const resizer = page.locator('.ide-side-resizer')
  const box = await resizer.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 - 120, box!.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180))
}

/** 命令面板执行命令（Ctrl+K → `>` 命令模式 → 点命令项）。
 *  Monaco 挂载中会吞 Ctrl+K 弦：标签栏存在（=有打开文件）时先点标签栏空白
 *  让焦点移出 Monaco（workspace-snapshot 同款）；无标签时无 Monaco，直接按键 */
async function runPaletteCommand(page: import('@playwright/test').Page, title: string) {
  const tabs = page.locator('.editor-tabs')
  if (await tabs.isVisible().catch(() => false)) await tabs.click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(`>${title}`)
  const item = page.locator('.palette-item').filter({ hasText: title }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
}

/** 标签右键菜单动作（原生 div 菜单 role=menuitem，非 NDropdown） */
async function runTabContextAction(page: import('@playwright/test').Page, tab: ReturnType<import('@playwright/test').Page['locator']>, action: string) {
  await tab.click({ button: 'right' })
  const item = page.locator('[role="menuitem"]').filter({ hasText: action })
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
}

test('保存预设（带分屏）→ 改动现场 → 恢复：布局/打开集/分屏开合还原 + 快照新维度落盘', async ({ page }) => {
  await enterProject(page)
  // 布置现场：README + util.ts 落主组；README「在右侧分屏打开」（共享对象语义，
  // 分屏组复现 README 签）+ 底栏终端 + 侧栏拖窄
  await page.locator('.file-tree .item-name').filter({ hasText: 'README.md' }).first().click()
  await page.locator('.file-tree .item-name').filter({ hasText: /^src$/ }).first().click()
  await page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' }).first().click({ timeout: 5000 })
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible()
  await runTabContextAction(page, page.locator('.pane-primary .editor-tab', { hasText: 'README.md' }), '在右侧分屏打开')
  await expect(page.locator('.pane-split .editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 5000 })
  await page.locator('[data-testid="rail-terminal"]').click()
  await expect(page.locator('.bottom-panel')).toBeVisible()
  await dragSidebarTo180(page)

  // 命令面板「保存当前现场」→ 命名预设
  await runPaletteCommand(page, '保存当前现场')
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('input').fill(PRESET_NAME)
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: PRESET_NAME })).toBeVisible({ timeout: 5000 })

  // 服务端快照新维度：schema 版本号 + 分屏开合（true）+ 会话组结构维度在位
  await expect.poll(async () => {
    const all = await readLocalUIState()
    const list = (all.snapshots?.[projectId] || []) as Array<{
      name?: string; version?: number
      editor?: { openFiles?: string[]; splitOpen?: boolean }
      agentGroups?: unknown
    }>
    const snap = list.find(s => s.name === PRESET_NAME)
    return !!snap && snap.version === 1
      && snap.editor?.openFiles?.includes('README.md')
      && snap.editor?.openFiles?.includes('src/util.ts')
      && snap.editor?.splitOpen === true
      && Array.isArray(snap.agentGroups)
  }, { timeout: 10000 }).toBeTruthy()

  // 改动现场：关分屏 + 关掉 util.ts 标签（打开集变化）+ 收底栏 + 宽度拖回 280
  await runTabContextAction(page, page.locator('.pane-split .editor-tab', { hasText: 'README.md' }), '关闭分屏')
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await page.locator('.pane-primary .editor-tab', { hasText: 'util.ts' }).locator('.tab-close').click()
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toHaveCount(0)
  await page.locator('[data-testid="rail-terminal"]').click()
  await expect(page.locator('.bottom-panel')).toBeHidden()
  const resizer = page.locator('.ide-side-resizer')
  const box = await resizer.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 + 100, box!.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280))

  // 恢复预设：列表行内「恢复」
  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: PRESET_NAME })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 就地还原：分屏组复现（开合还原）/被关的 util.ts 按预设重开（打开集还原）/
  // 底栏复开/宽度回 180
  await expect(page.locator('.pane-split')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.pane-primary .editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180), { timeout: 5000 })

  // 恢复前自动档：服务端快照表头出现「恢复前」条目，内容 = 恢复前现场
  //（分屏关/主组仅剩 README——util.ts 已被关）
  await expect.poll(async () => {
    const all = await readLocalUIState()
    const list = (all.snapshots?.[projectId] || []) as Array<{
      name?: string; editor?: { openFiles?: string[]; splitOpen?: boolean }
    }>
    return list.map(s => s.name)
  }, { timeout: 10000 }).toEqual([AUTO_ARCHIVE_NAME, PRESET_NAME])
  const autoAll = await readLocalUIState()
  const auto = ((autoAll.snapshots?.[projectId] || [])[0] || {}) as {
    editor?: { openFiles?: string[]; splitOpen?: boolean }
  }
  expect(auto.editor?.splitOpen).toBe(false)
  expect(auto.editor?.openFiles).toEqual(['README.md'])
})

test('未保存修改确认流出现：确认后主组整表换签', async ({ page }) => {
  await enterProject(page)
  await page.locator('.file-tree .item-name').filter({ hasText: 'README.md' }).first().click()
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })

  // 键入未保存内容（editor-draft-recovery 同款键入链）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// dirty for preset')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('dirty for preset')

  // 种子快照只有 src/util.ts：恢复应出确认流，确认后换签为 util.ts
  await seedSnapshots([fakeSnap('dirty-preset', {
    editor: { openFiles: ['src/util.ts'], activeFile: 'src/util.ts', splitOpen: false },
  })])

  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: 'dirty-preset' })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 确认流出现（未保存计数 > 0）→ 确认 → 主组整表换签
  const dlg = page.locator('.n-dialog').filter({ hasText: '未保存' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 10000 })
})

test('会话组结构恢复：仅写结构不自动拉起会话', async ({ page }) => {
  await enterProject(page)
  const before = await terminalCount()
  // 种子快照带 agent 会话组结构（成员为幽灵会话 id，不存在的会话不拉起）
  await seedSnapshots([fakeSnap('groups-preset', {
    agentGroups: [{ id: 'at_e2e_g1', name: 'e2e-排查组', sessionIds: ['ghost-session-1'] }],
  })])

  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: 'groups-preset' })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 恢复反馈：成功 toast + 会话组结构已恢复提示（MVP 边界告知不拉起会话）
  await expect(page.locator('.n-message').filter({ hasText: '会话组结构已恢复' })).toBeVisible({ timeout: 5000 })

  // 服务端 agentTerminal.groups 写入种子结构（结构描述原样，含幽灵成员）
  await expect.poll(async () => {
    const state = await readLocalUIState()
    return state.agentTerminal?.groups
  }, { timeout: 10000 }).toEqual([{ id: 'at_e2e_g1', name: 'e2e-排查组', sessionIds: ['ghost-session-1'] }])

  // 不自动拉起会话：终端会话表计数不变
  expect(await terminalCount()).toBe(before)
})

test('会话组恢复即时生效（P-20261004-79）：管理页挂着 → 恢复预设 → 侧栏组结构即时变化', async ({ page }) => {
  await enterProject(page)
  // 种子预设带会话组结构（幽灵成员，不拉起会话；与上例「仅写结构」同形）
  await seedSnapshots([fakeSnap('live-groups', {
    agentGroups: [{ id: 'at_e2e_live', name: 'e2e-即时生效组', sessionIds: ['ghost-live-1'] }],
  })])

  // 打开 docked 管理页并保持挂着（本用例全程不重载——重载即走 boot 旧边界，测不到广播链）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  // 恢复前组名不在侧栏（boot 读到的是空表）
  await expect(view.locator('.ats-group-name').filter({ hasText: 'e2e-即时生效组' })).toHaveCount(0)

  // 命令面板恢复预设（管理页全程挂着）
  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: 'live-groups' })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 即时生效：页面未重载，侧栏组头出现预设里的组结构（广播 → 监听重应用链）
  await expect(page.locator('.n-message').filter({ hasText: '会话组结构已恢复' })).toBeVisible({ timeout: 5000 })
  await expect(view.locator('.ats-group-name').filter({ hasText: 'e2e-即时生效组' })).toBeVisible({ timeout: 10000 })
})

test('行内改名：改名落盘 + 与他档重名拒绝', async ({ page }) => {
  await enterProject(page)
  await seedSnapshots([fakeSnap('arc-a'), fakeSnap('arc-b')])

  await runPaletteCommand(page, '恢复现场')
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-a' })).toBeVisible({ timeout: 5000 })

  // 改名 arc-a → arc-a-2：prompt 预填旧名，确认后行与服务端同步更新
  await page.locator('.wsnap-row').filter({ hasText: 'arc-a' }).locator('[data-testid="snapshot-rename-btn"]').click()
  const dlg = page.locator('.n-dialog').filter({ hasText: '重命名存档' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await expect(dlg.locator('input')).toHaveValue('arc-a')
  await dlg.locator('input').fill('arc-a-2')
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-a-2' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.wsnap-row').filter({ hasText: /^arc-a$/ })).toHaveCount(0)

  // 重名拒绝：arc-a-2 改成已有名 arc-b → 警告提示，服务端不变
  await page.locator('.wsnap-row').filter({ hasText: 'arc-a-2' }).locator('[data-testid="snapshot-rename-btn"]').click()
  const dlg2 = page.locator('.n-dialog').filter({ hasText: '重命名存档' })
  await expect(dlg2).toBeVisible({ timeout: 5000 })
  await dlg2.locator('input').fill('arc-b')
  await dlg2.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已有同名存档' })).toBeVisible({ timeout: 5000 })

  await expect.poll(async () => {
    const all = await readLocalUIState()
    const list = (all.snapshots?.[projectId] || []) as Array<{ name?: string }>
    return list.map(s => s.name).sort()
  }, { timeout: 10000 }).toEqual(['arc-a-2', 'arc-b'])
})

test('Ctrl+Alt+数字直达恢复（P-20261004-49）：弹层序号提示 + 一键恢复列表第 N 个', async ({ page }) => {
  await enterProject(page)
  // 种子两个预设（服务端表序 = 数组序 = 弹层序号 = 键号）：1 号只开 README、2 号只开 util.ts
  await seedSnapshots([
    fakeSnap('hk-one', { editor: { openFiles: ['README.md'], activeFile: 'README.md', splitOpen: false } }),
    fakeSnap('hk-two', { editor: { openFiles: ['src/util.ts'], activeFile: 'src/util.ts', splitOpen: false } }),
  ])
  // 布置现场：两个文件都在开（干净无未保存，无确认流），Ctrl+Alt+2 应整表换签为 hk-two
  await page.locator('.file-tree .item-name').filter({ hasText: 'README.md' }).first().click()
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })
  await page.locator('.file-tree .item-name').filter({ hasText: /^src$/ }).first().click()
  await page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' }).first().click({ timeout: 5000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 30000 })

  // 打开恢复弹层（预热直达键的门控计数）+ 断言行首序号徽标（1/2 = 键号，tooltip 承载键位提示）
  await runPaletteCommand(page, '恢复现场')
  const rowOne = page.locator('.wsnap-row').filter({ hasText: 'hk-one' })
  const rowTwo = page.locator('.wsnap-row').filter({ hasText: 'hk-two' })
  await expect(rowOne).toBeVisible({ timeout: 5000 })
  await expect(rowOne.locator('.wsnap-ordinal')).toHaveText('1')
  await expect(rowTwo.locator('.wsnap-ordinal')).toHaveText('2')
  await expect(rowOne.locator('.wsnap-ordinal')).toHaveAttribute('title', /Ctrl\+Alt\+1/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.workspace-snapshot-modal')).toBeHidden()

  // Ctrl+Alt+2 → 一键恢复第 2 个预设：主组只剩 util.ts（README 换签关闭）+ 成功反馈
  await page.keyboard.press('Control+Alt+2')
  await expect(page.locator('.n-message').filter({ hasText: 'hk-two' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toHaveCount(0)
})
