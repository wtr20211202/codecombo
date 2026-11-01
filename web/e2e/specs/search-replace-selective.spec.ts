import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 搜索替换的文件级选择性 E2E（P-20261002-23）：
 * 两文件含同关键词 → 取消其中一个勾选 → 替换 → 仅勾选文件被改；
 * 另覆盖默认全选语义（按钮仍为「全部替换」）、清空勾选按钮禁用、
 * 查询变化后勾选重置全选（陈旧勾选防误替换）。
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-replace-selective')
const PROJ = 'e2e-search-replace-selective'

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

// 自包含基线：前序用例可能改写文件，显式还原（同 search-replace 惯例）
function resetBaseline() {
  git(REPO_DIR, ['checkout', '--', '.'])
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo alpha\nfoo beta\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'foo gamma\n')
}

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
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo alpha\nfoo beta\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'foo gamma\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 选择性替换基线'])
  await registerProject(headers, PROJ, REPO_DIR)
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

/** 打开搜索面板 → 搜索 → 展开替换行并填替换值 */
async function openReplace(page: Page, needle: string, replacement: string) {
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(needle)
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill(replacement)
  return card
}

test('选择性替换：取消 b.txt 勾选 → 替换选中 1 文件 → 仅勾选的 a.txt 磁盘生效', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBaseline()

  const card = await openReplace(page, 'foo', 'bar')

  // 默认全选：按钮保持「全部替换」（既有语义兼容），替换行出现全选 chip（此时文案=清空）
  await expect(card.getByRole('button', { name: '全部替换' })).toBeVisible()
  const selectAllChip = card.locator('.ps-select-all')
  await expect(selectAllChip).toContainText('清空')

  // 取消 b.txt 勾选：按钮文案随选择动态化
  await card.locator('.ps-file-header').filter({ hasText: 'b.txt' }).locator('.n-checkbox').click()
  await expect(card.getByRole('button', { name: '替换选中 1 文件' })).toBeVisible()

  // 执行替换：预览弹层（P-20261003-71）展示全部分组——排除项带未勾选态，
  // 统计与确认按钮范围 = 勾选文件
  await card.getByRole('button', { name: '替换选中 1 文件' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  await expect(preview.locator('.rp-stats-text')).toContainText('将替换 1 个文件中的 2 处')
  await expect(preview.locator('.rp-file-group').filter({ hasText: 'b.txt' })).toHaveClass(/is-excluded/)
  const confirmBtn = preview.locator('[data-testid="replace-preview-confirm"]')
  await expect(confirmBtn).toHaveText('替换选中 1 文件')
  await confirmBtn.click()

  // 完成信号（20s：跨拓扑逐文件读改写）+ 磁盘断言：仅勾选的 a.txt 被改，b.txt 原样
  await expect(page.locator('.n-message').filter({ hasText: /已在 1 个文件中完成 \d+ 处替换/ })).toBeVisible({ timeout: 20000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('bar alpha\nbar beta\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'b.txt'), 'utf8')).toBe('foo gamma\n')
})

test('勾选状态管理：清空→按钮禁用；重全选与查询变化→重置回「全部替换」', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBaseline()

  const card = await openReplace(page, 'foo', 'bar')
  const selectAllChip = card.locator('.ps-select-all')

  // 默认全选（chip 文案=清空）：点击三态 chip 清空 → 无勾选文件，按钮禁用
  await expect(selectAllChip).toContainText('清空')
  await selectAllChip.locator('.n-checkbox').click()
  await expect(card.locator('.ps-replace-row button')).toBeDisabled()
  await expect(selectAllChip).toContainText('全选')

  // 再点恢复全选 → 按钮回到「全部替换」
  await selectAllChip.locator('.n-checkbox').click()
  await expect(card.getByRole('button', { name: '全部替换' })).toBeVisible()

  // 部分勾选后再改查询词：新搜索落地 → 勾选重置全选（防陈旧勾选误替换）
  await card.locator('.ps-file-header').filter({ hasText: 'b.txt' }).locator('.n-checkbox').click()
  await expect(card.getByRole('button', { name: '替换选中 1 文件' })).toBeVisible()
  await card.locator('input').first().fill('gamma')
  // 等新结果落地：a.txt 组消失（旧统计文本在新结果前仍可见，不能作新搜索信号）
  await expect(card.locator('.ps-file-header').filter({ hasText: 'a.txt' })).toHaveCount(0, { timeout: 8000 })
  await expect(card.getByRole('button', { name: '全部替换' })).toBeVisible()
  await expect(selectAllChip).toContainText('清空')
})
