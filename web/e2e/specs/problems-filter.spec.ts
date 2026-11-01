import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 问题面板过滤 E2E（P-20261005-171）：面板头过滤行 = 文本子串（message/path，
 * 大小写不敏感）+ 严重级二态 chip（仅错误/仅警告）正交叠加。造 1 error 2 warning
 * → 过滤收窄显示 n/全量计数 → 仅错误 chip 单条 → 清过滤全量回；StatusBar 徽标
 * 始终全量口径（徽标答「有多少」、过滤答「找哪个」）；过滤态经模块级单例跨面板
 * 显隐保持（切 tab 回来不重置）。警告源 = css worker 的 unknownProperties lint
 * （Warning 级——ts.worker 在本仓 monaco 版本无 Warning 级诊断，全部是 Error/
 * Hint，实测 typescriptServices.js cat 0 计 0 条）。自备临时仓库，afterAll 清理。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-problems-filter')
const PROJ = 'e2e-problems-filter'
const TS_FILE = 'broken.ts'
const CSS_FILE = 'warn.css'
// css unknownProperties lint 消息子串（大小写不敏感匹配的样本）
const WARN_MSG = 'unknown'

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

function makeRepo(dir: string, files: Record<string, string>) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init'], { cwd: dir })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: dir })
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content)
  }
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', 'root: 问题面板过滤基线'])
}

let projId = ''

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  const stale = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
  for (const p of ((stale?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) {
      await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers })
    }
  }
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 残留忽略 */ }

  // broken.ts：1 个语义类型错误；warn.css：2 个未知属性（css worker lint Warning 级）
  makeRepo(REPO, {
    [TS_FILE]: `const topBad: number = 'top type error'\n`,
    [CSS_FILE]: `body {\n  colr: red;\n  margn: 0;\n}\n`,
  })
  projId = await registerProject(headers, PROJ, REPO)
  expect(projId).toBeTruthy()
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
  try { fs.rmSync(REPO, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并依次打开 ts（1 error）与 css（2 warning）文件。
 *  时序纪律：等前一文件诊断落地（徽标计数收敛）再开下一文件——极速连开会
 *  打断语言 worker 的验证调度（problems-panel 同款就绪口径） */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: TS_FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: TS_FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: TS_FILE })).toBeVisible()
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-errors')).toHaveText('1', { timeout: 30000 })
  await page.locator('.file-tree .item-name', { hasText: CSS_FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: CSS_FILE })).toBeVisible()
  // css worker lint 异步产出：warnings 计数收敛到 2 才算就绪
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-warnings')).toHaveText('2', { timeout: 30000 })
}

/** 面板头过滤输入框（placeholder 部分匹配，规避省略号字形差异，changes-filter 同款） */
function filterInput(panel: import('@playwright/test').Locator) {
  return panel.locator('input[placeholder*="过滤"]')
}

test('问题面板过滤：文本/级别正交收窄 n/全量 → 仅错误 chip → 徽标全量不变 → 清过滤全量回', async ({ page }) => {
  // ts.worker + css worker 冷启动与诊断异步产出
  test.setTimeout(180_000)
  await openProjectAndFiles(page)

  // 状态栏徽标 → 打开问题面板
  await page.locator('[data-testid="statusbar-problems"]').click()
  await expect(page.locator('[data-testid="bottom-tab-problems"]')).toHaveClass(/primary/, { timeout: 5000 })
  const panel = page.locator('[data-testid="problems-panel"]')
  await expect(panel).toBeVisible()

  // 基线：1 error + 2 warning 全量显示，两文件组各就位，无过滤计数
  await expect(panel.locator('[data-testid="problems-summary"]')).toHaveText('1 个错误，2 个警告', { timeout: 10000 })
  const groupTs = panel.locator('.pb-file').filter({ hasText: TS_FILE })
  const groupCss = panel.locator('.pb-file').filter({ hasText: CSS_FILE })
  await expect(groupTs).toBeVisible()
  await expect(groupCss).toBeVisible()
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss.locator('.pb-item')).toHaveCount(2)
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveCount(0)

  // 文本过滤（message 子串，大小写不敏感）：仅剩 2 条 warning，计数 2/3
  await filterInput(panel).fill(WARN_MSG)
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('2/3')
  await expect(groupTs).toHaveCount(0)
  await expect(groupCss.locator('.pb-item')).toHaveCount(2)

  // 文本过滤（path 子串）：'broken' 命中 ts 文件路径，仅剩 1 条 error
  await filterInput(panel).fill('broken')
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('1/3')
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss).toHaveCount(0)

  // 清文本 → 全量回（3 条、计数消失）
  await filterInput(panel).fill('')
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveCount(0)
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss.locator('.pb-item')).toHaveCount(2)

  // 仅错误 chip：单条显示，计数 1/3；StatusBar 徽标与头部摘要保持全量口径
  await panel.locator('[data-testid="problems-filter-error"]').click()
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('1/3')
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss).toHaveCount(0)
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-errors')).toHaveText('1')
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-warnings')).toHaveText('2')
  await expect(panel.locator('[data-testid="problems-summary"]')).toHaveText('1 个错误，2 个警告')

  // 会话内保持：切走面板再切回（v-else-if 卸载重挂），过滤态不重置
  await page.locator('[data-testid="bottom-tab-console"]').click()
  await expect(panel).toHaveCount(0)
  await page.locator('[data-testid="bottom-tab-problems"]').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-testid="problems-filter-error"]')).toHaveClass(/active/)
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('1/3')

  // 再点激活 chip 回落全部（二态）：全量回
  await panel.locator('[data-testid="problems-filter-error"]').click()
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveCount(0)
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss.locator('.pb-item')).toHaveCount(2)

  // 无命中诚实空态：文案指过滤（≠ 无诊断），打开文件提示不出现
  await filterInput(panel).fill('zzz-no-match')
  await expect(panel.locator('.pb-empty')).toContainText('没有诊断匹配当前过滤')
  await expect(panel.locator('.pb-empty-hint')).toHaveCount(0)
  await expect(panel.locator('.pb-item')).toHaveCount(0)
  // 徽标仍全量
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-errors')).toHaveText('1')
  await filterInput(panel).fill('')
  await expect(groupTs.locator('.pb-item')).toHaveCount(1)
  await expect(groupCss.locator('.pb-item')).toHaveCount(2)
})

test('仅警告 chip 与文本过滤正交叠加：AND 收窄到交集', async ({ page }) => {
  test.setTimeout(180_000)
  await openProjectAndFiles(page)

  await page.locator('[data-testid="statusbar-problems"]').click()
  const panel = page.locator('[data-testid="problems-panel"]')
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-testid="problems-summary"]')).toHaveText('1 个错误，2 个警告', { timeout: 10000 })

  // 仅警告 chip：2 条 warning
  await panel.locator('[data-testid="problems-filter-warning"]').click()
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('2/3')
  await expect(panel.locator('.pb-item')).toHaveCount(2)

  // 叠加文本 'broken'（只命中 ts 路径）：AND 交集为空 → 诚实空态
  await filterInput(panel).fill('broken')
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('0/3')
  await expect(panel.locator('.pb-empty')).toContainText('没有诊断匹配当前过滤')

  // 两 chip 互斥：切到仅错误 = 覆盖 warning 作用域，交集变 1 条 error
  await panel.locator('[data-testid="problems-filter-error"]').click()
  await expect(panel.locator('[data-testid="problems-filter-error"]')).toHaveClass(/active/)
  await expect(panel.locator('[data-testid="problems-filter-warning"]')).not.toHaveClass(/active/)
  await expect(panel.locator('[data-testid="problems-filter-count"]')).toHaveText('1/3')
})
