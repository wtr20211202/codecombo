import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * DiffViewer 字号跟随设置 E2E（P-20261004-104）：diff 字号档（设置→外观「差异对比」
 * 滑条，stores/font.ts sizes.diff）真正生效于 DiffViewer——提案动机是弱视用户调大
 * 字号后 diff 不再是 12px 硬编码孤岛。守护链（一条用户旅程）：
 *   ① 默认档（13px→行槽 20px）窗口内容/行号对位（深滚虚拟化不串行）；
 *   ② 设置滑条调大到 24px：同一挂载实例行高联动变 36px、字号/行号列宽随动
 *      （--fs-diff / --diff-line-h / --diff-line-no-w 同源换算，虚拟列表随行高
 *      整只重建——不重挂不刷新）；
 *   ③ 新行高下深滚定位不乱（scrollTop↔行下标按新行高换算，内容/行号/行高对位）；
 *   ④ 调回默认恢复 20px、字号回 13px。
 * 夹具 = 400 行基线 + 尾部追加 1200 行（单大 add 块），内联 diff 槽内深滚空间充足；
 * 扁平序列几何与 diff-side-virtual 同款现算（服务端 diff 解析同口径），不硬编码。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-font-follow')
const PROJ = 'e2e-diff-font-follow'
const FILE = 'grow.txt'

const BASE_LINES = 400
const ADD_LINES = 1200
const PROBE_K = 600
const PROBE = `added-${String(PROBE_K).padStart(6, '0')}`
const PROBE_LINE_NO = String(BASE_LINES + PROBE_K) // 新文件行号 = 基线 + 追加序

// 行槽换算与 DiffViewer DIFF_LINE_HEIGHT 同款（字号 × 1.5，Math.round 整数行槽）；
// 字号源 = stores/font.ts FONT_DEFAULTS.diff（不预置字号时 load 合并出的生效档）
const DIFF_FONT_DEFAULT = 13
const ROW_H_DEFAULT = Math.round(DIFF_FONT_DEFAULT * 1.5)
const DIFF_FONT_LARGE = 24
const ROW_H_LARGE = Math.round(DIFF_FONT_LARGE * 1.5)

const c1Lines = Array.from({ length: BASE_LINES }, (_, i) => `line-${String(i + 1).padStart(4, '0')}`)
const addedLines = Array.from({ length: ADD_LINES }, (_, i) => `added-${String(i + 1).padStart(6, '0')}`)
const C1_CONTENT = c1Lines.join('\n') + '\n'
const C2_CONTENT = [...c1Lines, ...addedLines].join('\n') + '\n'

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

// ── 扁平序列几何（与 DiffViewer 解析同口径现算）：header/@@/正文各占一槽、空行无槽 ──
interface DiffGeometry {
  addedFlat: Map<number, number> // 追加行序 k → flat 下标
}
let geometry: DiffGeometry

async function fetchWorkdirGeometry(headers: Record<string, string>): Promise<DiffGeometry> {
  const res = await fetch(`${API_BASE}/api/projects/${projectId}/file/diff?file=${encodeURIComponent(FILE)}&staged=false`, { headers })
  expect(res.ok).toBeTruthy()
  const text = (((await res.json()) as { data?: string }).data) || ''
  expect(text.length).toBeGreaterThan(ADD_LINES * 10) // 1200 行补丁确实在位

  const geo: DiffGeometry = { addedFlat: new Map() }
  let flat = 0
  for (const raw of text.split('\n')) {
    const slot = flat
    if (/^(--- |\+\+\+ |diff |index |Binary files)/.test(raw)) {
      // header 行占槽
    } else if (/^@@ /.test(raw)) {
      // hunk 头占槽
    } else if (raw !== '') {
      const m = raw.match(/^\+added-(\d{6})$/)
      if (m) geo.addedFlat.set(parseInt(m[1]!, 10), slot)
    }
    if (raw !== '') flat++
  }
  return geo
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  git(REPO_DIR, ['init', '-b', 'main'])
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // 双路径：Windows 服务端 git 也不 smudge
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline 400 lines'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT) // 工作区尾部追加 1200 行（未暂存）

  const res = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''
  expect(projectId).not.toBe('')

  geometry = await fetchWorkdirGeometry(headers)
  // 夹具形态守卫：追加行槽全部解析在位
  expect(geometry.addedFlat.size).toBe(ADD_LINES)
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

// ── 页面驱动 ──

/** 进项目 + 打开提交面板 + 展开目标文件内联 diff（真实 useVirtualList 路径） */
async function openInlineDiff(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击，先收起
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  // rail「提交」是 toggle（uiState 恢复态不定）→ 循环归一化到面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-panel').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="提交"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.commit-panel')).toBeVisible()
  const row = page.locator('.cp-node').filter({ hasText: FILE }).first()
  await expect(row).toBeVisible({ timeout: 10000 })
  await row.locator('.cp-expand-chevron').click()
  const embed = page.locator('[data-testid="cp-inline-diff"]')
  await expect(embed).toBeVisible()
  await expect(embed.locator('.diff-line').first()).toBeVisible({ timeout: 10000 })
  return embed
}

/** unified 行槽高（DiffViewer 行内钉高 = DIFF_LINE_HEIGHT） */
function rowHeight(embed: import('@playwright/test').Locator) {
  return embed.locator('.diff-line').first().evaluate((el) => el.getBoundingClientRect().height)
}

/** 行内容字号（var(--fs-diff) 生效面） */
function contentFontSize(embed: import('@playwright/test').Locator) {
  return embed.locator('.diff-line-content').first().evaluate((el) => getComputedStyle(el).fontSize)
}

/** 行号列宽（--diff-line-no-w 生效面；.diff-line-no inline-block 定宽） */
function lineNoWidth(embed: import('@playwright/test').Locator) {
  return embed.locator('.diff-line-no').first().evaluate((el) => el.getBoundingClientRect().width)
}

/** 滚动容器 = 行元素的 wrapper(父) 的父容器（unified 容器 div，overflow auto） */
async function scrollInlineTop(embed: import('@playwright/test').Locator, top: number) {
  await embed.locator('.diff-line').first().evaluate((el, t) => {
    (el.parentElement!.parentElement! as HTMLElement).scrollTop = t as number
  }, top)
}

/** 深滚到目标行并实测位差回补收敛（hunk 按钮行是扁平序列外的额外行槽，
 *  首轮必偏一行高量级——回补循环与 diff-side-virtual 同款，容忍 ≤2 行槽）。
 *  返回稳定后的位差 */
async function settleAtProbe(embed: import('@playwright/test').Locator, top: number) {
  await scrollInlineTop(embed, top)
  for (let i = 0; i < 6; i++) {
    await expect(embed.locator('.diff-line-content').getByText(PROBE, { exact: true })).toBeVisible()
    const drift = await embed.locator('.diff-line').filter({ hasText: PROBE }).last().evaluate((el) => {
      const container = el.parentElement!.parentElement! as HTMLElement
      return el.getBoundingClientRect().top - container.getBoundingClientRect().top
    })
    if (Math.abs(drift) <= ROW_H_LARGE * 2) return drift
    await scrollInlineTop(embed, top + drift)
  }
  throw new Error(`scroll settle failed: ${PROBE} 未在 6 轮位差回补内收敛`)
}

/** 探针行对位：内容=added-k、行号=基线+k、行高=期望行槽（内容/行号/几何三面对位） */
async function expectProbeAligned(embed: import('@playwright/test').Locator, expectedRowH: number) {
  const row = embed.locator('.diff-line').filter({ hasText: PROBE }).last()
  await expect(row).toBeVisible()
  await expect(row.locator('.diff-line-no').nth(1)).toHaveText(PROBE_LINE_NO)
  expect(await row.evaluate((el) => el.getBoundingClientRect().height)).toBe(expectedRowH)
}

/** 设置→外观「差异对比」滑条写 diff 字号档（fontStore.setSize 正门，即时生效），
 *  关闭弹窗返回；滑条值读数断言即操作反馈 */
async function setDiffFont(page: import('@playwright/test').Page, size: number) {
  await page.locator('[data-testid="rail-settings"]').click()
  const modal = page.locator('.n-modal.settings-modal')
  await expect(modal).toBeVisible({ timeout: 3000 })
  await modal.locator('.settings-nav .nav-item').filter({ hasText: '外观' }).click()
  const diffRow = modal.locator('[data-testid="settings-pane-appearance"] .slider-row').filter({ hasText: '差异对比' })
  await diffRow.locator('input.font-slider').evaluate((el, v) => {
    const input = el as HTMLInputElement
    input.value = String(v)
    input.dispatchEvent(new Event('input', { bubbles: true })) // @input → setSize('diff', v)
  }, size)
  await expect(diffRow.locator('.slider-value')).toHaveText(`${size}px`)
  await modal.locator('.settings-close').click()
  await expect(modal).toHaveCount(0)
}

test('diff 字号调大：行高/字号/行号列宽联动且深滚定位不乱；调回恢复', async ({ page }) => {
  // ① 默认档基线：行槽 20px、字号 13px，深滚探针行三面对位
  const embed = await openInlineDiff(page)
  expect(await rowHeight(embed)).toBe(ROW_H_DEFAULT)
  expect(await contentFontSize(embed)).toBe(`${DIFF_FONT_DEFAULT}px`)
  const flatProbe = geometry.addedFlat.get(PROBE_K)!
  await settleAtProbe(embed, flatProbe * ROW_H_DEFAULT)
  await expectProbeAligned(embed, ROW_H_DEFAULT)

  // ② 设置滑条调大（24px）：同一挂载实例行高联动 36px、字号/行号列宽随动
  //    （虚拟列表随行高整只重建——不重挂页面，内联 diff 展开态保持）
  await setDiffFont(page, DIFF_FONT_LARGE)
  await expect(embed.locator('.diff-line').first()).toBeVisible()
  expect(await rowHeight(embed)).toBe(ROW_H_LARGE)
  expect(await contentFontSize(embed)).toBe(`${DIFF_FONT_LARGE}px`)
  expect(await lineNoWidth(embed)).toBeGreaterThan(60) // 5 位数行号在大字档不再被 50px 截断

  // ③ 新行高下深滚定位不乱：scrollTop↔行下标按 36px 换算，探针行三面对位
  await settleAtProbe(embed, flatProbe * ROW_H_LARGE)
  await expectProbeAligned(embed, ROW_H_LARGE)

  // ④ 调回默认：行槽/字号恢复基线，顶部窗口内容正常（回 0 后 header 行在位）
  await setDiffFont(page, DIFF_FONT_DEFAULT)
  expect(await rowHeight(embed)).toBe(ROW_H_DEFAULT)
  expect(await contentFontSize(embed)).toBe(`${DIFF_FONT_DEFAULT}px`)
  await scrollInlineTop(embed, 0)
  await expect(embed.locator('.diff-line-content').first()).toContainText('grow.txt')
})
