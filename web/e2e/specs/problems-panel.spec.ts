import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 问题面板 E2E（P-20261003-297）：Monaco 诊断（ts.worker markers）聚合底栏。
 * 打开含类型错误的 ts 文件 → StatusBar 徽标出现错误计数 → 点击开问题面板 →
 * 面板按文件分组列出条目（严重级/行列/消息）→ 点击深行条目跳到目标行
 * （Monaco 虚拟化下未 reveal 不渲染，断言锚点行出现在 .view-lines 即证明定位
 * 生效，与 todo-panel 深行锚点同款）。自备临时仓库，afterAll 清理。
 */

const REPO = path.join(os.tmpdir(), 'sc-e2e-problems-panel')
const PROJ = 'e2e-problems-panel'
const FILE_A = 'broken.ts'
// 文件名避开 'broken.ts' 子串（面板分组 hasText 过滤用）
const FILE_B = 'flag.ts'
// 深行锚点：1 行顶部错误 + 1 行 filler + 150 行 pad 后第 153 行（Monaco 虚拟化定位断言用）
const DEEP_LINE = 153
const DEEP_ANCHOR = 'deep anchor type error'

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
  git(dir, ['commit', '-m', 'root: 问题面板基线'])
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

  // broken.ts：两个语义类型错误（TS2322）——第 1 行 + 第 153 行深行锚点；
  // flag.ts：第三个错误——两文件同开验证跨文件聚合与计数
  const pad = Array.from({ length: 150 }, (_, i) => `// pad ${i + 1}\n`).join('')
  makeRepo(REPO, {
    [FILE_A]: `const topBad: number = 'top type error'\n// filler\n${pad}const deepBad: number = '${DEEP_ANCHOR}'\n`,
    [FILE_B]: `export const flag: number = true\n`,
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

/** 打开项目并经文件树依次打开两个含错文件。
 *  时序纪律：等 broken.ts 的诊断落地（徽标 errors=2）再开 flag.ts——
 *  极速连开时后开文件会打断前者的 ts.worker 验证调度，其 markers 要到
 *  该签重新激活才补产（monaco DiagnosticsAdapter 的既有交互，非聚合层
 *  问题）；等首文件稳定后计数收敛才可断言 */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await expect(page.locator('[data-testid="statusbar-problems"] .problems-errors')).toHaveText('2', { timeout: 30000 })
  await page.locator('.file-tree .item-name', { hasText: FILE_B }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toBeVisible()
}

test('问题面板：状态栏徽标计数 → 面板分组条目 → 点击深行条目定位到行', async ({ page }) => {
  // 默认 30s 不够：ts.worker 冷启动 + 语义诊断异步产出 + 深行定位全流程
  test.setTimeout(120_000)
  await openProjectAndFiles(page)

  // ts.worker 语义诊断异步产出：状态栏徽标出现，错误计数 = broken.ts 2 + flag.ts 1
  const statusBtn = page.locator('[data-testid="statusbar-problems"]')
  await expect(statusBtn).toBeVisible({ timeout: 30000 })
  await expect(statusBtn.locator('.problems-errors')).toHaveText('3', { timeout: 30000 })
  await expect(statusBtn.locator('.problems-warnings')).toHaveText('0')

  // 点击状态栏徽标 → 底部面板打开且落在问题 tab
  await statusBtn.click()
  await expect(page.locator('[data-testid="bottom-tab-problems"]')).toHaveClass(/primary/, { timeout: 5000 })
  const panel = page.locator('[data-testid="problems-panel"]')
  await expect(panel).toBeVisible()

  // 头部摘要与诚实边界注记
  await expect(panel.locator('[data-testid="problems-summary"]')).toHaveText('3 个错误，0 个警告', { timeout: 10000 })
  await expect(panel.locator('.pb-scope-note')).toBeVisible()

  // 文件分组：broken.ts 2 条在前，flag.ts 1 条
  const groupA = panel.locator('.pb-file').filter({ hasText: FILE_A })
  const groupB = panel.locator('.pb-file').filter({ hasText: FILE_B })
  await expect(groupA).toBeVisible()
  await expect(groupB).toBeVisible()
  await expect(groupA.locator('.pb-item')).toHaveCount(2)
  await expect(groupB.locator('.pb-item')).toHaveCount(1)
  // 严重级徽标（中文语义文案）
  await expect(groupA.locator('.pb-badge').first()).toHaveText('错误')
  // 条目定位信息 = 行:列（TS2322 落在字面量上，列随内容；断言行前缀防脆）
  await expect(groupA.locator(`[data-testid="problems-item-${DEEP_LINE}"]`).locator('.pb-pos')).toHaveText(new RegExp(`^${DEEP_LINE}:`))

  // 点击深行锚点条目 → 打开 broken.ts 并定位：未 reveal 时虚拟化不渲染，
  // 锚点文本出现在 .view-lines 即证明行定位生效
  await groupA.locator(`[data-testid="problems-item-${DEEP_LINE}"]`).click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(DEEP_ANCHOR, { timeout: 15000 })
})
