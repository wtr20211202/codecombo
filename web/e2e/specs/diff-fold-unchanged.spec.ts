import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * DiffViewer 折叠未变区域 E2E（P-20261004-99）：自绘 diff 与编辑器 DiffEditor
 * 折叠开关（diff-collapse-unchanged，P-20261003-40 Monaco hideUnchangedRegions）
 * 的对称收口。折叠单位 = 两个变更行之间的文件空间未变区域（服务端 diff 默认
 * -U3 上下文：hunk 内 context 至多 ±3 行、hunk 间隙不进 diff 文本，按显示行
 * context 段长度判永不触发——判定在 utils/diffFold，跨度用 context 行绝对行号
 * 差还原）。
 * 夹具 = 200 行文件在第 20/60 行两处远隔修改 → 两 hunk，中间未变区（旧侧
 * 21..59 = 39 行 > 8）可折叠，占位行罩住 ctx21..23 + @@h2 + ctx57..59 共 7 个
 * 显示行：开折叠 22 行（文件头 4 行 + 2×9）→ 15 行 + 1 占位（总行数骤减）→
 * 展开恢复 → 收起（可逆）；导航跳被折叠的 hunk2 时自动展开（P-54 联动）；并排
 * 模式同区间同款占位行。
 * 入口复用 diff-nav-hunks 的对比弹窗路径（提交文件节点 → 在编辑器中打开 →
 * 对比 → 选 feature=c1）。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-fold-unchanged')
const PROJ = 'e2e-diff-fold-unchanged'
const FILE = 'fold.txt'

const C1_CONTENT = Array.from({ length: 200 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n') + '\n'
// 第 20/60 行各改一处：相距 40 行 → 两 hunk，中间未变区 39 行（> 8 可折叠）
const C2_CONTENT = C1_CONTENT
  .replace('line-020', 'line-020 CHANGED-ALPHA')
  .replace('line-060', 'line-060 CHANGED-BRAVO')

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let projectId = ''
let c2 = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge，与 Linux 视图一致
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  git(REPO_DIR, ['branch', 'feature']) // feature 指回 c1：对比弹窗选它即得 c1↔c2 两 hunk diff
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: two distant edits'])
  c2 = git(REPO_DIR, ['rev-parse', 'HEAD'])

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': headers['X-Lock-Token'] },
    body: JSON.stringify({ local: null }),
  })
})

// 进项目并展开底部 Git 面板提交列表（rail 是 toggle，按提交可见性收敛）
async function enterAndOpenLog(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-item').first()).toBeVisible()
}

/** 打开对比弹窗（内嵌 DiffViewer，默认 unified）：c2 文件节点 → 在编辑器中打开 → 对比 → 选 feature */
async function openCompareModal(page: import('@playwright/test').Page) {
  await enterAndOpenLog(page)
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  await node.click({ button: 'right' })
  await page.locator('.n-dropdown-menu').getByText('在编辑器中打开', { exact: true }).click()
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 15000 })
  await page.locator('.ega-btn').filter({ hasText: '对比' }).click()
  const modal = page.locator('.n-modal').filter({ hasText: `对比：${FILE}` })
  await expect(modal).toBeVisible({ timeout: 5000 })
  await modal.locator('.n-base-selection').first().click()
  const featureOption = page.locator('.n-base-select-menu .n-base-select-option').filter({ hasText: 'feature' })
  await expect(featureOption).toBeVisible({ timeout: 10000 })
  await featureOption.click()
  await expect(modal.locator('.crm-diff')).toBeVisible({ timeout: 10000 })
  return modal
}

test('unified：默认全展开 → 开折叠中间收占位行且行数骤减 → 展开/收起可逆 → 导航跳被折叠 hunk 自动展开', async ({ page }) => {
  const modal = await openCompareModal(page)

  // 默认（开关关）：两 hunk 全展开 = 文件头 4 行（diff --git/index/---/+++，解析器
  // 全归伪块 0）+ 每 hunk 9 行（@@+3ctx+del+add+3ctx）= 22 行，无占位行；导航
  // 计数 2 个变更块
  const toggle = modal.locator('[data-testid="diff-fold-toggle"]')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(modal.locator('[data-testid="diff-fold-row"]')).toHaveCount(0)
  await expect(modal.locator('.diff-line')).toHaveCount(22)
  await expect(modal.locator('[data-testid="diff-nav-count"]')).toHaveText('–/2')

  // 开折叠：中间未变区（文件空间 39 行 > 8）收成 1 个占位行，罩住 7 个显示行
  // （ctx21..23 + @@h2 + ctx57..59）：总行数 22 → 16（15 行 + 1 占位），被罩的
  // line-021 不再渲染
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  const foldRow = modal.locator('[data-testid="diff-fold-row"]')
  await expect(foldRow).toHaveCount(1)
  await expect(foldRow).toContainText('展开 7 行')
  await expect(modal.locator('.diff-line')).toHaveCount(15)
  await expect(modal.locator('.diff-line', { hasText: 'line-021' })).toHaveCount(0)

  // 点占位行展开：7 行恢复（含被罩的 @@h2），占位行变「收起」控件（可逆第一半）
  await foldRow.click()
  await expect(foldRow).toContainText('收起')
  await expect(modal.locator('.diff-line')).toHaveCount(22)
  await expect(modal.locator('.diff-line', { hasText: 'line-021' })).toBeVisible()
  await expect(modal.locator('[data-hunk-nav="2"]')).toBeVisible()

  // 再点收起：回到折叠态（可逆第二半）
  await foldRow.click()
  await expect(foldRow).toContainText('展开 7 行')
  await expect(modal.locator('.diff-line')).toHaveCount(15)

  // 关开关：即时恢复全展开（行集合上游过滤直通，占位行清零）
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(modal.locator('[data-testid="diff-fold-row"]')).toHaveCount(0)
  await expect(modal.locator('.diff-line')).toHaveCount(22)

  // 再开折叠 → 导航：next 落 hunk1（1/2），再 next 的目标 @@h2 在折叠区内——
  // 自动展开后落位（P-54 联动）：落点高亮 + 被罩内容回显 + 区域保持展开
  await toggle.click()
  await expect(foldRow).toHaveCount(1)
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator('[data-testid="diff-nav-count"]')).toHaveText('1/2')
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator('[data-testid="diff-nav-count"]')).toHaveText('2/2')
  await expect(modal.locator('[data-hunk-nav="2"].diff-nav-flash')).toBeVisible()
  await expect(modal.locator('.diff-line', { hasText: 'line-057' })).toBeVisible()
  await expect(foldRow).toContainText('收起')
})

test('并排模式：同区间折叠注记（td 占位行），展开/收起与 unified 共享状态口径', async ({ page }) => {
  const modal = await openCompareModal(page)
  const diffRoot = modal.locator('.crm-diff')

  // 切并排（虚拟化行序与 unified 1:1，折叠前 22 行）→ 开折叠收成 1 个 td 占位行
  await modal.getByRole('button', { name: '并排', exact: true }).click()
  await expect(diffRoot.locator('tr')).toHaveCount(22)
  const toggle = modal.locator('[data-testid="diff-fold-toggle"]')
  await toggle.click()
  const foldRow = diffRoot.locator('td[data-testid="diff-fold-row"]')
  await expect(foldRow).toHaveCount(1)
  await expect(foldRow).toContainText('展开 7 行')
  await expect(diffRoot.locator('tr')).toHaveCount(16)

  // td 占位行展开/收起可逆
  await foldRow.click()
  await expect(foldRow).toContainText('收起')
  await expect(diffRoot.locator('tr')).toHaveCount(23)
  await foldRow.click()
  await expect(foldRow).toContainText('展开 7 行')
  await expect(diffRoot.locator('tr')).toHaveCount(16)
})
