import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 面包屑同级导航 E2E（P-20261002-128，VS Code 式）：
 *   ① 点目录段弹出该目录单层子项（服务端序：目录在前文件在后），当前文件命中项高亮；
 *      选文件 → 打开且面包屑更新（深层同级切换两次点击）
 *   ② 选目录 → 文件树定位展开（revealInFileTree 桥：逐级展开 + 滚动高亮）
 *   ③ 弹层开关语义：同段再点收起、Escape 关闭；末段文件不参与点击
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-breadcrumb-nav')
const PROJ = 'e2e-breadcrumb-nav'
const ALPHA = { name: 'alpha.txt', content: 'alpha sibling content' }
const BETA = { name: 'beta.txt', content: 'beta sibling content' }
// inner/ + side.txt 制造「目录在前文件在后」的弹层清单：mod 段弹层 = inner, alpha, beta
const FILES: Record<string, string> = {
  'deep/nav/mod/alpha.txt': ALPHA.content,
  'deep/nav/mod/beta.txt': BETA.content,
  'deep/nav/mod/inner/keep.txt': 'keep inner dir tracked',
  'deep/nav/side.txt': 'side file at nav level',
  'README.md': 'breadcrumb nav baseline',
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
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(REPO_DIR, rel)), { recursive: true })
    fs.writeFileSync(path.join(REPO_DIR, rel), content + '\n')
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 面包屑同级导航基线'])
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
  // 清掉指向临时仓库的 uiState，防串扰后续 spec 的项目页恢复
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并展开 deep/nav，激活 alpha.txt（幂等：已开只会被激活） */
async function openProjectAndAlpha(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-item .item-name', { hasText: /^deep$/ }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expandDir(page, 'deep')
  await expandDir(page, 'nav')
  await expandDir(page, 'mod')
  await itemByName(page, 'alpha.txt').click()
  const tab = page.locator('.editor-tab', { hasText: ALPHA.name })
  await expect(tab).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ALPHA.content, { timeout: 8000 })
}

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 反复点击目录直到展开（展开态在虚拟列表重渲染下有竞态，与 file-tree-refresh 同款） */
async function expandDir(page: Page, name: string) {
  const dir = itemByName(page, name)
  await expect(dir).toBeVisible({ timeout: 5000 })
  for (let i = 0; i < 5; i++) {
    if (((await dir.locator('.dir-arrow').textContent().catch(() => '')) || '') === '▼') return
    await dir.click()
    await page.waitForTimeout(700)
  }
}

/** 按段路径点面包屑可点击段（title = 段相对路径，段名可能重名故不用文本定位） */
function crumbByPath(page: Page, segPath: string) {
  return page.locator(`.crumb.clickable[title="${segPath}"]`)
}

async function sibNames(page: Page): Promise<string[]> {
  const texts = await page.locator('.breadcrumb-sib-menu .sib-name').allTextContents()
  return texts.map(s => s.trim())
}

test.describe('面包屑同级导航', () => {
  test('点目录段弹同级清单（目录在前文件在后+当前项高亮）→ 选文件打开且面包屑更新', async ({ page }) => {
    await openProjectAndAlpha(page)

    // 点 mod 段 → 弹层列出 deep/nav/mod 子项：inner（目录）在前，alpha/beta 在后
    await crumbByPath(page, 'deep/nav/mod').click()
    const menu = page.locator('.breadcrumb-sib-menu')
    await expect(menu).toBeVisible()
    // 弹层先渲染 loading 态再填子项：等条目就位再断言清单
    await expect(menu.locator('.sib-item')).toHaveCount(3)
    expect(await sibNames(page)).toEqual(['inner', ALPHA.name, BETA.name])
    // 首项为目录（清单核实：目录在前文件在后）
    await expect(menu.locator('.sib-item').first().locator('.sib-icon.is-dir')).toBeVisible()
    // 当前打开文件命中项高亮
    await expect(menu.locator('.sib-item.current')).toHaveCount(1)
    await expect(menu.locator('.sib-item.current')).toContainText(ALPHA.name)

    // 选 beta.txt → 打开为激活标签 + 编辑器内容 + 面包屑末段更新
    await menu.locator('.sib-item[title="deep/nav/mod/beta.txt"]').click()
    const betaTab = page.locator('.editor-tab', { hasText: BETA.name })
    await expect(betaTab).toBeVisible()
    await expect(betaTab).toHaveClass(/active/)
    await expect(page.locator('.monaco-editor .view-lines')).toContainText(BETA.content, { timeout: 8000 })
    await expect(page.locator('.crumb.active .crumb-label')).toHaveText(BETA.name)
    // 弹层选择后收起
    await expect(menu).toHaveCount(0)
  })

  test('弹层选目录 → 文件树定位展开（逐级展开+高亮）', async ({ page }) => {
    await openProjectAndAlpha(page)

    // 点 nav 段 → 弹层列出 deep/nav 子项：mod（目录）在前，side.txt 在后
    await crumbByPath(page, 'deep/nav').click()
    const menu = page.locator('.breadcrumb-sib-menu')
    await expect(menu).toBeVisible()
    await expect(menu.locator('.sib-item')).toHaveCount(2)
    expect(await sibNames(page)).toEqual(['mod', 'side.txt'])

    // 选 mod 目录 → 文件树定位：deep/nav 逐级展开 + mod 高亮聚焦
    await menu.locator('.sib-item[title="deep/nav/mod"]').click()
    await expect(menu).toHaveCount(0)
    await expect(itemByName(page, 'nav').locator('.dir-arrow')).toHaveText('▼')
    const focused = page.locator('.tree-item.focused .item-name')
    await expect(focused).toHaveText('mod')
  })

  test('弹层开关语义：同段再点收起、Escape 关闭；末段不参与点击', async ({ page }) => {
    await openProjectAndAlpha(page)

    // 末段（当前文件）无 clickable 手势
    const activeCrumb = page.locator('.crumb.active')
    await expect(activeCrumb).toHaveText(ALPHA.name)
    await expect(activeCrumb).not.toHaveClass(/clickable/)

    const menu = page.locator('.breadcrumb-sib-menu')
    await crumbByPath(page, 'deep/nav/mod').click()
    await expect(menu).toBeVisible()
    // 同段再点 → 收起（toggle，不被 outside-click 先关后开打断）
    await crumbByPath(page, 'deep/nav/mod').click()
    await expect(menu).toHaveCount(0)
    // 再开 → Escape 关闭
    await crumbByPath(page, 'deep/nav/mod').click()
    await expect(menu).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    // 再开 → 点弹层外（标签栏）关闭
    await crumbByPath(page, 'deep/nav/mod').click()
    await expect(menu).toBeVisible()
    await page.locator('.editor-tabs').click()
    await expect(menu).toHaveCount(0)
  })
})
