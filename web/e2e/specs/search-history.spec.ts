import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 项目搜索查询历史 E2E（P-20261003-48）：
 * 搜两次 → 重开面板聚焦出历史下拉（最近在上）→ 点击回填并立即执行 →
 * 输入前缀过滤 → Esc 分层收下拉不关面板 → 清空历史后下拉不再出现。
 * 历史存 localStorage（全域），每个用例独立 context 天然隔离；
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-history')
const PROJ = 'e2e-search-history'
const HISTORY_KEY = 'project-search-history'

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

async function deleteProjectByName(name: string): Promise<void> {
  const headers = await unlockHeaders()
  const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === name) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await deleteProjectByName(PROJ)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // 两个词互不为前缀：'foo' 只中 a.txt，'baz' 只中 b.txt，结果断言互不串扰
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'foo bar\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'baz qux\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 搜索历史基线'])
  await registerProject(headers, PROJ, REPO_DIR)
})

test.afterAll(async () => {
  await deleteProjectByName(PROJ)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

test('查询历史：搜两次→聚焦出下拉→回填执行→前缀过滤→Esc 分层→清空归零', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const card = page.locator('.ps-card')
  const queryInput = card.locator('input').first()

  // 第一次搜索 foo（防抖 300ms + git grep）
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  await queryInput.fill('foo')
  await expect(card.locator('.ps-line', { hasText: 'foo bar' }).first()).toBeVisible({ timeout: 8000 })

  // 搜后输入框仍聚焦且前缀命中历史 → 下拉开着；Esc 第一层只收下拉，面板保留
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('ps-history')).toBeHidden()
  await expect(card).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })

  // 第二次搜索 baz
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  await queryInput.fill('baz')
  await expect(card.locator('.ps-line', { hasText: 'baz qux' }).first()).toBeVisible({ timeout: 8000 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })

  // 重开面板：聚焦且输入为空 → 历史下拉出现，最近在上（baz 先于 foo）
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  const dropdown = page.getByTestId('ps-history')
  await expect(dropdown).toBeVisible({ timeout: 3000 })
  await expect(page.getByTestId('ps-history-item-0')).toHaveText(/baz/)
  await expect(page.getByTestId('ps-history-item-1')).toHaveText(/foo/)

  // 点击历史项：回填并立即执行（不等防抖）；回填后下拉收起（结果区即反馈）
  await page.getByTestId('ps-history-item-1').click()
  await expect(dropdown).toBeHidden()
  await expect(card.locator('.ps-line', { hasText: 'foo bar' }).first()).toBeVisible({ timeout: 8000 })

  // 输入前缀过滤（补全式）：手动编辑重新唤出，'ba' 只剩 baz；清回空恢复全部
  await queryInput.fill('ba')
  await expect(dropdown).toBeVisible()
  await expect(page.getByTestId('ps-history-item-0')).toHaveText(/baz/)
  await expect(card.locator('.ps-history-item')).toHaveCount(1)
  await queryInput.fill('zz')
  await expect(page.getByTestId('ps-history-empty')).toBeVisible()
  await expect(card.locator('.ps-history-item')).toHaveCount(0)
  await queryInput.fill('')
  await expect(card.locator('.ps-history-item')).toHaveCount(2)

  // Esc 收下拉不关面板（分层关闭）
  await page.keyboard.press('Escape')
  await expect(dropdown).toBeHidden()
  await expect(card).toBeVisible()

  // 已聚焦时点击输入框重新唤出（focus 事件不重触发），尾部清空入口归零
  await queryInput.click()
  await expect(dropdown).toBeVisible({ timeout: 3000 })
  await page.getByTestId('ps-history-clear').click()
  await expect(dropdown).toBeHidden()
  expect(await page.evaluate((k) => window.localStorage.getItem(k), HISTORY_KEY)).toBeNull()

  // 清空后面板可正常关闭；再开无历史下拉（无历史不弹空壳）
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  await expect(page.getByTestId('ps-history')).toHaveCount(0)
})

// 层叠遮挡修复回归（P-20261006-32）：下拉原 absolute 锚输入行下缘、直盖选项
// chips，聚焦期间点「Aa/\b/.*」被 ps-history-item 拦截至点击超时（50f7fb0c 实
// 证）；修复后锚头部件下缘，下拉开着时 chips 直接可点——本用例不收下拉点正则
// chip，断言勾选落地即「落点在 chip 不在历史项」的机器化表达
test('层叠修复：历史下拉开着时选项 chips 直接可点（不被 ps-history-item 拦截）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  const card = page.locator('.ps-card')
  const queryInput = card.locator('input').first()

  // 先搜一次让历史非空（无历史不弹下拉）
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  await queryInput.fill('foo')
  await expect(card.locator('.ps-line', { hasText: 'foo bar' }).first()).toBeVisible({ timeout: 8000 })
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(card).toBeHidden({ timeout: 3000 })

  // 重开面板 → 下拉开着；不收下拉直接点正则 chip（修复前此点击被历史项拦截）
  await page.keyboard.press('Control+Shift+f')
  await expect(card).toBeVisible({ timeout: 3000 })
  const dropdown = page.getByTestId('ps-history')
  await expect(dropdown).toBeVisible({ timeout: 3000 })
  const regexChip = card.locator('.opt-chip').filter({ hasText: '.*' })
  await regexChip.locator('.n-checkbox').click()
  // 落点在 chip：勾选生效；chip 点击使输入框失焦 → 收下拉（既有 blur 语义保留）
  await expect(regexChip.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await expect(dropdown).toBeHidden()

  // 勾选真实生效（非哑状态）：'f.o' 按正则语义仍中 foo 行（字面量搜索无命中）。
  // fill 重新聚焦 → 空态下拉再弹（前缀不匹配历史）悬在结果区顶部，Esc 先收再看结果
  await queryInput.fill('f.o')
  await expect(dropdown).toBeVisible({ timeout: 3000 })
  await page.keyboard.press('Escape')
  await expect(dropdown).toBeHidden()
  await expect(card.locator('.ps-line', { hasText: 'foo bar' }).first()).toBeVisible({ timeout: 8000 })
})
