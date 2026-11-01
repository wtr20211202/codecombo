import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 批量替换「保留大小写」E2E（P-20261006-16）：替换输出跟随命中词形态——
 * 全小写原样 / 全大写大写化 / Title 首字母大写化 / 混合不猜原样。预览 after
 * 与执行写盘同参同形态（前端 buildFilePreview 与服务端 replaceWithShape 双端
 * 对账都在此断言）；第二用例验证与「区分大小写」正交可同开。
 * 自备临时仓库，afterAll 清理（search-replace 同范式）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-search-replace-pc')
const PROJ = 'e2e-search-replace-pc'
const BASE_LINE = 'getuser GETUSER Getuser geTuser\n'

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function resetBase() {
  git(REPO_DIR, ['checkout', '--', '.'])
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), BASE_LINE)
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'plain text\n')
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
  // 直接写基线（checkout 路径见 resetBase，此处尚无 commit 不可走）
  fs.writeFileSync(path.join(REPO_DIR, 'a.txt'), BASE_LINE)
  fs.writeFileSync(path.join(REPO_DIR, 'b.txt'), 'plain text\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 保留大小写替换基线'])
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

test('保留大小写替换：getuser → fetchUser 三形态跟随 + 混合不猜，预览与磁盘同形态', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')

  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // 大小写不敏感（缺省）搜 getuser：一行内四种形态全部命中
  await card.locator('input').first().fill('getuser')
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  // 展开替换行 → 填 fetchUser → 勾「保留大小写」（Ab chip）→ 全部替换
  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill('fetchUser')
  await card.locator('[data-testid="ps-preserve-case"] .n-checkbox').click()
  await card.getByRole('button', { name: '全部替换' }).click()

  // 预览弹层：after 形态跟随（前端 buildFilePreview preserveCase 生成）
  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  const afterLine = preview.locator('.rp-file-group').filter({ hasText: 'a.txt' }).locator('.rp-line.is-after')
  await expect(afterLine).toContainText('fetchUser FETCHUSER FetchUser fetchUser')

  // 确认执行：服务端 replaceWithShape 同参同形态写盘（20s 容忍逐文件读改写）
  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: /已在 1 个文件中完成 \d+ 处替换/ })).toBeVisible({ timeout: 20000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('fetchUser FETCHUSER FetchUser fetchUser\n')
})

test('与区分大小写正交同开：Aa+Ab 只命中字面形态并原样替换', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  resetBase()

  await page.keyboard.press('Control+Shift+f')
  const card = page.locator('.ps-card')
  await expect(card).toBeVisible({ timeout: 3000 })

  // 勾区分大小写（Aa）：只命中字面 getuser，其余形态不入选
  await card.locator('input').first().fill('getuser')
  await card.locator('.opt-chip').filter({ hasText: 'Aa' }).locator('.n-checkbox').click()
  await expect(card.getByText(/处匹配/).first()).toBeVisible({ timeout: 8000 })

  await card.locator('button[title="替换"]').click()
  await expect(card.locator('.ps-replace-row input')).toBeVisible({ timeout: 3000 })
  await card.locator('.ps-replace-row input').fill('fetchUser')
  // 勾保留大小写（Ab，替换行内）——与 Aa 正交可同开；全小写命中 → 原样
  await card.locator('[data-testid="ps-preserve-case"] .n-checkbox').click()
  await card.getByRole('button', { name: '全部替换' }).click()

  const preview = page.locator('.n-modal').filter({ hasText: '替换预览' })
  await expect(preview).toBeVisible({ timeout: 3000 })
  const afterLine = preview.locator('.rp-file-group').filter({ hasText: 'a.txt' }).locator('.rp-line.is-after')
  await expect(afterLine).toContainText('fetchUser GETUSER Getuser geTuser')

  await preview.locator('[data-testid="replace-preview-confirm"]').click()
  await expect(page.locator('.n-message').filter({ hasText: /已在 1 个文件中完成 \d+ 处替换/ })).toBeVisible({ timeout: 20000 })
  expect(fs.readFileSync(path.join(REPO_DIR, 'a.txt'), 'utf8')).toBe('fetchUser GETUSER Getuser geTuser\n')
})
