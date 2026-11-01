import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 替换历史留档与一键还原 E2E（P-20261004-66）：替换历史闭环全链——
 *   ① UI 替换（前端执行链已切服务端 API，取消备份下载勾选消浏览器下载变量）
 *      → 磁盘生效；
 *   ② 设置·安全·替换历史面板在列留档条目（pattern→replacement / 文件数·处数）；
 *   ③ 一键还原（确认弹层）→ 现场回滚：替换文件回到替换前状态。
 * 基线特意保持脏态（a.txt 携替换前未提交行）——还原必须把「替换前未提交改动」
 * 一起重建（服务端 checkout+正向 apply 备份补丁链，P-114 e2e 回滚组合产品化），
 * 断言能证伪「只做 checkout 丢掉用户现场」的退化实现。
 * 自备临时仓库，afterAll 清理（范式与 search-replace 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-replace-history')
const PROJ = 'e2e-replace-history'
const PRE = 'alpha beta\nalpha second\nlocal edit\n' // 替换前现场（含未提交行，2 处命中）
const POST = 'ALPHA beta\nALPHA second\nlocal edit\n' // 替换后（alpha→ALPHA）

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

function resetBaseline() {
  git(REPO_DIR, ['checkout', '--', '.'])
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), PRE)
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  // 基线文件直写（resetBaseline 的 checkout -- . 需已有提交，首建不适用）
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), PRE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 替换历史基线'])
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

/** 设置 → 安全 → 替换历史（activity bar rail-settings 入口 + audit-log.spec 同款导航） */
async function openReplaceHistoryTab(page: Page) {
  // 先关搜索面板：其全屏遮罩（.ps-mask）会拦截 activity bar 的点击
  await page.keyboard.press('Escape')
  await expect(page.locator('.ps-card')).toBeHidden({ timeout: 3000 })
  await page.getByTestId('rail-settings').click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '替换历史' }).click()
  await expect(page.getByTestId('replace-history-pane')).toBeVisible({ timeout: 5000 })
}

test('替换 → 历史面板在列 → 一键还原 → 现场回滚（含替换前未提交改动）', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBaseline()

  // ① UI 替换：搜索 alpha → 全部替换为 ALPHA（取消备份下载勾选，消下载变量；
  //    备份本体已服务端强制留档——本用例的还原走产品内历史，不依赖下载）
  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })
  await card.locator('input').first().fill('alpha')
  await card.locator('input').first().blur() // 收起查询历史下拉，防盖住选项 chips（search-replace 同款）
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill('ALPHA')
  await card.getByRole('button', { name: '全部替换' }).click()
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  const backupToggle = preview.locator('[data-testid="replace-backup-toggle"] .n-checkbox')
  await expect(backupToggle).toHaveClass(/n-checkbox--checked/)
  await backupToggle.click()
  await expect(backupToggle).not.toHaveClass(/n-checkbox--checked/)
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: /已在 1 个文件中完成 2 处替换/ })).toBeVisible({ timeout: 20000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe(POST)

  // ② 历史面板：留档条目在列（项目选择器默认跟随当前项目），元数据齐全
  await openReplaceHistoryTab(page)
  const item = page.getByTestId('replace-history-item').filter({ hasText: 'alpha' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await expect(item).toContainText('ALPHA')
  await expect(item).toContainText(/1 个文件 \/ 2 处/)
  // 确认弹层前可见还原钮（restorable=true：脏基线备份非空且已内嵌）
  const restoreBtn = item.getByTestId('replace-history-restore')
  await expect(restoreBtn).toBeVisible()

  // ③ 一键还原：确认弹层（脏基线文案）→ 确认 → 现场回滚到替换前
  await restoreBtn.click()
  const dialog = page.locator('.n-dialog').filter({ hasText: '还原此次替换' })
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await dialog.getByRole('button', { name: '确认' }).click()
  await expect(page.locator('.n-message').filter({ hasText: /已还原 1 个文件/ })).toBeVisible({ timeout: 20000 })

  // 现场回滚：替换 undone 且替换前的未提交行（local edit）原样重建
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe(PRE)
})
