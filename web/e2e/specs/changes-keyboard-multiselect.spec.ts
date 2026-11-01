import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更树键盘多选 E2E（P-20261003-271）：Shift+↑↓ 自锚点行扩展范围选择
 * （锚点在 Shift 释放后保留；目录行不参与集合）、Ctrl+A 全选可见文件行、
 * 普通导航/Esc 退出多选；多选 ≥2 且右键落在集合内 → 右键菜单切批量形态
 * （暂存所选 (n) 等，文件树 P-20 同款交互），右键落集合外收缩为该行单选
 * （菜单保持单文件形态）。批量暂存真落 API（未暂存 → 已暂存），
 * 复制所选路径入剪贴板（行序 LF 连接）。
 * 自备临时仓库：4 个「tracked 后修改」（' M'）文件（其一在子目录，出目录行）
 * ——不用 untracked：git status --porcelain 对整目录未跟踪折叠成 `?? nested/`
 * 单条目，变更树会渲染无名文件行（存量显示行为），批量断言也需要逐文件条目；
 * afterAll 清理（与 changes-keyboard 对称）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-changes-multiselect')
const PROJ = 'e2e-changes-multiselect'
const F1 = 'alpha-key.txt'
const F2 = 'beta-key.txt'
const F3 = 'gamma-key.txt'
const F4_DIR = 'nested'
const F4 = 'nested/kappa-key.txt'
const F4_BASE = 'kappa-key.txt' // 树行只显基名（.cp-name=name），行定位用基名；剪贴板断言用全路径

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
  fs.mkdirSync(path.dirname(path.join(REPO_DIR, F4)), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'multiselect e2e baseline\n')
  // 基线提交 4 个待改文件，再整体改写——porcelain 出 4 条 ' M' 逐文件条目
  // （批量暂存断言需要 ○→✓ 的未暂存→已暂存状态迁移）
  for (const f of [F1, F2, F3, F4]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} v1\n`)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 键盘多选基线'])
  for (const f of [F1, F2, F3, F4]) fs.writeFileSync(path.join(REPO_DIR, f), `${f} v2 modified\n`)
  expect(git(REPO_DIR, ['status', '--porcelain']).split('\n').filter(Boolean)).toHaveLength(4)

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
  // uiState 归零收尾（防布局恢复污染后续 spec）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** rail「提交」是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function openCommitPanel(page: import('@playwright/test').Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.commit-panel').isVisible()).toBe(true)
}

async function enterProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F1 })).toBeVisible({ timeout: 10000 })
}

/** 聚焦列表容器并断言焦点落位（tabindex=0） */
async function focusList(page: import('@playwright/test').Page) {
  const list = page.locator('.cp-file-list')
  await list.focus()
  await expect(list).toBeFocused()
  return list
}

/** 当前键盘高亮行的文件名（目录行即目录名） */
function activeName(page: import('@playwright/test').Page) {
  return page.locator('.cp-node.is-active .cp-name')
}

// flatTree 行序：目录行在前（sortTree 目录优先），子项按字母序——
// nested → kappa-key.txt → alpha-key.txt → beta-key.txt → gamma-key.txt
// 菜单项定位用锚定正则：hasText 子串会把「暂存所选 (n)」同时命中「取消暂存所选 (n)」

test('Shift+↓ 范围选择 → 批量菜单出现 → 批量暂存落 API（未暂存→已暂存）', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await focusList(page)

  // Home 锚到首行（目录行 nested），Shift+↓ 两步：区间=nested..alpha，
  // 目录行不参与集合 → 2 文件多选
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(2)
  await expect(activeName(page)).toHaveText(F1)

  // 右键落在集合内（alpha）→ 菜单切批量形态，计数 2
  await panel.locator('.cp-node').filter({ hasText: F1 }).click({ button: 'right' })
  const batchStage = page.locator('.n-dropdown-option').filter({ hasText: /^暂存所选 \(2\)$/ })
  await expect(batchStage).toBeVisible()
  await expect(page.locator('.n-dropdown-option').filter({ hasText: /^复制所选路径 \(2\)$/ })).toBeVisible()

  // 执行批量暂存：未暂存 → 已暂存真落 API，范围外文件不被波及，完成后多选清空
  const alphaToggle = panel.locator('.cp-node').filter({ hasText: F1 }).locator('.cp-stage-toggle')
  await expect(alphaToggle).toHaveText('○')
  await batchStage.click()
  await expect(alphaToggle).toHaveText('✓', { timeout: 10000 })
  await expect(panel.locator('.cp-node').filter({ hasText: F4_BASE }).locator('.cp-stage-toggle')).toHaveText('✓', { timeout: 10000 })
  await expect(panel.locator('.cp-node').filter({ hasText: F2 }).locator('.cp-stage-toggle')).toHaveText('○')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(0)
})

test('Shift 释放后锚点保留；普通导航/Esc 退出多选；Ctrl+A 全选可见文件行', async ({ page }) => {
  await enterProject(page)
  await focusList(page)

  // Home 锚点=首行（nested 目录行），Shift+↓ ×2 → {kappa, alpha}
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(2)

  // Shift 释放后 Shift+↑：锚点仍在首行 → 区间缩到 {kappa}
  //（若锚点错误漂移到光标行 alpha，区间会是 {kappa, alpha} 2 项）
  await page.keyboard.press('Shift+ArrowUp')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(1)
  await expect(page.locator('.cp-node.is-multi-selected').first()).toContainText('kappa-key.txt')

  // 再 Shift+↓ ×2 扩回 3 项；普通（无 Shift）↓ 立即退出多选（导航与多选互斥切换）
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(3)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(0)
  await expect(activeName(page)).toHaveText(F3)

  // Ctrl+A 全选可见文件行（目录行不参与 → 4 项）；Esc 退出
  await page.keyboard.press('ControlOrMeta+a')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(4)
  await page.keyboard.press('Escape')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(0)
})

test('批量复制路径入剪贴板且不清选择；右键落集合外收缩为单选（菜单保持单文件形态）', async ({ page }) => {
  await enterProject(page)
  const panel = page.locator('.commit-panel')
  await focusList(page)

  // Shift+↓ ×2 → {kappa, alpha}；右键集合内（alpha）→ 复制所选路径 (2)
  await page.keyboard.press('Home')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(2)
  await panel.locator('.cp-node').filter({ hasText: F1 }).click({ button: 'right' })
  const copyItem = page.locator('.n-dropdown-option').filter({ hasText: /^复制所选路径 \(2\)$/ })
  await expect(copyItem).toBeVisible()
  await copyItem.click()
  await expect(page.locator('.n-message').filter({ hasText: '路径已复制' })).toBeVisible({ timeout: 5000 })
  // Windows Chromium 剪贴板往返把 LF 规范成 CRLF（changes-copy-summary 实测），断言前归一
  const raw = await page.evaluate(() => navigator.clipboard.readText())
  expect(raw.replace(/\r\n/g, '\n')).toBe(`${F4}\n${F1}`)
  // 复制非破坏：多选保留（状态变更类动作才清空，文件树批量同款）
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(2)

  // 右键集合外（gamma，选择已随复制保留）→ 收缩为该行单选、菜单无批量项。
  // 放用例末尾：菜单无确定性关闭通道（Esc 落在列表容器不进菜单、点行会改选择
  // 态），关闭后才能继续断言——收尾时菜单保持打开不产生后续交互
  await panel.locator('.cp-node').filter({ hasText: F3 }).click({ button: 'right' })
  await expect(page.locator('.n-dropdown-option').filter({ hasText: /^复制路径$/ }).first()).toBeVisible()
  await expect(page.locator('.n-dropdown-option').filter({ hasText: /所选/ })).toHaveCount(0)
  await expect(page.locator('.cp-node.is-multi-selected')).toHaveCount(0)
})
