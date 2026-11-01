import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器保存冲突检测 E2E（P-20261002-7）：文件打开后磁盘被外部改写（agent 在
 * 终端里重写文件的等价通道——直接落盘，不经编辑器），用户带着陈旧基线保存 →
 * 服务端 409 → 三选对话框出现 → [与磁盘版本对比] 开并排 diff；另一条路径
 * [覆盖保存] 不带 baseHash 直写落盘，且保存后基线刷新（再存不误报）。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-conflict')
const PROJ = 'e2e-editor-conflict'
const FILE_COMPARE = 'conflict-compare.txt'
const FILE_OVERWRITE = 'conflict-overwrite.txt'
const BASELINE = 'conflict e2e baseline\n'
const MY_EDIT = 'my-unsaved-edit'
const AGENT_LINE = 'agent-rewrote-this-file'

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
  fs.writeFileSync(path.join(REPO_DIR, FILE_COMPARE), BASELINE)
  fs.writeFileSync(path.join(REPO_DIR, FILE_OVERWRITE), BASELINE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 编辑器冲突检测基线'])
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

/** 打开目标文件并确认内容可见 */
async function openFile(page: import('@playwright/test').Page, file: string) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: file }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('conflict e2e baseline', { timeout: 8000 })
}

/** 制造 agent 外部改写（直接落盘，与终端 sed 同通道）+ 编辑器键入脏修改。
 *  顺序即真实冲突时序：先打字（变脏，不参与干净自动重载）再外部写盘 */
async function makeConflict(page: import('@playwright/test').Page, file: string) {
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(MY_EDIT)
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(MY_EDIT)
  fs.writeFileSync(path.join(REPO_DIR, file), AGENT_LINE + '\n')
}

test('保存冲突：陈旧基线保存 → 409 三选对话框 → 与磁盘版本对比', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, FILE_COMPARE)

  await makeConflict(page, FILE_COMPARE)

  // 带陈旧基线保存 → 服务端 409 → 冲突对话框
  await page.keyboard.press('Control+s')
  const dialog = page.locator('.n-dialog').filter({ hasText: '文件已被外部修改' })
  await expect(dialog).toBeVisible({ timeout: 8000 })

  // 磁盘内容未被静默覆盖（冲突写必须被拒）
  expect(fs.readFileSync(path.join(REPO_DIR, FILE_COMPARE), 'utf8')).toBe(AGENT_LINE + '\n')

  // [与磁盘版本对比]：并排 diff（左 = 我的未保存内容，右 = 磁盘现内容）
  await dialog.locator('button').filter({ hasText: '与磁盘版本对比' }).click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.monaco-diff-editor')).toContainText(MY_EDIT, { timeout: 8000 })
  await expect(page.locator('.monaco-diff-editor')).toContainText(AGENT_LINE, { timeout: 8000 })

  // 切回原文件 tab：我的未保存内容不因对比丢失（脏标记仍在）
  // 注意用 aria-label 精确匹配——diff tab 名是「<name> (Diff)」，hasText 子串会双命中
  await page.locator('.editor-tab[aria-label="conflict-compare.txt"]').click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(MY_EDIT, { timeout: 8000 })
  await expect(page.locator('.editor-tab[aria-label="conflict-compare.txt"] .tab-dot')).toBeVisible()
})

test('保存冲突：覆盖保存直写落盘 → 基线刷新后再存不误报', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openFile(page, FILE_OVERWRITE)

  await makeConflict(page, FILE_OVERWRITE)

  await page.keyboard.press('Control+s')
  const dialog = page.locator('.n-dialog').filter({ hasText: '文件已被外部修改' })
  await expect(dialog).toBeVisible({ timeout: 8000 })

  // [覆盖保存]：不带 baseHash 重试，明确覆盖磁盘现内容
  await dialog.locator('button').filter({ hasText: '覆盖保存' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 5000 })
  await expect.poll(async () => fs.readFileSync(path.join(REPO_DIR, FILE_OVERWRITE), 'utf8'), { timeout: 5000 })
    .toContain(MY_EDIT)

  // 保存成功响应带回新 hash → 基线已刷新：再次保存（同内容）不弹冲突对话框。
  // 先点回编辑器恢复焦点——对话框按钮销毁后焦点在 body，Monaco 的 Ctrl+S
  // keybinding 不触发（第一次保存能触发是因为键入时焦点本就在编辑器）
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+s')
  await expect(page.locator('.n-dialog').filter({ hasText: '文件已被外部修改' })).toHaveCount(0, { timeout: 3000 })
  await expect(page.locator('.n-message').filter({ hasText: '文件已保存' })).toBeVisible({ timeout: 5000 })
})
