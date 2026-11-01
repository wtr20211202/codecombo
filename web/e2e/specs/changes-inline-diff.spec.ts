import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 变更面板文件行内联 diff 展开（P-20261004-25）E2E：文件行 chevron 展开嵌入
 * DiffViewer（enableHunkStaging=true 点亮 hunk 三键）——分块处置的变更面板
 * 就近入口。守护链：
 *   懒加载（收起零请求，展开才拉 /file/diff，收起再展开重新拉取）；
 *   内嵌 diff 出现且 hunk 三键在位；
 *   discard 首块（确认弹窗）→ 服务端按「展示索引-1」寻址丢弃对应块、相邻块
 *   不受扰（DiffViewer 伪块 0 头行偏移的差一错位回归锚）；
 *   stage 首块 → 暂存区只含该块，status 刷新后行状态翻转（staged 侧），
 *   内嵌 diff 随 staged 翻转换侧重拉为「取消暂存」键形态；
 *   accordion 同面板单文件展开；
 *   既有「双击开编辑器 Diff 标签」主路径不受 chevron 影响。
 * 全程以 git CLI 校验仓库真实状态；自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-inline-diff')
const PROJ = 'e2e-inline-diff'
// 三个根级文件互不为子串（树行按末段名定位）：两份 12 行双远隔 hunk 夹具
//（改动相距 8 行上下文，稳定拆两块）+ 一份索引侧单块夹具
const F_DISCARD = 'discard-work.txt'
const F_STAGE = 'stage-work.txt'
const F_STAGED = 'staged-side.txt'
const BASELINE = [
  'alpha one',
  'alpha two',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'ctx',
  'omega one',
  'omega two',
  '',
].join('\n')

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], { cwd, encoding: 'utf8' }).trim()
}

function twoHunkVersion(tag: string): string {
  return BASELINE.replace('alpha two', `alpha ${tag}`).replace('omega one', `omega ${tag}`)
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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR }) // 双路径：Windows 服务端 git 也不 smudge
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'inline diff e2e baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, F_DISCARD), BASELINE)
  fs.writeFileSync(path.join(REPO_DIR, F_STAGE), BASELINE)
  fs.writeFileSync(path.join(REPO_DIR, F_STAGED), BASELINE)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 内联 diff 展开基线'])
  // 全部改动注册前造好（项目注册使服务端 status 缓存失效，进项目首拉即含全量变更）
  fs.writeFileSync(path.join(REPO_DIR, F_DISCARD), twoHunkVersion('T1'))
  fs.writeFileSync(path.join(REPO_DIR, F_STAGE), twoHunkVersion('T3'))
  fs.writeFileSync(path.join(REPO_DIR, F_STAGED), twoHunkVersion('T5'))
  git(REPO_DIR, ['add', F_STAGED])
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only']).split('\n')).toEqual([F_STAGED])

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
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await openCommitPanel(page)
  await expect(page.locator('.cp-node').filter({ hasText: F_DISCARD })).toBeVisible({ timeout: 10000 })
}

function row(page: import('@playwright/test').Page, name: string) {
  return page.locator('.cp-node').filter({ hasText: name }).first()
}

/** 文件行 chevron 展开，返回内嵌 diff 容器 */
async function expandInlineDiff(page: import('@playwright/test').Page, name: string) {
  await row(page, name).locator('.cp-expand-chevron').click()
  const embed = page.locator('[data-testid="cp-inline-diff"]')
  await expect(embed).toBeVisible()
  return embed
}

test('懒加载：收起零请求→展开恰一拉→discard 首块相邻块不受扰→收起→再展开重拉', async ({ page }) => {
  await enterProject(page)
  let discardDiffReqs = 0
  page.on('request', (r) => {
    if (r.url().includes('/file/diff') && r.url().includes(`file=${F_DISCARD}`)) discardDiffReqs++
  })

  // 展开前零请求（懒加载：渲染面 v-if 挂载才拉 GetFileDiff）
  await expect(row(page, F_DISCARD)).toBeVisible()
  expect(discardDiffReqs).toBe(0)

  const embed = await expandInlineDiff(page, F_DISCARD)
  await expect.poll(() => discardDiffReqs, { timeout: 5000 }).toBe(1)
  // 内嵌 diff 行在位（unified 文本行）+ 双块各一对键（工作区侧：暂存+放弃）
  await expect(embed.locator('.diff-line').first()).toBeVisible({ timeout: 5000 })
  await expect(embed.locator('[data-testid="diff-hunk-stage"]')).toHaveCount(2)
  await expect(embed.locator('[data-testid="diff-hunk-discard"]')).toHaveCount(2)

  // 放弃第一块 → 确认弹窗（含文件名与不可恢复警示）→ 确认
  await embed.locator('[data-testid="diff-hunk-discard"]').first().click()
  const dialog = page.locator('.n-dialog')
  await expect(dialog).toBeVisible({ timeout: 3000 })
  await expect(dialog).toContainText(F_DISCARD)
  await expect(dialog).toContainText('不可恢复')
  await dialog.locator('.n-dialog__action button').filter({ hasText: '确认' }).click()
  await expect(dialog).toHaveCount(0)

  // 仓库实况：第一块还原、第二块保留、暂存区未被动过（展示索引-1 寻址回归锚：
  // 错位实现会把第一块的键打到第二块上）
  await expect.poll(
    () => fs.readFileSync(path.join(REPO_DIR, F_DISCARD), 'utf8'),
    { timeout: 5000 },
  ).toContain('alpha two')
  const content = fs.readFileSync(path.join(REPO_DIR, F_DISCARD), 'utf8')
  expect(content).not.toContain('alpha T1')
  expect(content).toContain('omega T1')
  // 暂存区哨兵原样（discard 只动工作区）
  expect(git(REPO_DIR, ['diff', '--cached', '--name-only'])).toBe(F_STAGED)

  // 块处置后内嵌 diff 重拉（status 刷新链触发）：剩余单块仍在，键随行
  await expect(embed.locator('[data-testid="diff-hunk-stage"]')).toHaveCount(1, { timeout: 5000 })

  // 收起零新增请求；再展开重新拉取（懒挂载即重取，不缓存陈旧 diff）。
  // 动作后的重拉次数是实现细节（显式重拉/值变化 watch），以捕获值比较守护
  // 「收起零新增、再展开必重拉」的懒加载语义本身
  const reqsBeforeCollapse = discardDiffReqs
  await row(page, F_DISCARD).locator('.cp-expand-chevron').click()
  await expect(page.locator('[data-testid="cp-inline-diff"]')).toHaveCount(0)
  expect(discardDiffReqs).toBe(reqsBeforeCollapse)
  await expandInlineDiff(page, F_DISCARD)
  await expect.poll(() => discardDiffReqs, { timeout: 5000 }).toBeGreaterThan(reqsBeforeCollapse)
})

test('stage 首块→暂存区只含该块→行状态翻转→内嵌 diff 换侧重拉为取消暂存形态→accordion 单展开', async ({ page }) => {
  await enterProject(page)

  const embed = await expandInlineDiff(page, F_STAGE)
  await expect(embed.locator('[data-testid="diff-hunk-stage"]')).toHaveCount(2, { timeout: 5000 })

  // 暂存第一块（工作区侧键 = 「暂存代码块」）
  await expect(embed.locator('[data-testid="diff-hunk-stage"]').first()).toHaveText('暂存代码块')
  await embed.locator('[data-testid="diff-hunk-stage"]').first().click()

  // 仓库实况：暂存区只含第一块，工作区仍余第二块
  await expect.poll(
    () => git(REPO_DIR, ['diff', '--cached', '--', F_STAGE]),
    { timeout: 5000 },
  ).toContain('alpha T3')
  expect(git(REPO_DIR, ['diff', '--cached', '--', F_STAGE])).not.toContain('omega T3')
  expect(git(REPO_DIR, ['diff', '--', F_STAGE])).toContain('omega T3')

  // status 刷新后行状态翻转（MM → 索引侧单条 staged=true）：行尾 ✓ 暂存态在位
  await expect(row(page, F_STAGE).locator('.cp-stage-toggle.staged')).toBeVisible({ timeout: 5000 })

  // 内嵌 diff 随 staged 翻转换侧重拉：索引侧只有「取消暂存代码块」，无放弃键
  await expect(embed.locator('[data-testid="diff-hunk-stage"]').first()).toHaveText('取消暂存代码块', { timeout: 5000 })
  await expect(embed.locator('[data-testid="diff-hunk-discard"]')).toHaveCount(0)

  // accordion：展开另一文件，先前的展开槽收起（同面板单文件展开）
  await expandInlineDiff(page, F_STAGED)
  await expect(page.locator('[data-testid="cp-inline-diff"]')).toHaveCount(1)
  // 索引侧夹具的内嵌 diff：只有取消暂存键、无放弃键（staged=索引侧语义）
  const stagedEmbed = page.locator('[data-testid="cp-inline-diff"]')
  await expect(stagedEmbed.locator('[data-testid="diff-hunk-stage"]').first()).toHaveText('取消暂存代码块', { timeout: 5000 })
  await expect(stagedEmbed.locator('[data-testid="diff-hunk-discard"]')).toHaveCount(0)
})

test('既有主路径保留：双击文件行仍开编辑器 Diff 标签（chevron 不侵占行双击）', async ({ page }) => {
  await enterProject(page)
  // chevron 单击只切展开态（已由前两例覆盖）；行双击主路径零变化
  await row(page, F_DISCARD).dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
})
