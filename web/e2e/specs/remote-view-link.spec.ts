import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 「在平台上查看」快捷跳转 E2E：
 *   1. 有 remote 的项目打开文件 → 编辑器工具条出现平台按钮（GitHub），
 *      href/target/rel 断言（URL = https remote/blob/<当前分支>/<文件>，noopener 红线）
 *   2. 文件树右键菜单出现「在 GitHub 上查看」→ 点击经 window.open 打开同一 URL
 *   3. 无 remote 的项目 → 工具条按钮隐藏、右键菜单无该项
 * fixture 自带 https 形态 remote（纯声明，不 fetch/push，离线安全）；
 * window.open 用页内 stub 断言（真实 popup 会请求外网，不可控）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const REMOTE_DIR = path.join(os.tmpdir(), 'sc-e2e-remote-view')
const BARE_DIR = path.join(os.tmpdir(), 'sc-e2e-remote-view-bare')
const PROJ_REMOTE = 'e2e-remote-view'
// 命名避开 PROJ_REMOTE 的前缀（hasText 为子串匹配，卡片按名过滤会串）
const PROJ_BARE = 'e2e-rv-noremote'
const FILE = 'notes.md'
const BARE_FILE = 'plain.txt'
const REMOTE_URL = 'https://github.com/sc-e2e/remote-view-demo.git'
const EXPECTED_URL = 'https://github.com/sc-e2e/remote-view-demo/blob/main/notes.md'

let remoteProjectId = ''
let bareProjectId = ''

// 固定参数列表调用 git（无 shell 拼接），身份用 -c 内联避免依赖本机 git 配置
function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function lockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = (await res.json()).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function addProject(name: string, dir: string): Promise<string> {
  const res = await fetch(BASE + '/api/projects', {
    method: 'POST',
    headers: await lockHeaders(),
    body: JSON.stringify({ name, path: serverPath(dir) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  return body.data?.id || ''
}

test.beforeAll(async () => {
  const headers = await lockHeaders()
  const stale = await (await fetch(BASE + '/api/projects', { headers })).json()
  for (const name of [PROJ_REMOTE, PROJ_BARE]) {
    const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === name)
    if (old) await fetch(`${BASE}/api/projects/${old.id}`, { method: 'DELETE', headers })
  }
  for (const dir of [REMOTE_DIR, BARE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  }

  // 仓库 A：单提交 + https 形态 origin remote；branch 强制 main（不受本机 init.defaultBranch 影响）
  fs.mkdirSync(REMOTE_DIR, { recursive: true })
  git(REMOTE_DIR, ['init'])
  git(REMOTE_DIR, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(REMOTE_DIR, FILE), '# 平台查看 e2e\n')
  git(REMOTE_DIR, ['add', '.'])
  git(REMOTE_DIR, ['commit', '-m', 'c1'])
  git(REMOTE_DIR, ['branch', '-M', 'main'])
  git(REMOTE_DIR, ['remote', 'add', 'origin', REMOTE_URL])
  remoteProjectId = await addProject(PROJ_REMOTE, REMOTE_DIR)

  // 仓库 B：无 remote（按钮/菜单项应隐藏）
  fs.mkdirSync(BARE_DIR, { recursive: true })
  git(BARE_DIR, ['init'])
  git(BARE_DIR, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(BARE_DIR, BARE_FILE), 'no remote here\n')
  git(BARE_DIR, ['add', '.'])
  git(BARE_DIR, ['commit', '-m', 'c1'])
  git(BARE_DIR, ['branch', '-M', 'main'])
  bareProjectId = await addProject(PROJ_BARE, BARE_DIR)
})

test.afterAll(async () => {
  const headers = await lockHeaders()
  for (const id of [remoteProjectId, bareProjectId]) {
    if (id) await fetch(`${BASE}/api/projects/${id}`, { method: 'DELETE', headers }).catch(() => {})
  }
  for (const dir of [REMOTE_DIR, BARE_DIR]) {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

async function openFile(page: Page, projectName: string, fileName: string) {
  await fixedLocale(page)
  // 重置持久化布局：uiState 是服务端全局状态，前序 spec 的面板开关经布局恢复
  // 污染进入流程（editor-git-tools 同款处理）
  await gotoAndUnlock(page, BASE + '/')
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: projectName }).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——先保证面板打开
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.tree-action-btn[title="搜索文件"]').isVisible().catch(() => false)) break
    await page.locator('.rail-btn[title="项目文件"], .rail-btn[aria-label="项目文件"]').click()
    await page.waitForTimeout(800)
  }
  const clickRetry = async (loc: import('@playwright/test').Locator, timeout = 2000, attempts = 8) => {
    let lastErr: unknown
    for (let i = 0; i < attempts; i++) {
      try { await loc.click({ timeout }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
    }
    throw lastErr
  }
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  await page.locator('.file-tree .item-name').first().waitFor({ state: 'visible', timeout: 30000 }).catch(() => {})
  // 搜索框由工具条搜索按钮 toggle 出现（editor-git-tools 同款流程）
  await clickRetry(page.locator('.tree-action-btn[title="搜索文件"]'))
  const searchInput = page.locator('.tree-search input')
  await searchInput.waitFor({ state: 'attached', timeout: 30000 }).catch(() => {})
  await clickRetry(searchInput)
  await searchInput.fill(fileName)
  const item = page.locator('.tree-item').filter({ has: page.locator('.item-name', { hasText: fileName }) }).first()
  await expect(item).toBeVisible({ timeout: 30000 })
  await clickRetry(item, 2000, 10)
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

test('有 remote：工具条平台按钮 href 正确，右键菜单同名项 window.open 同一 URL', async ({ page }) => {
  await openFile(page, PROJ_REMOTE, FILE)

  // 工具条按钮：平台名 + title 注明「已推送内容」语义；href/target/rel 断言
  const viewLink = page.locator('.ega-anchor a.ega-btn').filter({ hasText: 'GitHub' })
  await expect(viewLink).toBeVisible()
  await expect(viewLink).toHaveAttribute('href', EXPECTED_URL)
  await expect(viewLink).toHaveAttribute('target', '_blank')
  await expect(viewLink).toHaveAttribute('rel', /noopener/)
  await expect(viewLink).toHaveAttribute('title', '在 GitHub 上查看（已推送内容）')

  // 文件树右键菜单：同名项出现，点击经 window.open 打开同一 URL
  // （stub 掉 window.open：真实 popup 会请求外网，不可控且无必要）
  const treeItem = page.locator('.tree-item').filter({ has: page.locator('.item-name', { hasText: FILE }) }).first()
  await treeItem.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  const menuItem = menu.getByText('在 GitHub 上查看', { exact: true })
  await expect(menuItem).toBeVisible()
  await page.evaluate(() => {
    const w = window as unknown as { __lastOpen?: { url: string; target: string; features: string } }
    w.__lastOpen = undefined
    window.open = ((url: string, target: string, features: string) => {
      w.__lastOpen = { url, target, features }
      return null
    }) as typeof window.open
  })
  await menuItem.click()
  const opened = await page.evaluate(() => (window as unknown as { __lastOpen?: { url: string; target: string; features: string } }).__lastOpen)
  expect(opened).toEqual({ url: EXPECTED_URL, target: '_blank', features: 'noopener' })
})

test('无 remote：工具条按钮隐藏，右键菜单无平台查看项', async ({ page }) => {
  await openFile(page, PROJ_BARE, BARE_FILE)

  await expect(page.locator('.ega-anchor a.ega-btn')).toHaveCount(0)

  const treeItem = page.locator('.tree-item').filter({ has: page.locator('.item-name', { hasText: BARE_FILE }) }).first()
  await treeItem.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  const menuText = await menu.textContent()
  expect(menuText).not.toContain('上查看')
  await page.keyboard.press('Escape')
})
