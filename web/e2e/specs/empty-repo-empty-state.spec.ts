import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 空仓库友好空态 E2E（P-20261003-300）：git init 后零提交的项目，GET /log 的
 * git log 以 fatal 128 退出，曾裸传 500 —— 提交面板首开即红色错误 toast。
 * 断言三层：
 *   API：/log、/log/file、/log/directory 均 200 + 空列表 + emptyRepo 标志；
 *   UI：git 面板渲染引导空态（标题 + 「去变更面板」CTA）而非错误 toast；
 *   CTA：点击后侧栏切到变更面板（rail-changes active）。
 * 自备临时空仓（git init 零提交零文件），afterAll 清理（范式与
 * git-panel-features 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-empty-repo-guide')
const PROJ = 'e2e-empty-repo-guide'

let projectId = ''

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
  // 最纯粹的未出生分支形态：git init 后零提交零文件
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
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

test('API：空仓 log 查询族 200 + 空列表 + emptyRepo 标志（非 500）', async () => {
  const headers = await unlockHeaders()
  const log = await (await fetch(`${API_BASE}/api/projects/${projectId}/log`, { headers })).json()
  expect(Array.isArray(log.data)).toBe(true)
  expect((log.data as unknown[]).length).toBe(0)
  expect(log.emptyRepo).toBe(true)

  // 文件历史与目录历史同语义（显式路径形态命中 ambiguous argument + rev-parse 确认）
  const fileLog = await (await fetch(`${API_BASE}/api/projects/${projectId}/log/file?file=README.md`, { headers })).json()
  expect(fileLog.emptyRepo).toBe(true)
  const dirLog = await (await fetch(`${API_BASE}/api/projects/${projectId}/log/directory?path=.`, { headers })).json()
  expect(dirLog.emptyRepo).toBe(true)
})

test('UI：git 面板渲染引导空态而非错误 toast', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-git"]').click()

  // 引导空态：测试锚点 + 双语标题（e2e locale zh-CN）
  const guide = page.locator('[data-testid="commits-empty-repo-guide"]')
  await expect(guide).toBeVisible({ timeout: 8000 })
  await expect(guide.getByText('仓库还没有提交')).toBeVisible()
  await expect(guide.getByRole('button', { name: '去变更面板创建第一个提交' })).toBeVisible()

  // 关键负断言：不是红色错误 toast（服务端语义修正前这里是 500 → 报错直出）
  await expect(page.locator('.n-message--error-type, .n-message-error')).toHaveCount(0)
})

test('CTA：点击引导按钮侧栏切到变更面板', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await page.locator('[data-testid="rail-git"]').click()
  await expect(page.locator('[data-testid="commits-empty-repo-guide"]')).toBeVisible({ timeout: 8000 })

  await page.locator('[data-testid="empty-repo-go-changes"]').click()
  // 变更面板激活 = 侧栏打开且 sideView === changes（活动栏按钮 active 类同源）
  await expect(page.locator('[data-testid="rail-changes"]')).toHaveClass(/active/, { timeout: 5000 })
})
