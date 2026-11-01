import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 批量替换预览 E2E（P-20261003-71）：
 * ① regex 替换 → 预览弹层逐行 before（红划）→after（绿标）对照，after 与执行
 *   同一 replace 函数生成（磁盘结果与预览一致即互证）；
 * ② 弹层内单文件勾选排除 → 确认仅作用勾选文件；
 * ③ 大结果集防塌方：>10 文件第 11 个起默认折叠（组头常驻可展开）、单文件
 *   >20 行先截断可展开其余——折叠断言状态感知（rg 与 git grep 输出顺序不同，
 *   不假设组序）。
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-replace-preview')
const PROJ = 'e2e-replace-preview'

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

function resetRegexBaseline() {
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), 'id-001 alpha\nid-002 beta\n')
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'id-003 gamma\n')
  fs.writeFileSync(path.join(REPO_DIR, 'c.txt'), 'nothing relevant\n')
}

// 折叠用例基线：f01 25 行命中（行截断分支），f02..f12 各 1 行命中（共 12 文件 > 10 触发默认折叠）
function writeFoldBaseline() {
  git(REPO_DIR, ['checkout', '--', '.'])
  const f01 = Array.from({ length: 25 }, (_, i) => `needle line-${i + 1}`).join('\n') + '\n'
  fs.writeFileSync(path.join(REPO_DIR, 'f01.txt'), f01)
  for (let i = 2; i <= 12; i++) {
    fs.writeFileSync(path.join(REPO_DIR, `f${String(i).padStart(2, '0')}.txt`), `needle only-${i}\n`)
  }
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
  resetRegexBaseline()
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 替换预览基线'])
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

/** 打开搜索面板（regex 模式）→ 搜索 → 展开替换行并填替换值 */
async function openRegexReplace(page: Page, needle: string, replacement: string) {
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill(needle)
  // fill 聚焦输入框，搜索执行后 needle 随即入查询历史（P-20261003-48 全局域
  // 环形表）→ 历史下拉弹出。历史上其 absolute 悬浮盖住选项 chips、regex 勾选
  // 点击被 ps-history-item 拦截（负载下首跑偶发，重跑因时序差常绿），
  // P-20261006-32 已改锚头部件下缘不再遮挡；显式 blur 收下拉照旧保留作双保险：
  // @blur 即 historyFocused=false，与产品 Esc 分层「先收下拉」同语义
  await card.locator('input').first().blur()
  await card.locator('.opt-chip').filter({ hasText: '.*' }).locator('.n-checkbox').click()
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill(replacement)
  await card.getByRole('button', { name: '全部替换' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  return { card, preview }
}

test('regex 替换预览：after 行正确 → 弹层内排除 b.txt → 仅勾选文件落盘且与预览一致', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetRegexBaseline()

  // ERE 语法（git grep -E 兼容）而非 \d：POSIX ERE 无 \d，rg/git grep 两后端须同语义
  const { preview } = await openRegexReplace(page, 'id-[0-9]+', 'ID')

  // 预览行对照：命中段红划（before）→ 替换段绿标（after，正则变换正确）
  const groupA = preview.locator('.rp-file-group').filter({ hasText: 'a.txt' })
  await expect(groupA.locator('.rp-del')).toHaveText(['id-001', 'id-002'])
  await expect(groupA.locator('.rp-add')).toHaveText(['ID', 'ID'])
  await expect(groupA.locator('.rp-line.is-after')).toHaveText(['ID alpha', 'ID beta'])
  const groupB = preview.locator('.rp-file-group').filter({ hasText: 'b.txt' })
  await expect(groupB.locator('.rp-line.is-after')).toHaveText(['ID gamma'])
  // c.txt 无命中不进预览
  await expect(preview.locator('.rp-file-group').filter({ hasText: 'c.txt' })).toHaveCount(0)

  // 默认统计 = 全部结果：2 文件 3 处
  await expect(preview.locator('.rp-stats-text')).toContainText('将替换 2 个文件中的 3 处')

  // 弹层内勾选排除 b.txt：统计/按钮随勾选收敛，排除组降透明度
  await groupB.locator('.n-checkbox').click()
  await expect(preview.locator('.rp-stats-text')).toContainText('将替换 1 个文件中的 2 处')
  await expect(groupB).toHaveClass(/is-excluded/)
  const confirmBtn = preview.locator('[data-testid="replace-preview-confirm"]')
  await expect(confirmBtn).toHaveText('替换选中 1 文件')

  // 确认执行仅作用勾选文件：磁盘结果与预览一致（b.txt 原样）
  await confirmBtn.click()
  await expect(page.locator('.n-message').filter({ hasText: '已在 1 个文件中完成 2 处替换' })).toBeVisible({ timeout: 20000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('ID alpha\nID beta\n')
  expect(fs.readFileSync(path.join(REPO_DIR, 'b.txt'), 'utf8')).toBe('id-003 gamma\n')
})

test('大结果集防塌方：>10 文件默认折叠可展开；单文件 >20 行先截断可展开其余', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  writeFoldBaseline()

  // 字面量查询即可（折叠/截断与匹配模式无关）
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill('needle')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await card.locator('.ps-replace-row input').fill('NERD')
  await card.getByRole('button', { name: '全部替换' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })

  // 12 个文件组全渲染（组头轻量），恰好 2 个默认折叠（第 11、12 个）
  await expect(preview.locator('.rp-file-group')).toHaveCount(12)
  const collapsedIcons = preview.locator('.rp-fold-icon:not(.is-open)')
  await expect(collapsedIcons).toHaveCount(2)

  // f01 组状态感知展开（rg 与 git grep 组序不同，不假设其在折叠集内外）
  const g01 = preview.locator('.rp-file-group').filter({ hasText: 'f01.txt' })
  const g01WasCollapsed = (await g01.locator('.rp-fold-icon.is-open').count()) === 0
  if (g01WasCollapsed) {
    await g01.locator('.rp-fold').click()
  }
  await expect(g01.locator('.rp-fold-icon.is-open')).toHaveCount(1)
  await expect(collapsedIcons).toHaveCount(g01WasCollapsed ? 1 : 2)

  // 单文件 25 行 > 20：先截断渲染 20 行，「展开其余 5 处」按需展开
  await expect(g01.locator('.rp-row')).toHaveCount(20)
  await expect(g01.locator('.rp-more')).toHaveText('展开其余 5 处')
  await g01.locator('.rp-more').click()
  await expect(g01.locator('.rp-row')).toHaveCount(25)

  // 折叠组手动展开：行出现。折叠过滤器是动态谓词——点击展开后该组不再命中
  // filter，locator 会重解析为空集，故先锚定文件名、展开后按名重定位
  const collapsedGroup = preview.locator('.rp-file-group').filter({ has: page.locator('.rp-fold-icon:not(.is-open)') }).first()
  const collapsedName = (await collapsedGroup.locator('.rp-file-name').innerText()).trim()
  await collapsedGroup.locator('.rp-fold').click()
  const expandedGroup = preview.locator('.rp-file-group').filter({ hasText: collapsedName })
  await expect(expandedGroup.locator('.rp-row')).toHaveCount(1)
  await expect(collapsedIcons).toHaveCount(g01WasCollapsed ? 0 : 1)

  // 收尾不执行：取消关弹层，磁盘零改动
  await preview.locator('.rp-footer button').filter({ hasText: '取消' }).click()
  await expect(preview).toBeHidden({ timeout: 3000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'f01.txt'), 'utf8')).toContain('needle line-25')
})
