import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目规则文件管理 E2E（P-20261003-181）：设置 → 通用 → 项目规则区块。
 *   1. 无规则 → 「从模板创建」→ 列表翻转为已存在，模板内容落盘
 *   2. 已存在文件直列（AGENTS.md 预先落在仓库里，不创建直接「已存在」），
 *      点击行经文件深链进编辑器，编辑 + Ctrl+S 保存落盘生效
 * 自备临时仓库，afterAll 清理项目与夹具
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-project-rules')
const PROJ_NAME = 'e2e-project-rules'
// 预置 AGENTS.md（已存在直列的锚点文件），内容带可断言的基线标记
const AGENTS_BASELINE = '# AGENTS.md\n\ne2e baseline for project rules\n'
const EDIT_MARKER = 'e2e edited via project rules panel'

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
  // AGENTS.md 预先存在：「已存在直列」分支（未经模板创建）
  fs.writeFileSync(path.join(REPO_DIR, 'AGENTS.md'), AGENTS_BASELINE)
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

/** 进项目页 → 打开设置 → 通用分区 → 项目规则区块 */
async function gotoRulesBlock(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-general"]').click()
  const block = page.locator('[data-testid="settings-project-rules"]')
  await expect(block).toBeVisible({ timeout: 5000 })
  return block
}

test('无规则 → 从模板创建 → 列表翻转已存在且模板内容落盘', async ({ page }) => {
  const block = await gotoRulesBlock(page)

  // 扫描初态：CLAUDE.md/.cursorrules 未创建，AGENTS.md 已存在直列（未经创建链）
  const claudeRow = block.locator('[data-testid="project-rules-row-CLAUDE.md"]')
  const agentsRow = block.locator('[data-testid="project-rules-row-AGENTS.md"]')
  await expect(claudeRow).toContainText('未创建', { timeout: 5000 })
  await expect(agentsRow).toContainText('已存在', { timeout: 5000 })
  expect(fs.existsSync(path.join(REPO_DIR, 'CLAUDE.md'))).toBe(false)

  // 从模板创建：按钮 → 成功提示 → 行翻转「已存在」
  await claudeRow.locator('[data-testid="project-rules-create"]').click()
  await expect(claudeRow).toContainText('已存在', { timeout: 5000 })

  // 模板内容真实落盘（非空文件、以 CLAUDE.md 标题开头）
  const disk = fs.readFileSync(path.join(REPO_DIR, 'CLAUDE.md'), 'utf8')
  expect(disk.startsWith('# CLAUDE.md')).toBe(true)

  // 面板行不重复堆叠：三行清单恒定
  await expect(block.locator('[data-testid^="project-rules-row-"]')).toHaveCount(3)
})

test('已存在直列 → 点击行深链进编辑器 → 编辑保存落盘生效', async ({ page }) => {
  const block = await gotoRulesBlock(page)
  const agentsRow = block.locator('[data-testid="project-rules-row-AGENTS.md"]')
  await expect(agentsRow).toContainText('已存在', { timeout: 5000 })

  // 点击已存在行：设置弹窗收起，编辑器经文件深链打开 AGENTS.md
  await agentsRow.click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  const editor = page.locator('.monaco-editor .view-lines')
  await expect(editor).toContainText('e2e baseline for project rules', { timeout: 10000 })

  // 编辑 + Ctrl+S 保存（默认 off 档不自动保存）：磁盘生效
  await page.locator('.monaco-editor').click()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('Enter')
  await page.keyboard.type(EDIT_MARKER)
  await page.keyboard.press('Control+s')
  await expect.poll(() => fs.readFileSync(path.join(REPO_DIR, 'AGENTS.md'), 'utf8'), { timeout: 8000 })
    .toContain(EDIT_MARKER)
})
