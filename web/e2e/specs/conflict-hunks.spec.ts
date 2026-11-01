import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 逐块冲突解决 E2E（P-20261003-59；diff3/zdiff3 逐块 P-20261004-28）：同一文件
 * 两处独立改动（value 区 / flag 区）各自双侧修改 → merge 产出一个文件两块冲突
 * （形态已本地 git 实证）：
 *   1. 逐块模式：块 1 取我方 + 块 2 取他方 → 应用解决 → 磁盘精确合成、无 marker 残留
 *   2. 手动编辑块：未全解决时应用按钮禁用 → 手动稿参与合成精确落盘
 *   3. diff3 形态逐块三选（P-20261004-28 起不再降级）：||||||| 基准段折叠展示
 *      可展开 → 三选解决后磁盘精确合成、marker 与 base 段零残留
 *   4. zdiff3 空基准段形态（共同行外提）：逐块可用且无基线条、取我方后外提共同行保留
 *   5. 不可信形态降级：嵌套标记触发 complex → 无逐块入口 + 降级提示 +
 *      既有整文件「采用我方」仍可解决（守卫不崩）
 * 环境敏感点同 conflict-view.spec.ts：仓库放系统临时目录、服务端形态路径注册。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REPO_DIR = path.join(process.env.TEMP || osTmp(), 'sc-e2e-conflict-hunks')
const PROJ_NAME = 'conflict-hunks-demo'
const FILE = 'mixed.txt'
const ZFILE = 'zseed.txt'

function osTmp(): string {
  return process.env.TEMP || '/tmp'
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args], {
    cwd, encoding: 'utf8',
  })
}

async function unlockHeaders(request: import('@playwright/test').APIRequestContext) {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 重建「两个独立区域各双侧修改」的合并冲突（abort → 回 main edit → 再 merge），
// style='merge' 双子段形态；'diff3'/'zdiff3' 经 -c merge.conflictStyle 触发
// 基准段形态（服务端 P-20261004-28 起逐块可解析，zdiff3 与 diff3 五标记同形）
function seedConflict(style: 'merge' | 'diff3' | 'zdiff3') {
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainEditHash])
  const styleArgs = style === 'merge' ? [] : ['-c', `merge.conflictStyle=${style}`]
  let merged = false
  try {
    git(REPO_DIR, [...styleArgs, 'merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected merge conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes('UU')) throw new Error('expected UU conflict entry, got: ' + status)
}

// 重建 zdiff3 专属形态的冲突（zseed.txt：双方在 p 后同位置插入、共享尾行 COMMON，
// zdiff3 的 zealotry 简化把共同行外提到标记外 → 「空基准段 + 外提上下文行」，
// git 2.45 本地实证）。zseed 提交挂在两分支 tip（mainEditHash 之后），不混入
// mixed.txt 种子的 reset 基准——merge feature 时对 mixed.txt 仍是既有冲突形态，
// zseed.txt 仅在本函数回到 zseed 提交再合并时冲突
function seedZdiff3Conflict() {
  try { git(REPO_DIR, ['merge', '--abort']) } catch { /* 非合并中忽略 */ }
  git(REPO_DIR, ['reset', '--hard', mainZSeedHash])
  let merged = false
  try {
    git(REPO_DIR, ['-c', 'merge.conflictStyle=zdiff3', 'merge', 'feature'])
    merged = true
  } catch { /* 冲突即预期：非零退出 */ }
  if (merged) throw new Error('expected zdiff3 conflict did not happen')
  const status = git(REPO_DIR, ['status', '--porcelain'])
  if (!status.includes(ZFILE)) throw new Error('expected zseed.txt UU entry, got: ' + status)
}

let projectId = ''
let mainEditHash = ''
let mainZSeedHash = ''

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const list = await (await request.get(`${BASE}/api/projects`, { headers })).json()
  for (const p of ((list?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ_NAME) await request.delete(`${BASE}/api/projects/${p.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  // base：两个可独立冲突的区域相隔 6 行稳定行（避免被 git 合并为单一冲突块）；
  // zseed.txt 供 zdiff3 形态用例（p 后同位置插入 + 共享尾行）
  const baseContent = [
    'line01: shared', 'value = base', 'line03: shared', 'line04: shared',
    'line05: shared', 'line06: shared', 'line07: shared', 'line08: shared',
    'flag = base', 'line10: shared', '',
  ].join('\n')
  fs.writeFileSync(path.join(REPO_DIR, FILE), baseContent)
  fs.writeFileSync(path.join(REPO_DIR, ZFILE), 'p\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'base'])
  git(REPO_DIR, ['checkout', '-b', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), baseContent
    .replace('value = base', 'value = feature')
    .replace('flag = base', 'flag = feature'))
  git(REPO_DIR, ['commit', '-qam', 'feature edit'])
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), baseContent
    .replace('value = base', 'value = main')
    .replace('flag = base', 'flag = main'))
  git(REPO_DIR, ['commit', '-qam', 'main edit'])
  mainEditHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  // zdiff3 种子提交：挂在两分支 tip（mainEditHash 之后），mixed 种子的 reset
  // 基准不涉及它们——seedConflict('merge') 时 zseed 仅 feature 侧变更、干净并入
  git(REPO_DIR, ['checkout', 'feature'])
  fs.writeFileSync(path.join(REPO_DIR, ZFILE), 'p\nY\nCOMMON\n')
  git(REPO_DIR, ['commit', '-qam', 'feature zseed'])
  git(REPO_DIR, ['checkout', 'main'])
  fs.writeFileSync(path.join(REPO_DIR, ZFILE), 'p\nX\nCOMMON\n')
  git(REPO_DIR, ['commit', '-qam', 'main zseed'])
  mainZSeedHash = git(REPO_DIR, ['rev-parse', 'HEAD']).trim()
  seedConflict('merge')

  const created = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR).replace(/\\/g, '/') },
  })
  const body = (await created.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  if (!projectId) throw new Error('project registration failed')
})

test.afterAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  if (projectId) await request.delete(`${BASE}/api/projects/${projectId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

// 幂等打开 Git 面板并展开冲突面板（同 conflict-view.spec.ts：rail 是 toggle，
// 以冲突面板标题可见为收敛目标循环重试）
async function openConflictPanel(page: Parameters<typeof gotoAndUnlock>[0]) {
  test.setTimeout(90000) // 打开 + 模式切换 + 收敛循环 + 写回断言的预算
  const banner = page.locator('.conflict-banner')
  const panelTitle = page.getByText('冲突文件', { exact: true })
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await panelTitle.isVisible().catch(() => false)) return
    if (await banner.isVisible().catch(() => false)) {
      await banner.click()
      await expect(panelTitle).toBeVisible({ timeout: 3000 })
      return
    }
    const rail = page.locator('.rail-btn[title="Git 管理"]')
    if ((await rail.getAttribute('aria-expanded').catch(() => null)) !== 'true') {
      await rail.click()
    }
    await page.waitForTimeout(1500)
  }
  await expect(banner).toBeVisible({ timeout: 10000 })
}

async function enterProjectAndPanel(page: Parameters<typeof gotoAndUnlock>[0]) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  await openConflictPanel(page)
}

test('逐块解决：两块分别取我方/他方 → 应用解决 → 磁盘精确合成无 marker 残留', async ({ page }) => {
  await enterProjectAndPanel(page)
  // 进入逐块模式（默认三方对比——既有整文件模式保持默认，逐块为显式入口）
  await page.locator('[data-test="conflict-mode-hunks"]').click()
  const blocks = page.locator('[data-test="conflict-hunk-block"]')
  await expect(blocks).toHaveCount(2, { timeout: 10000 })
  // 两块的行范围标签（<<<<<<< 到 >>>>>>> 含两端标记行）
  await expect(blocks.nth(0).getByText('第 2-6 行')).toBeVisible()
  await expect(blocks.nth(1).getByText('第 13-17 行')).toBeVisible()
  // 未全解决前应用禁用（防半解决态写回）
  const applyBtn = page.getByRole('button', { name: '应用解决' })
  await expect(applyBtn).toBeDisabled()
  // 块 1 取我方：解决态勾选出现，应用仍禁用
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  await expect(blocks.nth(0).locator('[data-test="conflict-hunk-resolved"]')).toBeVisible()
  await expect(applyBtn).toBeDisabled()
  // 块 2 取他方 → 全部解决 → 应用
  await blocks.nth(1).getByRole('button', { name: '取他方' }).click()
  await expect(blocks.nth(1).locator('[data-test="conflict-hunk-resolved"]')).toBeVisible()
  await expect(applyBtn).toBeEnabled()
  await applyBtn.click()
  // 冲突清零（横幅卸载）+ 磁盘精确等于逐块合成结果（区域 1 我方、区域 2 他方）
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toBe([
    'line01: shared', 'value = main', 'line03: shared', 'line04: shared',
    'line05: shared', 'line06: shared', 'line07: shared', 'line08: shared',
    'flag = feature', 'line10: shared', '',
  ].join('\n'))
  expect(content).not.toContain('<<<<<<<')
})

test('手动编辑块：未全解决禁用应用 → 手动稿参与合成精确落盘', async ({ page }) => {
  seedConflict('merge')
  await enterProjectAndPanel(page)
  await page.locator('[data-test="conflict-mode-hunks"]').click()
  const blocks = page.locator('[data-test="conflict-hunk-block"]')
  await expect(blocks).toHaveCount(2, { timeout: 10000 })
  // 块 1 取我方；块 2 手动编辑：预填我方稿，改写为手动合并内容
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  await blocks.nth(1).getByRole('button', { name: '手动编辑' }).click()
  const manualBox = blocks.nth(1).locator('textarea')
  await expect(manualBox).toBeVisible()
  await manualBox.fill('flag = manually merged')
  const applyBtn = page.getByRole('button', { name: '应用解决' })
  await expect(applyBtn).toBeEnabled()
  await applyBtn.click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toContain('value = main')
  expect(content).toContain('flag = manually merged')
  expect(content).not.toContain('<<<<<<<')
})

test('diff3 逐块三选：基线段折叠展示可展开 → 解决后磁盘精确合成、marker 与 base 段零残留', async ({ page }) => {
  seedConflict('diff3')
  await enterProjectAndPanel(page)
  // diff3（||||||| 基准段）P-20261004-28 起逐块可解析：逐块入口在场、无降级提示
  await page.locator('[data-test="conflict-mode-hunks"]').click()
  const blocks = page.locator('[data-test="conflict-hunk-block"]')
  await expect(blocks).toHaveCount(2, { timeout: 10000 })
  await expect(page.locator('[data-test="conflict-complex-hint"]')).toHaveCount(0)
  // 基线段默认折叠弱化：条在场（每块一条）、正文不可见（v-show 折叠）；
  // 多元素断言用 :visible 计数规避 strict mode
  const baseToggles = page.locator('[data-test="conflict-hunk-base-toggle"]')
  await expect(baseToggles).toHaveCount(2)
  await expect(page.locator('[data-test="conflict-hunk-base-text"]:visible')).toHaveCount(0)
  await expect(baseToggles.nth(0)).toHaveAttribute('aria-expanded', 'false')
  await blocks.nth(0).locator('[data-test="conflict-hunk-base-toggle"]').click()
  await expect(baseToggles.nth(0)).toHaveAttribute('aria-expanded', 'true')
  await expect(blocks.nth(0).locator('[data-test="conflict-hunk-base-text"]')).toBeVisible()
  await expect(blocks.nth(0).locator('[data-test="conflict-hunk-base-text"]')).toHaveText('value = base')
  await expect(blocks.nth(1).locator('[data-test="conflict-hunk-base-text"]')).toBeHidden()
  // 三选照常：块 1 取我方 + 块 2 取他方 → 应用 → 磁盘 = 混合解（基准段整体剔除）
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  await blocks.nth(1).getByRole('button', { name: '取他方' }).click()
  await page.getByRole('button', { name: '应用解决' }).click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toBe([
    'line01: shared', 'value = main', 'line03: shared', 'line04: shared',
    'line05: shared', 'line06: shared', 'line07: shared', 'line08: shared',
    'flag = feature', 'line10: shared', '',
  ].join('\n'))
  expect(content).not.toContain('<<<<<<<')
  expect(content).not.toContain('|||||||')
  expect(content).not.toContain('value = base')
})

test('zdiff3 空基线外提形态：逐块可用且无基线条，取我方后外提共同行保留', async ({ page }) => {
  seedZdiff3Conflict()
  await enterProjectAndPanel(page)
  // 冲突集含 mixed.txt 与 zseed.txt（porcelain 序前者在前）——切到 zseed.txt。
  // 冲突列表行用 title 属性定位：侧栏文件树存在同名条目，getByText 会歧义命中
  const zseedRow = page.locator('span[title="zseed.txt"]')
  await zseedRow.click()
  await page.locator('[data-test="conflict-mode-hunks"]').click()
  const blocks = page.locator('[data-test="conflict-hunk-block"]')
  await expect(blocks).toHaveCount(1, { timeout: 10000 })
  // zealotry 外提后基准区无剩余行：base 空串 → 无基线条（不渲染空折叠钮）
  await expect(page.locator('[data-test="conflict-hunk-base"]')).toHaveCount(0)
  // 取我方 → 应用：外提到标记外的 COMMON 是上下文行，写回后原样保留。
  // 同步点用「zseed 行从文件列表消失」（afterResolve 重取冲突集；mixed.txt 仍
  // UU，逐块列表会切到它的块，不能拿块清零当同步点）
  await blocks.nth(0).getByRole('button', { name: '取我方' }).click()
  await page.getByRole('button', { name: '应用解决' }).click()
  await expect(zseedRow).toBeHidden({ timeout: 10000 })
  const zcontent = fs.readFileSync(path.join(REPO_DIR, ZFILE), 'utf8')
  expect(zcontent).toBe('p\nX\nCOMMON\n')
  expect(zcontent).not.toContain('<<<<<<<')
  expect(zcontent).not.toContain('|||||||')
})

test('不可信形态降级：嵌套标记触发 complex → 无逐块入口 + 降级提示 + 整文件模式仍可解决', async ({ page }) => {
  seedConflict('merge')
  // 覆写工作区为嵌套标记形态（index 仍 UU，冲突列表照常出该文件）——
  // 嵌套是任何 git conflictStyle 都不产出的不可信形态，保持降级（安全边界不放宽）
  fs.writeFileSync(path.join(REPO_DIR, FILE), [
    '<<<<<<< HEAD',
    'ours top',
    '<<<<<<< inner',
    'inner ours',
    '=======',
    'inner theirs',
    '>>>>>>> inner',
    '=======',
    'theirs top',
    '>>>>>>> feature',
    '',
  ].join('\n'))
  await enterProjectAndPanel(page)
  // 嵌套标记 → 服务端 complex=true：无逐块按钮、无块列表，降级提示在场
  await expect(page.locator('[data-test="conflict-mode-hunks"]')).toHaveCount(0)
  await expect(page.locator('[data-test="conflict-complex-hint"]')).toBeVisible({ timeout: 10000 })
  await expect(page.locator('[data-test="conflict-hunk-block"]')).toHaveCount(0)
  // 降级路径完好：既有整文件「采用我方」一键解决
  await page.getByRole('button', { name: '采用我方' }).first().click()
  await expect(page.locator('.conflict-banner')).toBeHidden({ timeout: 10000 })
  const content = fs.readFileSync(path.join(REPO_DIR, FILE), 'utf8')
  expect(content).toContain('value = main')
  expect(content).toContain('flag = main')
  expect(content).not.toContain('<<<<<<<')
  expect(content).not.toContain('|||||||')
})
