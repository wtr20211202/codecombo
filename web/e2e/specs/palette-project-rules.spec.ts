import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 命令面板规则文件直达 E2E（P-20261006-43）：
 *   1. 「项目规则管理」命令 → 设置弹窗切通用分区并滚动定位 ProjectRulesManager
 *      区块（行级闪烁），四步穿层缩为一击
 *   2. 搜「规则」四个命令齐出（区块直达 + 按清单展开的三条文件级命令）——
 *      palette 本身即键盘面，命令选中即达
 *   3. 「编辑 CLAUDE.md」已存在 → 文件深链进编辑器（不经设置弹窗/确认）
 *   4. 「编辑 AGENTS.md」缺失 → 确认后从模板创建并进编辑器，模板内容落盘
 *   5. 「编辑 .cursorrules」缺失 → 取消确认不创建不打开
 * 自备临时仓库（CLAUDE.md 预置已存在、AGENTS.md/.cursorrules 缺失），
 * afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-palette-project-rules')
const PROJ_NAME = 'e2e-palette-project-rules'
const CLAUDE_BASELINE = '# CLAUDE.md\n\ne2e CLAUDE baseline for palette direct edit\n'

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await fetch(`${API_BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['config', 'commit.gpgsign', 'false'])
  fs.writeFileSync(path.join(REPO_DIR, 'app.ts'), 'export const a = 1\n')
  // CLAUDE.md 预先存在：「编辑命令存在分支」的锚点文件；AGENTS.md/.cursorrules 缺失
  fs.writeFileSync(path.join(REPO_DIR, 'CLAUDE.md'), CLAUDE_BASELINE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: seed'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
})

/** 进项目页 → 呼出命令面板（Ctrl+K），返回面板输入框 */
async function gotoProjectAndOpenPalette(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起（palette-template 同款防御）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  return input
}

test('「项目规则管理」命令 → 设置弹窗切通用分区并滚动定位规则区块 + 闪烁', async ({ page }) => {
  const input = await gotoProjectAndOpenPalette(page)
  await input.fill('>项目规则')
  const item = page.locator('.palette-item').filter({ hasText: '项目规则管理' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 设置弹窗打开且已切通用分区（不经左栏手点）
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 5000 })
  await expect(page.getByTestId('settings-nav-general')).toHaveClass(/active/)

  // 区块锚定：ProjectRulesManager 区块滚入视口 + 行级闪烁（~2s 自动褪去）
  const block = page.getByTestId('settings-project-rules')
  await expect(block).toBeInViewport({ timeout: 5000 })
  await expect(block).toHaveClass(/anchor-flash/, { timeout: 5000 })
})

test('搜「规则」：区块直达 + 按清单展开的三条文件级命令齐出', async ({ page }) => {
  const input = await gotoProjectAndOpenPalette(page)
  await input.fill('>规则')
  // projectRuleTemplates 清单单一事实源：三条文件命令与区块直达同表可搜
  await expect(page.locator('.palette-item').filter({ hasText: '项目规则管理' })).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.palette-item').filter({ hasText: '编辑 CLAUDE.md' })).toBeVisible()
  await expect(page.locator('.palette-item').filter({ hasText: '编辑 AGENTS.md' })).toBeVisible()
  await expect(page.locator('.palette-item').filter({ hasText: '编辑 .cursorrules' })).toBeVisible()
})

test('「编辑 CLAUDE.md」已存在 → 文件深链进编辑器（零弹窗零确认）', async ({ page }) => {
  const input = await gotoProjectAndOpenPalette(page)
  await input.fill('>编辑 CLAUDE.md')
  const item = page.locator('.palette-item').filter({ hasText: '编辑 CLAUDE.md' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 不经设置弹窗也不经确认对话框：深链直接开编辑器，预置基线内容可见
  await expect(page.locator('.n-modal.settings-modal')).toHaveCount(0)
  await expect(page.locator('.n-dialog')).toHaveCount(0)
  const editor = page.locator('.monaco-editor .view-lines')
  await expect(editor).toContainText('e2e CLAUDE baseline for palette direct edit', { timeout: 10000 })
})

test('「编辑 AGENTS.md」缺失 → 确认 → 模板创建并进编辑器，内容落盘', async ({ page }) => {
  const input = await gotoProjectAndOpenPalette(page)
  await input.fill('>编辑 AGENTS.md')
  const item = page.locator('.palette-item').filter({ hasText: '编辑 AGENTS.md' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 缺失 → 确认对话框（naive discrete dialog，非 window.confirm）
  const dlg = page.locator('.n-dialog').filter({ hasText: 'AGENTS.md 不存在' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()

  // 模板内容真实落盘（非空、以 AGENTS.md 标题开头）且编辑器打开该文件
  await expect.poll(() => fs.existsSync(path.join(REPO_DIR, 'AGENTS.md'))
    ? fs.readFileSync(path.join(REPO_DIR, 'AGENTS.md'), 'utf8')
    : '', { timeout: 8000 }).toMatch(/^# AGENTS\.md/)
  const editor = page.locator('.monaco-editor .view-lines')
  await expect(editor).toContainText('# AGENTS.md', { timeout: 10000 })
})

test('「编辑 .cursorrules」缺失 → 取消确认：不创建不打开', async ({ page }) => {
  const input = await gotoProjectAndOpenPalette(page)
  await input.fill('>编辑 .cursorrules')
  const item = page.locator('.palette-item').filter({ hasText: '编辑 .cursorrules' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  const dlg = page.locator('.n-dialog').filter({ hasText: '.cursorrules 不存在' })
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()

  // 取消：对话框收起、文件不落盘、编辑器不打开该文件
  await expect(page.locator('.n-dialog')).toHaveCount(0, { timeout: 5000 })
  expect(fs.existsSync(path.join(REPO_DIR, '.cursorrules'))).toBe(false)
  await expect(page.locator('.editor-tab').filter({ hasText: '.cursorrules' })).toHaveCount(0)
})
