import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 一键重置布局 E2E（P-20261002-74）：命令面板 / 设置外观区两个入口的
 * 「重置当前项目布局」，confirm 后不刷新页面就地复位——
 *   ① 调乱的布局（侧栏拖窄 + 底栏终端面板打开 + 文件树目录展开）一键回出厂默认
 *   ② 服务端 uiState layout/fileTree 命名空间写回默认，编辑器标签等其他命名空间保留
 *   ③ 外观区按钮入口同链路；confirm 取消不生效
 * 自备临时仓库（含子目录供树展开断言），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-layout-reset')
const PROJ = 'e2e-layout-reset'
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
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'deep'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'layout reset baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'util.ts'), 'export const x = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'deep', 'leaf.ts'), 'export const y = 2\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 布局重置基线'])
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

/** 进入项目页并保证文件树可见（rail 按钮是 toggle，先保证面板可见）。
 *  每个用例先清 uiState 再 reload：前序用例/重试残留的恢复流会与本用例的
 *  布局断言竞态——清空后进入，行为只由本用例的驱动决定 */
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

/** 调乱布局：侧栏拖窄（280→180）+ 底栏终端面板打开 + 树展开 src（子级可见） */
async function messUpLayout(page: import('@playwright/test').Page): Promise<void> {
  // 1. 侧栏拖窄：SidePanel 钳位 [180, 500]，向左拖 120px 触发下限
  const resizer = page.locator('.ide-side-resizer')
  const box = await resizer.boundingBox()
  await page.mouse.move(box!.x + box!.width / 2, box!.y + 200)
  await page.mouse.down()
  await page.mouse.move(box!.x + box!.width / 2 - 120, box!.y + 200, { steps: 5 })
  await page.mouse.up()
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180))

  // 2. 底栏终端面板打开（rail 终端钮）
  await page.locator('[data-testid="rail-terminal"]').click()
  await expect(page.locator('.bottom-panel')).toBeVisible()

  // 3. 树展开 src 目录（子级出现在列表）
  await page.locator('.file-tree .item-name').filter({ hasText: /^src$/ }).first().click()
  await expect(page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' })).toBeVisible({ timeout: 5000 })
}

/** 打开一个文件并轮询服务端 editor 命名空间落盘（后续断言重置不波及编辑器标签） */
async function openFileAndAwaitPersist(page: import('@playwright/test').Page, fileName: string) {
  await page.locator('.file-tree .item-name').filter({ hasText: fileName }).first().click()
  await expect(page.locator('.editor-tab', { hasText: fileName })).toBeVisible({ timeout: 30000 })
  const headers = await unlockHeaders()
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
      const body = (await res.json()) as { data?: { local?: { editor?: { openFiles?: string[] } } } }
      if (body.data?.local?.editor?.openFiles?.includes(fileName)) return
    } catch { /* 轮询重试 */ }
    await page.waitForTimeout(500)
  }
}

test('命令面板重置：调乱面板/宽度/树展开 → 命令确认 → 就地复位且服务端写回默认', async ({ page }) => {
  await enterProject(page)
  // 先开一个文件（固定 tab）：断言重置不波及编辑器命名空间（内容非布局）
  await openFileAndAwaitPersist(page, 'README.md')

  await messUpLayout(page)

  // 无刷新标记：重置后标记仍在 = 未发生页面重载（就地应用）
  await page.evaluate(() => { (window as unknown as { __e2eNoReload?: number }).__e2eNoReload = 1 })

  // 命令面板 → 重置命令 → confirm 弹窗确认
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>重置当前项目布局')
  const item = page.locator('.palette-item').filter({ hasText: '重置当前项目布局' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  await expect(page.getByText('确定要将当前项目的布局恢复为出厂默认吗', { exact: false })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '确认', exact: true }).click()

  // 就地复位（不刷新页面）：宽度回默认 / 底栏收起 / 树子级收起 / 标记仍在
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280), { timeout: 5000 })
  await expect(page.locator('.bottom-panel')).toBeHidden()
  await expect(page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' })).toHaveCount(0)
  await expect(page.locator('.file-tree .item-name')).toHaveCount(2) // README.md + src（deep 在 src 内未展开不可见）
  await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible()
  const marker = await page.evaluate(() => (window as unknown as { __e2eNoReload?: number }).__e2eNoReload)
  expect(marker).toBe(1)

  // 服务端写回出厂默认：layout/fileTree 命名空间归位（轮询至落地或超时判负）
  const headers = await unlockHeaders()
  const deadline = Date.now() + 10000
  let layout: Record<string, unknown> | undefined
  let expandedDirs: string[] | undefined
  while (Date.now() < deadline) {
    const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
    const body = (await res.json()) as {
      data?: { local?: { layout?: Record<string, unknown>; fileTree?: { expandedDirs?: string[] } } }
    }
    layout = body.data?.local?.layout
    expandedDirs = body.data?.local?.fileTree?.expandedDirs
    if (layout?.sidePanelWidth === 280 && layout?.showBottomPanel === false
      && layout?.sideView === 'files' && expandedDirs?.length === 0) break
    await page.waitForTimeout(500)
  }
  expect(layout, `layout 未写回默认: ${JSON.stringify(layout)}`).toMatchObject({
    sidePanelWidth: 280, bottomPanelHeight: 260, showSidePanel: true, showBottomPanel: false, sideView: 'files',
  })
  expect(expandedDirs).toEqual([])
  const final = await (await fetch(`${API_BASE}/api/ui-state`, { headers })).json() as {
    data?: { local?: { editor?: { openFiles?: string[] }; fileTree?: { expandedDirs?: string[] } } }
  }
  expect(final.data?.local?.editor?.openFiles).toContain('README.md')
  expect(final.data?.local?.fileTree?.expandedDirs).toEqual([])

  // localStorage 展开键清除：刷新后树不再恢复展开（键值为空表或已移除）
  const saved = await page.evaluate((pid) => localStorage.getItem(`sc.fileTree.expanded.${pid}`), projectId)
  expect(saved === null || saved === '[]').toBeTruthy()
})

test('设置外观区按钮入口同链路；confirm 取消不生效', async ({ page }) => {
  await enterProject(page)
  await messUpLayout(page)

  // 打开设置 → 外观分区（导航序：通用/外观/终端/Git…，settings-unsaved 同口径）
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const resetBtn = page.getByRole('button', { name: '重置当前项目布局' })
  await expect(resetBtn).toBeVisible()

  // 取消：布局保持调乱态
  await resetBtn.click()
  await expect(page.getByText('确定要将当前项目的布局恢复为出厂默认吗', { exact: false })).toBeVisible({ timeout: 5000 })
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180))
  await expect(page.locator('.bottom-panel')).toBeVisible()

  // 确认：就地复位（设置弹窗开着也能看到背后的面板变化）
  await resetBtn.click()
  await page.getByRole('button', { name: '确认', exact: true }).click()
  await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280), { timeout: 5000 })
  await expect(page.locator('.bottom-panel')).toBeHidden()
  await expect(page.locator('.file-tree .item-name').filter({ hasText: 'util.ts' })).toHaveCount(0)
})
