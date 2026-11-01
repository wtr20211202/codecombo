import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 设计令牌三轴 E2E（P-20261019-8）：
 * 断言首批高频面（设置弹窗 / Git 面板 / 活动栏 / 顶栏 / 状态栏）的计算样式
 * 等于 main.css 三轴令牌解析值——源码侧的「必须引用 var()」由
 * src/__tests__/design-tokens.test.ts 守护，本 spec 守浏览器里真的算出来的值：
 *   - --radius-sm/md/lg = 4/6/10：设置卡片 10、导航项 6、Git 图标钮 4；
 *   - --space-1..4 = 4/8/12/16：设置页脚 gap 8 / padding-top 12、顶栏 gap 8 /
 *     padding 12、活动栏底部 padding 8/12、Git 侧栏 header padding 8；
 *   - --fw-medium/semibold = 500/600：Git 侧栏标题 500、分支名 600、设置标题 600。
 * 自备临时仓库（单提交），afterAll 清理项目/目录并复位 uiState（面板开合是
 * 服务端全局态，防泄入后续 spec）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-design-tokens')
const PROJ = 'e2e-design-tokens'

let projectId = ''

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

async function tokenValues(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    const keys = [
      '--radius-sm', '--radius-md', '--radius-lg',
      '--space-1', '--space-2', '--space-3', '--space-4',
      '--fw-regular', '--fw-medium', '--fw-semibold',
    ]
    return Object.fromEntries(keys.map((k) => [k, s.getPropertyValue(k).trim()]))
  })
}

/** 读取元素的一组计算样式（短属性名，如 padding-top / gap / border-top-left-radius） */
async function computed(page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  const out = await page.evaluate(({ sel, ps }) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(ps.map((p) => [p, cs.getPropertyValue(p).trim()]))
  }, { sel: selector, ps: props })
  expect(out, `找不到选择器：${selector}`).not.toBeNull()
  return out!
}

/** rail 面板是 toggle（uiState 跨用例恢复态不定）→ 循环归一化到面板可见 */
async function ensurePanel(page: Page, railTestId: string, rootSelector: string): Promise<void> {
  for (let i = 0; i < 4; i++) {
    if (await page.locator(rootSelector).isVisible().catch(() => false)) return
    await page.locator(`[data-testid="${railTestId}"]`).click()
    await page.waitForTimeout(500)
  }
  await expect(page.locator(rootSelector)).toBeVisible()
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
  execFileSync('git', ['init', '-b', 'main'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), '# design tokens\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 设计令牌夹具'])

  const created = await fetch(`${API_BASE}/api/projects`, {
    method: 'POST', headers, body: JSON.stringify({ name: PROJ, path: serverPath(REPO_DIR) }),
  })
  expect([200, 201]).toContain(created.status)
  projectId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
  expect(projectId).not.toBe('')
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  if (projectId) {
    await fetch(`${API_BASE}/api/projects/${projectId}`, { method: 'DELETE', headers }).catch(() => { /* 残留忽略 */ })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  // 面板开合/选中 tab 是服务端 uiState 全局态，复位防泄入后续 spec
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT', headers, body: JSON.stringify({ local: null }),
  }).catch(() => { /* 复位失败不拦截 */ })
})

async function enterProject(page: Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, PROJ).click()
  await page.waitForURL('**/project')
}

test('三轴令牌在设置弹窗/Git 面板/活动栏/顶栏/状态栏的计算样式与令牌一致', async ({ page }) => {
  await enterProject(page)

  const tokens = await tokenValues(page)
  expect(tokens).toEqual({
    '--radius-sm': '4px',
    '--radius-md': '6px',
    '--radius-lg': '10px',
    '--space-1': '4px',
    '--space-2': '8px',
    '--space-3': '12px',
    '--space-4': '16px',
    '--fw-regular': '400',
    '--fw-medium': '500',
    '--fw-semibold': '600',
  })

  // ---- 设置弹窗：lg 卡片 / md 导航项 / 8px 节律 / 500·600 字重 ----
  await page.locator('[data-testid="rail-settings"]').click()
  const settings = page.locator('.n-modal.settings-modal')
  await expect(settings).toBeVisible({ timeout: 5000 })

  expect(await computed(page, '.settings-card', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-lg'],
  })
  expect(await computed(page, '.settings-nav .nav-item', ['border-top-left-radius', 'gap'])).toEqual({
    'border-top-left-radius': tokens['--radius-md'],
    gap: tokens['--space-2'],
  })
  expect(await computed(page, '.settings-title', ['gap', 'font-weight'])).toEqual({
    gap: tokens['--space-2'],
    'font-weight': tokens['--fw-semibold'],
  })
  expect(await computed(page, '.settings-nav .nav-item.active', ['font-weight'])).toEqual({
    'font-weight': tokens['--fw-medium'],
  })
  expect(await computed(page, '.settings-footer', ['gap', 'padding-top', 'padding-right'])).toEqual({
    gap: tokens['--space-2'],
    'padding-top': tokens['--space-3'],
    'padding-right': '18px', // 档外值：页脚右内距保留原视觉，不强行网格化
  })

  await page.locator('.settings-close').click()
  const discard = page.getByRole('button', { name: '丢弃并关闭' })
  if (await discard.isVisible({ timeout: 800 }).catch(() => false)) await discard.click()
  await expect(settings).toBeHidden()

  // ---- Git 面板：sm 图标钮 / 8px 侧栏内距 / 500·600 字重 ----
  await ensurePanel(page, 'rail-git', '.git-panel')
  expect(await computed(page, '.git-panel .sidebar-header', ['padding-left', 'font-weight'])).toEqual({
    'padding-left': tokens['--space-2'],
    'font-weight': tokens['--fw-medium'],
  })
  expect(await computed(page, '.git-panel .sidebar-toggle', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-sm'],
  })
  expect(await computed(page, '.git-panel .cbc-name', ['font-weight'])).toEqual({
    'font-weight': tokens['--fw-semibold'],
  })

  // 提交面板（侧栏 changes 视图，与底部 Git 面板互斥挂载）：8px 右内距 + 4px 动作按钮间距
  await ensurePanel(page, 'rail-changes', '.commit-panel')
  expect(await computed(page, '.commit-panel .cp-commit-area', ['padding-right'])).toEqual({
    'padding-right': tokens['--space-2'],
  })
  expect(await computed(page, '.commit-panel .cp-commit-actions', ['gap'])).toEqual({
    gap: tokens['--space-1'],
  })

  // ---- 顶栏：12px 外距 / 8px 组间距 / md 按钮组 ----
  expect(await computed(page, '.ide-header', ['padding-left', 'gap'])).toEqual({
    'padding-left': tokens['--space-3'],
    gap: tokens['--space-2'],
  })
  expect(await computed(page, '.ide-header .header-btn-group', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-md'],
  })
  expect(await computed(page, '.ide-header .header-btn-group .grouped-btn', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-md'],
  })

  // ---- 活动栏：8/12px 上下内距 / md 按钮圆角 ----
  expect(await computed(page, '.ide-rail .rail-bottom', ['padding-top', 'padding-bottom'])).toEqual({
    'padding-top': tokens['--space-2'],
    'padding-bottom': tokens['--space-3'],
  })
  expect(await computed(page, '.ide-rail .rail-btn', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-md'],
  })

  // ---- 状态栏：12px 外距 / sm 条目圆角 / 500 分支名 ----
  expect(await computed(page, '.status-bar', ['padding-left'])).toEqual({
    'padding-left': tokens['--space-3'],
  })
  expect(await computed(page, '.statusbar-item', ['border-top-left-radius'])).toEqual({
    'border-top-left-radius': tokens['--radius-sm'],
  })
  expect(await computed(page, '.statusbar-branch', ['font-weight'])).toEqual({
    'font-weight': tokens['--fw-medium'],
  })
})
