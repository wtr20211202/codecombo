import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 工作现场存档点 E2E（P-20261002-84）：命令面板「保存当前现场 / 恢复现场」——
 *   ① 存档（命名）→ 改动现场（关标签/收底栏/改宽度）→ 恢复 → 文件/面板就地还原
 *   ② 分支不同仅提示不强切（快照分支 ≠ 当前分支出提示，状态栏分支不变）
 *   ③ 存档列表管理最小版：列表 + 删除（confirm 后落盘）
 *   ④ 未保存修改一次性确认：确认后主组整表换签
 * 自备临时仓库（layout-reset 先例），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-workspace-snapshot')
const PROJ = 'e2e-workspace-snapshot'
const SNAP_NAME = 'e2e-arc-1'
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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'workspace snapshot baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'util.ts'), 'export const x = 1\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 现场存档基线'])
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

/** 读服务端 ui-state 的 snapshots 命名空间（projectId 键控） */
async function readServerSnapshots(): Promise<Record<string, Array<Record<string, unknown>>>> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as {
    data?: { local?: { snapshots?: Record<string, Array<Record<string, unknown>>> } }
  }
  return body.data?.local?.snapshots || {}
}

/** API 直播快照（分支差异/删除用例的种子；服务端按命名空间浅合并，其余原样保留） */
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
    name,
    savedAt: Date.now(),
    branch: '',
    editor: { openFiles: [] as string[], activeFile: '' },
    layout: {
      sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true,
      showBottomPanel: false, sideView: 'files', bottomTab: 'git',
    },
    fileTree: { expandedDirs: [] },
    ...overrides,
  }
}

/** 进入项目页并保证文件树可见（rail 按钮是 toggle，先保证面板可见）。
 *  每个用例先清 uiState 再 reload：前序用例/重试残留的快照会与本用例的
 *  存档/恢复断言竞态——清空后进入，行为只由本用例的驱动决定 */
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
 *  让焦点移出 Monaco（editor-reopen-tab 同款）；无标签时无 Monaco，直接按键 */
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

test('保存当前现场 → 改动现场 → 恢复：文件/面板/宽度就地还原', async ({ page }) => {
  await enterProject(page)
  // 布置现场：开两个标签（README + src 展开后的 util.ts）+ 底栏终端 + 侧栏拖窄
  await page.locator('.file-tree .item-name').filter({ hasText: 'README.md' }).first().click()
  await page.locator('.file-tree .item-name').filter({ hasText: /^src$/ }).first().click()
  await page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' }).first().click({ timeout: 5000 })
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible()
  await page.locator('[data-testid="rail-terminal"]').click()
  await expect(page.locator('.bottom-panel')).toBeVisible()
  await dragSidebarTo180(page)

  // 命令面板「保存当前现场」→ 命名存档
  await runPaletteCommand(page, '保存当前现场')
  const dlg = page.locator('.n-dialog')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('input').fill(SNAP_NAME)
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: SNAP_NAME })).toBeVisible({ timeout: 5000 })

  // 服务端快照落盘：清单/底栏开合/宽度按当前现场捕获
  await expect.poll(async () => {
    const all = await readServerSnapshots()
    const list = (all[projectId] || []) as Array<{ name?: string; editor?: { openFiles?: string[] }; layout?: { showBottomPanel?: boolean; sidePanelWidth?: number } }>
    const snap = list.find(s => s.name === SNAP_NAME)
    return snap && snap.editor?.openFiles?.includes('README.md')
      && snap.editor?.openFiles?.includes('src/util.ts')
      && snap.layout?.showBottomPanel === true
      && snap.layout?.sidePanelWidth === 180
  }, { timeout: 10000 }).toBeTruthy()

  // 改动现场：关掉 util.ts 标签 + 收起底栏 + 宽度拖回 280（180 + 100 精确落点）
  await page.locator('.editor-tab', { hasText: 'util.ts' }).locator('.tab-close').click()
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

  // 无刷新标记：恢复后标记仍在 = 就地应用（不走页面重载）
  await page.evaluate(() => { (window as unknown as { __e2eNoReload?: number }).__e2eNoReload = 1 })

  // 命令面板「恢复现场」→ 列表行内「恢复」
  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: SNAP_NAME })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 就地还原：两个标签重开 / 底栏复开 / 宽度回 180 / 未发生页面重载
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.bottom-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180), { timeout: 5000 })
  const marker = await page.evaluate(() => (window as unknown as { __e2eNoReload?: number }).__e2eNoReload)
  expect(marker).toBe(1)
})

test('分支不同仅提示不强切：恢复后出提示，当前分支不变', async ({ page }) => {
  await enterProject(page)
  // 种子快照带幽灵分支名（不做真实 checkout，避免依赖默认分支名与外部改仓竞态）
  await seedSnapshots([fakeSnap('ghost-arc', { branch: 'feature/ghost' })])

  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: 'ghost-arc' })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 仅提示：警告 toast 点名存档分支；状态栏分支不含幽灵分支（未强切）
  await expect(page.locator('.n-message').filter({ hasText: 'feature/ghost' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.statusbar-branch')).not.toContainText('feature/ghost')
})

test('存档列表管理：列表展示 + 删除（confirm 后落盘）', async ({ page }) => {
  await enterProject(page)
  await seedSnapshots([fakeSnap('arc-a'), fakeSnap('arc-b')])

  await runPaletteCommand(page, '恢复现场')
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-a' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-b' })).toBeVisible()

  // 删除 arc-a：confirm 弹窗确认后行消失
  await page.locator('.wsnap-row').filter({ hasText: 'arc-a' }).locator('[data-testid="snapshot-delete-btn"]').click()
  const dlg = page.locator('.n-dialog').filter({ hasText: 'arc-a' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-a' })).toHaveCount(0)
  await expect(page.locator('.wsnap-row').filter({ hasText: 'arc-b' })).toBeVisible()

  // 服务端落盘：快照表只剩 arc-b
  await expect.poll(async () => {
    const all = await readServerSnapshots()
    const list = (all[projectId] || []) as Array<{ name?: string }>
    return list.map(s => s.name)
  }, { timeout: 10000 }).toEqual(['arc-b'])
})

test('未保存修改一次性确认：确认后主组整表换签', async ({ page }) => {
  await enterProject(page)
  await page.locator('.file-tree .item-name').filter({ hasText: 'README.md' }).first().click()
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })

  // 键入未保存内容（editor-draft-recovery 同款键入链）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('// dirty for snapshot')
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('dirty for snapshot')

  // 种子快照只有 src/util.ts：恢复应关掉 README 换签为 util.ts
  await seedSnapshots([fakeSnap('dirty-arc', {
    editor: { openFiles: ['src/util.ts'], activeFile: 'src/util.ts' },
  })])

  await runPaletteCommand(page, '恢复现场')
  const row = page.locator('.wsnap-row').filter({ hasText: 'dirty-arc' })
  await expect(row).toBeVisible({ timeout: 5000 })
  await row.locator('[data-testid="snapshot-restore-btn"]').click()

  // 一次性确认弹窗（未保存计数 > 0）→ 确认 → 主组整表换签
  const dlg = page.locator('.n-dialog').filter({ hasText: '未保存' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toHaveCount(0, { timeout: 10000 })
  await expect(page.locator('.editor-tab', { hasText: 'util.ts' })).toBeVisible({ timeout: 10000 })
})
