import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 界面密度档（P-20261003-322）E2E：外观设置切紧凑 → 行高 token --row-h 注入 +
 * 文件树行高变化（CSS var 与虚拟列表 itemSize 同源，ui-density store）→ 刷新后
 * 持久（服务端 settings 落盘 + boot 链重读）。
 * 舒适档零注入 = 历史现状零回归，基线用例兜底；afterAll 经 settings API 还原
 * 舒适档（settings 是实例全局态，防污染同实例其他 spec）。
 * 注意：用例间档位有意不还原（用例 2 切紧凑 → 用例 3 验刷新持久），中途失败时
 * 后续用例会级联失败并在失败信息中可见根因。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-ui-density')
const PROJ = 'e2e-ui-density'
const FILE_A = 'alpha-density.txt'

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

let projectId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  // 清理历史残留（失败重跑时项目名会撞）
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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'density e2e baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), 'density row a\n')
  fs.writeFileSync(path.join(REPO_DIR, 'beta-density.txt'), 'density row b\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 密度档基线'])

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  const token = headers['X-Lock-Token']
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 档位还原舒适档（实例全局态，防污染其他 spec）
  await fetch(`${API_BASE}/api/settings`, {
    method: 'PUT', headers, body: JSON.stringify({ uidensity: 'comfortable' }),
  })
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进入项目并把文件树面板归一化到可见（rail 是 toggle，uiState 恢复态不定） */
async function enterProjectWithTree(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 4; i++) {
    if (await page.locator('.file-tree .tree-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.file-tree .tree-item').first()).toBeVisible({ timeout: 5000 })
}

/** 外观分区的密度组（data-testid 语义锚点，P-20261002-151） */
async function openDensityGroup(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const group = page.locator('[data-testid="settings-ui-density"]')
  await expect(group).toBeVisible({ timeout: 3000 })
  return group
}

/** 选档 + 底部保存：各分区 save 走完后弹窗自动关闭 */
async function pickDensityAndSave(page: import('@playwright/test').Page, group: import('@playwright/test').Locator, label: string) {
  await group.locator('.n-radio-button', { hasText: label }).click()
  await page.locator('.settings-footer').getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
}

/** 文件树首行行高 + 根元素 --row-h 注入值（jsdom 外真实布局，getBoundingClientRect） */
function treeRowMetrics(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const el = document.querySelector('.file-tree .tree-item')
    return {
      h: el ? Math.round(el.getBoundingClientRect().height * 100) / 100 : 0,
      rowH: getComputedStyle(document.documentElement).getPropertyValue('--row-h').trim(),
    }
  })
}

test('舒适档基线：零注入（--row-h 空），树行为历史自然行高', async ({ page }) => {
  await enterProjectWithTree(page)
  const m = await treeRowMetrics(page)
  expect(m.rowH).toBe('')
  // 自然行高 = 内容行 + padding（默认字体下 ~26px），与紧凑档 22px 可区分
  expect(m.h).toBeGreaterThanOrEqual(24)
})

test('切紧凑：--row-h=22px 注入且文件树行高同步变化', async ({ page }) => {
  await enterProjectWithTree(page)
  const before = await treeRowMetrics(page)
  expect(before.rowH).toBe('')

  const group = await openDensityGroup(page)
  await pickDensityAndSave(page, group, '紧凑')

  // 行高 token 注入 + 文件树行高变化（expect.poll 吸收样式重算时机）
  await expect.poll(async () => (await treeRowMetrics(page)).rowH).toBe('22px')
  const after = await treeRowMetrics(page)
  expect(after.h).toBe(22)
  expect(after.h).not.toBe(before.h)

  // 设置 GET 回读：档位已落服务端（agent settings API 同一事实源）
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/settings`, { headers })
  const data = (await res.json()) as { data?: { uidensity?: string } }
  expect(data.data?.uidensity).toBe('compact')
})

test('刷新持久：重进项目树行仍为紧凑 22px（boot 链重读服务端档位）', async ({ page }) => {
  // 前序用例已切紧凑并落盘；此处独立验证持久化（服务器全局态跨页面存活）
  await enterProjectWithTree(page)
  const m = await treeRowMetrics(page)
  expect(m.rowH).toBe('22px')
  expect(m.h).toBe(22)

  // 完整刷新走 boot 链（App.vue → ui-density store load → token 注入）
  await page.reload()
  await enterProjectWithTree(page)
  const after = await treeRowMetrics(page)
  expect(after.rowH).toBe('22px')
  expect(after.h).toBe(22)
})
