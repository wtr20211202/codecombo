import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器域键位自定义 E2E（P-20261008-14 键位自定义收口编辑器域）：
 *   ① 主链：设置→快捷键改绑编辑器书签键（editorBookmarkToggle Ctrl+Alt+B →
 *      Ctrl+Alt+J）→ 编辑器内新键触发书签 toggle、旧键不再触发 → 备忘单编辑器
 *      组动态行显示新键 → 刷新持久 → 恢复默认回归（无冲突组合直接保存）
 *   ② 保存键改绑 + 跨域共存警示：editorSave Ctrl+S → Ctrl+Alt+K 撞终端域书签
 *      列表默认键 → 焦点域共存警示（编辑器聚焦时编辑器侧优先）→ 确认落盘后
 *      编辑器内新键触发保存（磁盘生效）、旧键 Ctrl+S 不再保存
 * 设置→快捷键按域分组（全局布局 / 终端 / 编辑器）随用例断言。键位自定义本体在
 * localStorage（随浏览器上下文隔离，无跨用例串扰）；书签落 uiState（服务端），
 * afterAll 清理不留跨 spec 残留。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-keymap-editor')
const PROJ = 'e2e-keymap-editor'
const FILE = 'km-editor.txt'
const ORIGINAL = Array.from({ length: 40 }, (_, i) => `// keymap editor fixture line ${i + 1}`).join('\n') + '\n'

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, FILE), ORIGINAL)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 编辑器域键位 e2e 基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进项目并打开 fixture 文件（文件树点击 → 编辑器 tab 就位） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('fixture line 2', { timeout: 8000 })
}

/** 点击编辑器文本区中央落焦点（键位触发前提：Monaco 聚焦域） */
async function focusEditor(page: import('@playwright/test').Page) {
  await page.locator('.pane-primary .monaco-editor').click({ position: { x: 300, y: 160 } })
  await expect(page.locator('.pane-primary .monaco-editor')).toBeVisible()
}

async function openKeymapSettings(page: import('@playwright/test').Page) {
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '快捷键' }).click()
  await expect(page.locator('[data-testid="keymap-list"]')).toBeVisible()
}

async function closeSettings(page: import('@playwright/test').Page) {
  await page.locator('.settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toHaveCount(0)
}

/** 刷新后停留在项目视图并恢复文件签（uiState 引导恢复） */
async function reloadIntoProject(page: import('@playwright/test').Page) {
  await page.reload()
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click().catch(() => { /* 已在项目视图 */ })
  await page.waitForURL('**/project')
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText('fixture line 2', { timeout: 10000 })
}

/** 键位冲突警示弹窗：标题过滤，避免误中其他弹窗 */
function conflictDialog(page: import('@playwright/test').Page) {
  return page.locator('.n-dialog').filter({ hasText: '键位冲突警示' })
}

test('改绑编辑器书签键 Ctrl+Alt+B → Ctrl+Alt+J：新键触发旧键失效，备忘单跟随，刷新持久，恢复默认回归', async ({ page }) => {
  await openProjectAndFile(page)

  // 基线：默认键 Ctrl+Alt+B 光标行加/删书签（编辑器聚焦域，gutter 图标随装饰出现）
  await focusEditor(page)
  await page.keyboard.press('Control+Alt+b')
  const glyph = page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph').first()
  await expect(glyph).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+Alt+b')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)

  await openKeymapSettings(page)

  // 域分组（P-20261008-14）：编辑器组在列，三行编辑器域动作默认键位展示
  await expect(page.locator('[data-testid="keymap-group-editor"]')).toContainText('编辑器')
  await expect(page.locator('[data-testid="keymap-row-editorSave"]')).toBeVisible()
  await expect(page.locator('[data-testid="keymap-row-editorBookmarkToggle"]')).toBeVisible()
  await expect(page.locator('[data-testid="keymap-row-editorInlineEdit"]')).toBeVisible()
  const combo = page.locator('[data-testid="keymap-combo-editorBookmarkToggle"]')
  await expect(combo).toContainText('B')

  // 录入新键：无冲突组合直接保存，不弹冲突警示
  await page.locator('[data-testid="keymap-change-editorBookmarkToggle"]').click()
  await expect(combo).toContainText('按下新组合键')
  await page.keyboard.press('Control+Alt+j')
  await expect(conflictDialog(page)).toHaveCount(0)
  await expect(combo).toContainText('J')
  await expect(page.locator('[data-testid="keymap-custom-editorBookmarkToggle"]')).toContainText('自定义')

  // 备忘单（?）编辑器组动态行跟随自定义值（closeSettings 后焦点在按钮上，非输入面）
  await closeSettings(page)
  await page.keyboard.press('?')
  const help = page.locator('.sc-help')
  await expect(help).toBeVisible({ timeout: 3000 })
  await page.locator('.sc-help-filter input').fill('切换书签')
  const helpRow = page.locator('.sc-help-row').filter({ hasText: '切换书签' }).first()
  await expect(helpRow).toBeVisible()
  await expect(helpRow).toContainText('J')
  await expect(helpRow).not.toContainText('B')
  await help.locator('.sc-help-close').click()
  await expect(help).toHaveCount(0)

  // 旧键失效：Ctrl+Alt+B 不再加书签；新键触发（再按移除，toggle 语义）
  await focusEditor(page)
  await page.keyboard.press('Control+Alt+b')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+j')
  await expect(glyph).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+Alt+j')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)

  // 刷新后覆盖持久（localStorage）：新键照常触发
  await reloadIntoProject(page)
  await focusEditor(page)
  await page.keyboard.press('Control+Alt+j')
  await expect(glyph).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+Alt+j')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)

  // 恢复默认：原键回归、自定义徽标消失
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-editorBookmarkToggle"]').click()
  await expect(combo).toContainText('B')
  await expect(page.locator('[data-testid="keymap-custom-editorBookmarkToggle"]')).not.toContainText('自定义')
  await closeSettings(page)
  await focusEditor(page)
  await page.keyboard.press('Control+Alt+j')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)
  await page.keyboard.press('Control+Alt+b')
  await expect(glyph).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Control+Alt+b')
  await expect(page.locator('.pane-primary .monaco-editor .sc-bookmark-glyph')).toHaveCount(0)
})

test('保存键改绑 Ctrl+S → Ctrl+Alt+K：撞终端域键焦点域共存警示，编辑器内新键保存磁盘生效、旧键不再保存', async ({ page }) => {
  await openProjectAndFile(page)
  await focusEditor(page)

  await openKeymapSettings(page)

  // editorSave 改绑到 Ctrl+Alt+K（终端域书签列表 doc 级默认键）：跨域警示——
  // 焦点域共存语义（编辑器聚焦时编辑器侧优先，其余场景对方生效）
  const combo = page.locator('[data-testid="keymap-combo-editorSave"]')
  await page.locator('[data-testid="keymap-change-editorSave"]').click()
  await page.keyboard.press('Control+Alt+k')
  const dlg = conflictDialog(page)
  await expect(dlg).toBeVisible()
  await expect(dlg).toContainText('开关终端书签列表')
  await expect(dlg).toContainText('编辑器聚焦')
  await dlg.locator('.n-dialog__action button').filter({ hasText: '仍要保存' }).click()
  await expect(combo).toContainText('K')
  await closeSettings(page)

  // 编辑器内新键触发保存：键入新行 → Ctrl+Alt+K → 磁盘生效（重注册后的
  // save-file 走既有 formatThenSave 链，格式化开关默认关即直接上抛 save）
  await focusEditor(page)
  await page.keyboard.press('Control+End')
  await page.keyboard.type('appended-by-new-save-key\n')
  await page.keyboard.press('Control+Alt+k')
  await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8'), { timeout: 8000 })
    .toContain('appended-by-new-save-key')

  // 旧键 Ctrl+S 不再触发保存（编辑器域动作已迁走，Monaco 内建无保存绑定）：
  // 再键入一行按 Ctrl+S，磁盘内容保持
  await page.keyboard.type('not-saved-by-old-key\n')
  await page.keyboard.press('Control+s')
  await page.waitForTimeout(1200)
  const onDisk = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(onDisk).not.toContain('not-saved-by-old-key')

  // 恢复默认：Ctrl+S 回归（编辑器内旧键重新落盘）
  await openKeymapSettings(page)
  await page.locator('[data-testid="keymap-reset-editorSave"]').click()
  await expect(combo).toContainText('S')
  await closeSettings(page)
  await focusEditor(page)
  await page.keyboard.press('Control+s')
  await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8'), { timeout: 8000 })
    .toContain('not-saved-by-old-key')
})
