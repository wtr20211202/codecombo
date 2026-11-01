import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器 sticky scroll 开关 E2E（P-20261001-14）：
 *   ① 默认开启：长文件滚到深处，外层作用域签名钉在编辑器顶部（Monaco .sticky-widget），
 *      设置 → 外观中开关呈勾选态
 *   ② 关闭开关即时生效（作用于已打开的编辑器，无需重开文件/标签）
 *   ③ 持久化：localStorage font-settings 落盘，刷新后重开文件仍关闭；再打开恢复显示
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-sticky-scroll')
const PROJ = 'e2e-sticky-scroll'
const FILE = 'sticky-fixture.ts'
const SCOPE = 'finalScope'

// 长文件：末尾 finalScope 函数体足够长，Ctrl+End 后其签名位于视口上方
// → sticky scroll 应把「export function finalScope」钉在顶部
function buildFixture(): string {
  const filler = (fn: string, bodyLines: number) => {
    const lines = [`export function ${fn}(): number {`, `  let acc = 0`]
    for (let i = 0; i < bodyLines; i++) lines.push(`  acc += ${i} // filler`)
    lines.push('  return acc', '}', '')
    return lines.join('\n')
  }
  return [
    `// sticky scroll fixture：滚动后外层作用域签名应钉在编辑器顶部`,
    '',
    filler('earlyScope', 20),
    filler('middleScope', 20),
    filler(SCOPE, 60),
  ].join('\n')
}

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

let projectId = ''

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), buildFixture())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: sticky scroll 基线'])
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

/** 打开项目并经文件树打开夹具文件（幂等：已开只会被激活） */
async function openProjectAndFile(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible()
}

/** 编辑器聚焦并滚到文件末尾（光标入 finalScope 体内，签名在视口上方） */
async function scrollToBottom(page: import('@playwright/test').Page) {
  await page.locator('.pane-primary .monaco-editor .view-lines').click()
  await page.keyboard.press('Control+End')
}

/** 打开设置 → 外观分区，返回 sticky scroll 开关行 */
async function stickyToggleRow(page: import('@playwright/test').Page) {
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 导航序：通用/外观/终端/Git/远程…（SettingsModal tabs 定义序）
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('.settings-content .setting-row', { hasText: '固定滚动' })
  await expect(row).toBeVisible({ timeout: 3000 })
  return row
}

test('默认开启：长文件滚动后当前作用域钉在顶部，设置项勾选', async ({ page }) => {
  await openProjectAndFile(page)
  await scrollToBottom(page)

  // Monaco sticky widget 出现且钉着 finalScope 签名（折叠范围由 TS worker 异步计算，放宽超时）
  const widget = page.locator('.pane-primary .sticky-widget')
  await expect(widget).toBeVisible({ timeout: 15000 })
  await expect(widget).toContainText(`export function ${SCOPE}`)

  // 设置 → 外观：开关默认勾选
  const row = await stickyToggleRow(page)
  await expect(row.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('开关关闭即时生效并持久化：刷新重开仍关，再打开恢复', async ({ page }) => {
  await openProjectAndFile(page)
  await scrollToBottom(page)
  const widget = page.locator('.pane-primary .sticky-widget')
  await expect(widget).toBeVisible({ timeout: 15000 }) // 基线：默认开时可见

  // 关闭开关（编辑器行为类选项直写 store 即时生效，不参与设置弹窗脏护栏）
  const row = await stickyToggleRow(page)
  await row.locator('.n-checkbox').click()
  await expect(row.locator('.n-checkbox')).not.toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })

  // 即时生效：已打开的编辑器上 widget 消失
  await expect(widget).toBeHidden()

  // 持久化落盘：font-settings 记录 stickyScroll:false
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('font-settings') || '{}'))
  expect((saved as { editor?: { stickyScroll?: boolean } }).editor?.stickyScroll).toBe(false)

  // 刷新后：tab 由 uiState 自动恢复，仍关闭（存档默认合并路径 + create 路径注入）
  await page.reload()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE })).toBeVisible({ timeout: 15000 })
  await scrollToBottom(page)
  await expect(page.locator('.pane-primary .sticky-widget')).toHaveCount(0)

  // 再打开开关：widget 恢复显示（update 路径注入；重挂载后需一次滚动事件触发重渲染，
  // 底部 Ctrl+End 不再产生 scrollTop 变化，用 wheel 上滚——finalScope 起点仍在视口上方）
  const row2 = await stickyToggleRow(page)
  await row2.locator('.n-checkbox').click()
  await expect(row2.locator('.n-checkbox')).toHaveClass(/n-checkbox--checked/)
  await page.keyboard.press('Escape')
  await page.locator('.pane-primary .monaco-editor .view-lines').click()
  await page.mouse.wheel(0, -120)
  const widget2 = page.locator('.pane-primary .sticky-widget')
  await expect(widget2).toBeVisible({ timeout: 15000 })
  await expect(widget2).toContainText(`export function ${SCOPE}`)
})
