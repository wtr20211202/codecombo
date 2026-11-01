import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 文件树常用目录钉选 E2E（P-20261002-97）：
 *   ① 目录右键「钉选到顶部」→ 树顶「已钉选」区出现（别名末两段、title 全路径）
 *   ② 全部收起后点钉选项 → 逐层展开定位 + 短暂高亮
 *   ③ 重启持久：刷新后钉选区仍在（uiState fileTree.pinnedDirs 服务端持久）
 *   ④ 删除目录 → 钉选置灰降级 → 「清理失效钉选」一键清除
 *   ⑤ 右键 toggle：已钉选目录菜单变「取消钉选」，点击即移除
 * 自备临时仓库（三层目录供深层钉选/展开断言），afterAll 清理并清 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-file-tree-pinned')
const PROJ = 'e2e-file-tree-pinned'
const DEEP_PIN = 'src/components/layout'
const DEEP_ALIAS = 'components/layout'

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

/** 清当前实例 uiState（前序 spec 恢复流/钉选残留会与本 spec 断言竞态） */
async function clearUIState(): Promise<void> {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  }).catch(() => {})
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
  fs.mkdirSync(path.join(REPO_DIR, 'src', 'components', 'layout'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'pinned dirs baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'util.ts'), 'export const x = 1\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'components', 'AppHeader.vue'), '<template />\n')
  fs.writeFileSync(path.join(REPO_DIR, 'src', 'components', 'layout', 'SideNav.vue'), '<template />\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 钉选基线'])
  projectId = await registerProject(headers, PROJ, REPO_DIR)
  await clearUIState()
})

test.afterAll(async () => {
  try {
    const headers = await unlockHeaders()
    const token = headers['X-Lock-Token']
    const list = await (await fetch(`${API_BASE}/api/projects`, { headers })).json()
    for (const p of ((list?.data || []) as { id: string; name: string }[])) {
      if (p.name === PROJ) {
        await fetch(`${API_BASE}/api/projects/${p.id}`, { method: 'DELETE', headers: { 'X-Lock-Token': token } })
      }
    }
    await fetch(`${API_BASE}/api/ui-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
      body: JSON.stringify({ local: null }),
    })
  } catch { /* 服务未起等场景忽略 */ }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

/** 进入项目页并保证文件树可见（rail 按钮是 toggle，奇数次点击保证最终打开） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

function treeItem(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.file-tree .tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

function pinnedItem(page: Page, alias: string) {
  return page.locator('.pinned-item').filter({ hasText: new RegExp(`^${alias.replace(/\//g, '\\/')}$`) }).first()
}

/** 轮询服务端 fileTree.pinnedDirs 落盘（persistPins 即时写，不等防抖仍需网络往返） */
async function awaitPinsPersisted(pin: string) {
  const headers = await unlockHeaders()
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
      const body = (await res.json()) as { data?: { local?: { fileTree?: { pinnedDirs?: Record<string, string[]> } } } }
      if (body.data?.local?.fileTree?.pinnedDirs?.[projectId]?.includes(pin)) return
    } catch { /* 轮询重试 */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`pinnedDirs 未落盘: ${pin}`)
}

/** 轮询服务端钉选清空（清理动作的写与下个用例的新载入竞态：先等服务端收敛） */
async function awaitPinsGone(pin: string) {
  const headers = await unlockHeaders()
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
      const body = (await res.json()) as { data?: { local?: { fileTree?: { pinnedDirs?: Record<string, string[]> } } } }
      const list = body.data?.local?.fileTree?.pinnedDirs?.[projectId]
      if (!list || !list.includes(pin)) return
    } catch { /* 轮询重试 */ }
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`pinnedDirs 未清除: ${pin}`)
}

test.describe('文件树常用目录钉选', () => {
  test('目录右键钉选 → 顶部区出现（末两段别名 + title 全路径）→ 点击定位展开 + 短暂高亮', async ({ page }) => {
    await enterProject(page)

    // 逐层展开到三层目录并右键钉选（钉选入口只对目录出现）
    await treeItem(page, 'src').click()
    await expect(treeItem(page, 'components')).toBeVisible({ timeout: 5000 })
    await treeItem(page, 'components').click()
    await expect(treeItem(page, 'layout')).toBeVisible({ timeout: 5000 })
    await treeItem(page, 'layout').click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    // 菜单体可见后选项仍有一拍渲染延迟（naive-ui 首次弹出装配），短沉降再点
    await page.waitForTimeout(300)
    await page.locator('.n-dropdown-menu').getByText('钉选到顶部', { exact: true }).click()

    // 顶部钉选区出现：别名末两段、title 全路径（fileTreePins.pinAlias）
    const pin = pinnedItem(page, DEEP_ALIAS)
    await expect(pin).toBeVisible({ timeout: 5000 })
    await expect(pin).toHaveAttribute('title', DEEP_PIN)

    // 全部收起后深层目录不可见；点钉选项 = 逐层展开定位（祖先链 src →
    // components 展开，目标行显现，与终端定位同款不展开目标自身）
    await page.locator('.tree-action-btn[title="全部收起"]').click()
    await expect(treeItem(page, 'layout')).toHaveCount(0)
    await pin.click()
    await expect(treeItem(page, 'layout')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.file-tree .tree-item.pinned-flash')).toHaveCount(1, { timeout: 2000 })

    // 钉选即时落盘（重启持久的前提；后续用例复用此钉选态）
    await awaitPinsPersisted(DEEP_PIN)
  })

  test('重启持久：刷新后钉选区仍在（uiState 服务端持久，非内存态）', async ({ page }) => {
    await enterProject(page)
    await expect(pinnedItem(page, DEEP_ALIAS)).toBeVisible({ timeout: 5000 })

    await page.reload()
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
    await page.waitForURL('**/project')
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
      await page.locator('[data-testid="rail-files"]').click()
      await page.waitForTimeout(600)
    }
    await expect(pinnedItem(page, DEEP_ALIAS)).toBeVisible({ timeout: 5000 })
    await expect(pinnedItem(page, DEEP_ALIAS)).toHaveAttribute('title', DEEP_PIN)
  })

  test('删除目录 → 钉选置灰降级 → 一键清理失效钉选', async ({ page }) => {
    await enterProject(page)
    await expect(pinnedItem(page, DEEP_ALIAS)).toBeVisible({ timeout: 5000 })

    // 盘上删除 src/components（DeleteFile 走 os.RemoveAll，目录级删除）
    const headers = await unlockHeaders()
    const del = await fetch(`${API_BASE}/api/projects/${projectId}/file/delete`, {
      method: 'POST', headers, body: JSON.stringify({ path: 'src/components' }),
    })
    expect(del.status).toBeLessThan(400)

    // 树刷新触发 validatePins：失效钉选置灰（title 附失效原因），清理入口出现
    await page.locator('.tree-action-btn[title="刷新（保留目录展开状态）"]').click()
    const pin = pinnedItem(page, DEEP_ALIAS)
    await expect(pin).toHaveClass(/invalid/, { timeout: 5000 })
    await expect(pin).toHaveAttribute('title', new RegExp(`${DEEP_PIN.replace(/\//g, '\\/')} · `))
    const clearBtn = page.locator('.pinned-clear')
    await expect(clearBtn).toBeVisible()

    // 一键清理：失效钉选移除，无钉选时整区隐藏
    await clearBtn.click()
    await expect(page.locator('.pinned-dirs')).toHaveCount(0, { timeout: 5000 })
    // 等清理落盘收敛，防与下个用例的新载入竞态（persistPins 异步写）
    await awaitPinsGone(DEEP_PIN)
  })

  test('右键 toggle：已钉选目录菜单变「取消钉选」，点击即移除', async ({ page }) => {
    await enterProject(page)
    await expect(page.locator('.pinned-dirs')).toHaveCount(0, { timeout: 5000 })

    // 钉选根下 src
    await treeItem(page, 'src').click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.waitForTimeout(300) // 菜单选项渲染沉降（同用例 1）
    await page.locator('.n-dropdown-menu').getByText('钉选到顶部', { exact: true }).click()
    await expect(pinnedItem(page, 'src')).toBeVisible({ timeout: 5000 })

    // 再右键同目录：菜单切「取消钉选」，点击后钉选移除、整区隐藏
    await treeItem(page, 'src').click({ button: 'right' })
    await expect(page.locator('.n-dropdown-menu')).toBeVisible()
    await page.waitForTimeout(300)
    await page.locator('.n-dropdown-menu').getByText('取消钉选', { exact: true }).click()
    await expect(page.locator('.pinned-dirs')).toHaveCount(0, { timeout: 5000 })
  })
})
