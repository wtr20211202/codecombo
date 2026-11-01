import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * DiffViewer 变更导航 prev/next E2E（P-20261003-212）：变更面板文本 diff 与编辑器
 * DiffEditor（Monaco goToDiff）的交互 parity——工具条一键跳上一/下一变更块，循环
 * 导航（尾→首、首→尾），落点 hunk 头高亮 + 滚动对齐容器顶。
 * P-20261004-54 增补：N/M 计数指示（游标位/总数，未导航以「–」占位）与 Alt+↑/↓
 * 键盘导航（根节点 tabindex=0 聚焦锚，点击 diff 区域后键入即跳）。
 * 夹具 = 60 行文件在 3 处相远位置各改一行 → c1↔c2 diff 三个 hunk；
 * 入口复用 diff-ignore-ws 的对比弹窗路径（提交文件节点 → 在编辑器中打开 → 对比 →
 * 选 feature=c1）。自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-nav-hunks')
const PROJ = 'e2e-diff-nav-hunks'
const FILE = 'nav.txt'

const C1_CONTENT = Array.from({ length: 60 }, (_, i) => `line-${String(i + 1).padStart(3, '0')}`).join('\n') + '\n'
// 第 2/30/58 行各改一处：彼此相距远超 3 行上下文 → 恰好三个 hunk
const C2_CONTENT = C1_CONTENT
  .replace('line-002', 'line-002-edited')
  .replace('line-030', 'line-030-edited')
  .replace('line-058', 'line-058-edited')

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
  git(REPO_DIR, ['branch', 'feature']) // feature 指回 c1：对比弹窗选它即得 c1↔c2 三 hunk diff
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: three separated edits'])
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

/** 落点锚元素的可滚动祖先 scrollTop（滚动是否发生的正面证据） */
function scrollOf(scope: import('@playwright/test').Locator, selector: string) {
  return scope.locator(selector).first().evaluate((el: Element) => {
    let p = el.parentElement
    while (p && p.scrollHeight <= p.clientHeight) p = p.parentElement
    return p ? p.scrollTop : -1
  })
}

test('DiffViewer prev/next 循环跳转：三 hunk 逐块前进尾→首回绕，prev 首→尾，落点滚动到位', async ({ page }) => {
  const modal = await openCompareModal(page)

  // 三个 hunk 头锚点 + 导航按钮可用（无变更时成对禁用，此处应可用）
  const anchors = modal.locator('[data-hunk-nav]')
  await expect(anchors).toHaveCount(3, { timeout: 10000 })
  const next = modal.locator('[data-testid="diff-nav-next"]')
  const prev = modal.locator('[data-testid="diff-nav-prev"]')
  await expect(next).toBeEnabled()
  await expect(prev).toBeEnabled()

  // N/M 计数（P-20261004-54）：未导航以「–」占位且显示总数
  const counter = modal.locator('[data-testid="diff-nav-count"]')
  await expect(counter).toHaveText('–/3')

  // next：首块 → 第二块（滚动发生，scrollTop > 0，落点可见且带高亮）
  await next.click()
  await expect(counter).toHaveText('1/3')
  await expect(modal.locator('[data-hunk-nav="1"].diff-nav-flash')).toBeVisible()
  await next.click()
  const hunk2 = modal.locator('[data-hunk-nav="2"]')
  await expect(modal.locator('[data-hunk-nav="2"].diff-nav-flash')).toBeVisible()
  await expect(hunk2).toBeInViewport()
  expect(await scrollOf(modal, '[data-hunk-nav="2"]')).toBeGreaterThan(0)

  // next：第三块（更深处）
  await next.click()
  const hunk3 = modal.locator('[data-hunk-nav="3"]')
  await expect(modal.locator('[data-hunk-nav="3"].diff-nav-flash')).toBeVisible()
  await expect(hunk3).toBeInViewport()
  const deepScroll = await scrollOf(modal, '[data-hunk-nav="3"]')
  expect(deepScroll).toBeGreaterThan(0)

  // next：尾→首循环回绕（滚回顾部，scrollTop 回到文件头两行之内）
  await next.click()
  await expect(modal.locator('[data-hunk-nav="1"].diff-nav-flash')).toBeVisible()
  expect(await scrollOf(modal, '[data-hunk-nav="1"]')).toBeLessThan(100)
  await expect(counter).toHaveText('1/3') // 回绕后计数同步（3/3→1/3）

  // prev：首→尾循环回绕（从首块直接跳回第三块深处）
  await prev.click()
  await expect(modal.locator('[data-hunk-nav="3"].diff-nav-flash')).toBeVisible()
  await expect(hunk3).toBeInViewport()
  await expect(counter).toHaveText('3/3')
})

test('键盘导航：点击 diff 区域聚焦后 Alt+↓/↑ 跳转，计数联动', async ({ page }) => {
  const modal = await openCompareModal(page)
  await expect(modal.locator('[data-hunk-nav]')).toHaveCount(3, { timeout: 10000 })

  // 点击 diff 行（非可聚焦子元素）：浏览器把焦点落到最近可聚焦祖先（根节点
  // tabindex=0），键盘导航即位；此前计数应仍处「未导航」态
  const counter = modal.locator('[data-testid="diff-nav-count"]')
  await expect(counter).toHaveText('–/3')
  await modal.locator('.diff-line').first().click()

  await page.keyboard.press('Alt+ArrowDown')
  await expect(modal.locator('[data-hunk-nav="1"].diff-nav-flash')).toBeVisible()
  await expect(counter).toHaveText('1/3')

  await page.keyboard.press('Alt+ArrowDown')
  await expect(modal.locator('[data-hunk-nav="2"].diff-nav-flash')).toBeVisible()
  await expect(counter).toHaveText('2/3')

  // Alt+↑ 退回一处（不回绕：游标已在第二块）
  await page.keyboard.press('Alt+ArrowUp')
  await expect(modal.locator('[data-hunk-nav="1"].diff-nav-flash')).toBeVisible()
  await expect(counter).toHaveText('1/3')
})

test('并排模式同款导航：切模式游标重置后 next 落首块，prev 回绕到末块', async ({ page }) => {
  const modal = await openCompareModal(page)
  await expect(modal.locator('[data-hunk-nav]')).toHaveCount(3, { timeout: 10000 })

  // 切并排（会重置导航游标）→ next 落首块（并排 td 锚点）
  await modal.getByRole('button', { name: '并排', exact: true }).click()
  await modal.locator('[data-testid="diff-nav-next"]').click()
  await expect(modal.locator('td[data-hunk-nav="1"].diff-nav-flash')).toBeVisible()

  // prev：首→尾回绕到第三块，滚动到位
  await modal.locator('[data-testid="diff-nav-prev"]').click()
  await expect(modal.locator('td[data-hunk-nav="3"].diff-nav-flash')).toBeVisible()
  await expect(modal.locator('td[data-hunk-nav="3"]')).toBeInViewport()
  expect(await scrollOf(modal, 'td[data-hunk-nav="3"]')).toBeGreaterThan(0)
})
