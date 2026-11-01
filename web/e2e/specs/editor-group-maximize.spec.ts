import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器组临时最大化 E2E（P-20261004-64）：对照工作流的临时聚焦——
 *   ① 双击组 tab 条空白区 → 该组暂占编辑器区全宽（兄弟组 v-show 隐藏，
 *      Monaco 实例保活，边缘弱提示 is-group-maximized）
 *   ② Esc → 双组还原，两文件内容状态不丢（组 0 编辑中的未保存文本 /
 *      组 1 文件内容原样）
 *   ③ 再双击同款路径还原（toggle 语义对称）
 *   ④ 命令面板「最大化当前组」同款动作（无分屏时 no-op 不报错）
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-group-max')
const PROJ = 'e2e-editor-group-max'
const FILES = [
  { name: 'gmax-a.txt', content: 'group maximize alpha content' },
  { name: 'gmax-b.txt', content: 'group maximize beta content' },
]

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
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 组最大化基线'])
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

/** 打开项目 + 文件树打开两文件（幂等），并在右侧分屏打开 b（双组对照基线） */
async function openProjectWithSplit(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  for (const f of FILES) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toBeVisible()
  // 若上次会话恢复出分屏，先一键关闭归到单组（幂等基线）
  if (await page.locator('.pane-split').isVisible().catch(() => false)) {
    const emptyClose = page.locator('.split-empty-close')
    if (await emptyClose.isVisible().catch(() => false)) {
      await emptyClose.click()
    } else {
      await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
      await page.getByRole('menuitem', { name: '关闭分屏' }).click()
    }
    await expect(page.locator('.pane-split')).toHaveCount(0)
  }
  // 右键 b → 在右侧分屏打开：双组对照基线
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
}

/** 双击组 tab 条空白区（右缘 40px 内，避开 tab 本身——tab 双击是固定标签语义） */
async function dblclickTabsEmptyArea(page: import('@playwright/test').Page, paneClass: string) {
  const tabs = page.locator(`.${paneClass} .editor-tabs`)
  const box = await tabs.boundingBox()
  expect(box).not.toBeNull()
  await tabs.dblclick({ position: { x: box!.width - 20, y: box!.height / 2 } })
}

test('双击组 tab 条最大化 → Esc 还原，双组内容状态不丢', async ({ page }) => {
  await openProjectWithSplit(page)

  // 组 0 编辑器内追加未保存文本（对照「状态不丢」的编辑中内容）
  await page.locator('.pane-primary .monaco-editor .view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('MAX-MARK')
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('MAX-MARK')

  // 双击组 0 tab 条空白区 → 组 0 暂占全宽：组 1 v-show 隐藏（保活不卸载）、
  // 组 0 挂边缘弱提示
  await dblclickTabsEmptyArea(page, 'pane-primary')
  await expect(page.locator('.pane-primary')).toHaveClass(/is-group-maximized/)
  await expect(page.locator('.pane-split')).not.toBeVisible()
  // 最大化期间组 0 内容原样（编辑器实例未重建，未保存文本仍在）
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('MAX-MARK')

  // Esc → 双组还原：弱提示消失、组 1 回位且内容原样（Monaco 未重建）
  await page.keyboard.press('Escape')
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-primary')).not.toHaveClass(/is-group-maximized/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('MAX-MARK')

  // 还原后编辑中的未保存文本仍可继续编辑（分屏结构未受最大化往返影响）
  await page.locator('.pane-primary .monaco-editor .view-lines').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.type('-OK')
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('MAX-MARK-OK')
})

test('再双击还原（toggle 对称）+ 命令面板入口', async ({ page }) => {
  await openProjectWithSplit(page)

  // 双击组 0 tab 条 → 最大化；再双击 → 还原（同一路径 toggle）
  await dblclickTabsEmptyArea(page, 'pane-primary')
  await expect(page.locator('.pane-primary')).toHaveClass(/is-group-maximized/)
  await expect(page.locator('.pane-split')).not.toBeVisible()
  await dblclickTabsEmptyArea(page, 'pane-primary')
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-primary')).not.toHaveClass(/is-group-maximized/)

  // 命令面板入口（Ctrl+K → `>` 命令模式）：最大化当前编辑器组。
  // 先点分屏组标签取活跃组（前序双击 mousedown 已把活跃组切回组 0；点标签
  // 而非编辑器正文——Monaco 聚焦时会吞 Ctrl+K 起弦键，命令面板打不开）
  await page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name }).click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>最大化当前编辑器组')
  const item = page.locator('.palette-item').filter({ hasText: '最大化当前编辑器组' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()
  // 活跃组 = 分屏组 b（分屏打开时切活跃组）→ 最大化的是组 1
  await expect(page.locator('.pane-split')).toHaveClass(/is-group-maximized/)
  await expect(page.locator('.pane-primary')).not.toBeVisible()
  // Esc 还原
  await page.keyboard.press('Escape')
  await expect(page.locator('.pane-primary')).toBeVisible()
  await expect(page.locator('.pane-split')).not.toHaveClass(/is-group-maximized/)

  // 组 0 内容状态在组 1 最大化往返中原样保留（组 0 活跃签 = b，后开者居活跃位；
  // b 为共享对象，两组同文各一实例，内容一致即状态未串位）
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
})
