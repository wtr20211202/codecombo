import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 目录级终端直达（P-20261005-192）UI 链路 E2E：
 *   1. 文件树目录右键「在终端中打开」→ 底部终端新建会话（真实创建链，替代旧
 *      cd 注入形态），tab 目录徽标显示尾部目录短标（sub → sub），title 全路径
 *   2. 编辑器面包屑右键（当前文件所在目录）→「在此目录打开终端」→ 新会话落
 *      sub/deeper，徽标短标 deeper
 * 会话经 UI 入口创建，服务端守卫（越界 400）在 terminal-dir-create.spec 覆盖；
 * afterAll API 清会话与项目夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-dir-entry'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-dir-entry')
const SUB = 'sub'
const DEEP = 'sub/deeper'
const PROBE = 'probe.txt'
const PROBE_PATH = path.join(REPO_DIR, DEEP, PROBE)

let projId = ''

function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  return (async () => {
    const res = await request.post(`${BASE}/api/lock/unlock`, {
      data: { password: DEFAULT_PASSWORD },
    })
    const token = ((await res.json()) as { token?: string }).token || ''
    return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  })()
}

/** 清理全部终端会话（徽标断言基于空白会话表，残留会污染 tab 计数） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name.replace(/\./g, '\\.')}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

async function enterProject(page: Page) {
  await gotoAndUnlock(page, '/')
  await projectCardByName(page, PROJ_NAME).first().click()
  await page.waitForURL('**/project')
  // uiState 会恢复上次的侧栏视图，rail「项目文件」是 toggle——奇数次点击保证最终打开
  for (let i = 0; i < 3; i++) {
    if (await itemByName(page, SUB).isVisible().catch(() => false)) return
    await page.locator('.rail-btn[title="项目文件"]').click()
    await page.waitForTimeout(800)
  }
}

test.beforeAll(async ({ request }) => {
  const headers = await unlockHeaders(request)
  const stale = await request.get(`${BASE}/api/projects`, { headers })
  const old = ((await stale.json()) as { data?: { id: string; name: string }[] }).data || []
  const mine = old.find(p => p.name === PROJ_NAME)
  if (mine) {
    await cleanupTerminals(request)
    await request.delete(`${BASE}/api/projects/${mine.id}`, { headers })
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(path.dirname(PROBE_PATH), { recursive: true })
  fs.writeFileSync(PROBE_PATH, 'dir entry probe\n')

  const res = await request.post(`${BASE}/api/projects`, {
    headers,
    data: { name: PROJ_NAME, path: serverPath(REPO_DIR) },
  })
  expect([200, 201]).toContain(res.status())
  const body = (await res.json()) as { data?: { id?: string } }
  projId = body.data?.id || ''
})

test.afterAll(async ({ request }) => {
  try { await cleanupTerminals(request) } catch { /* 服务未起等场景忽略 */ }
  const headers = await unlockHeaders(request)
  if (projId) await request.delete(`${BASE}/api/projects/${projId}`, { headers })
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

test('文件树目录右键 → 在该目录新建会话 → tab 目录徽标短标', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await enterProject(page)

  const subDir = itemByName(page, SUB)
  await expect(subDir).toBeVisible({ timeout: 10000 })

  // 创建前无终端 tab（空白会话表）；右键 sub → 菜单「在终端中打开」
  await expect(page.locator('.term-tab')).toHaveCount(0, { timeout: 5000 })
  await subDir.click({ button: 'right' })
  const menu = page.locator('.n-dropdown-menu')
  await expect(menu).toBeVisible()
  await menu.getByText('在终端中打开', { exact: true }).click()

  // 新会话 tab 出现，目录徽标 = 尾部短标 sub（title = 全相对路径）
  const activeTab = page.locator('.term-tab.is-active')
  await expect(activeTab).toBeVisible({ timeout: 20000 })
  const badge = activeTab.locator('[data-testid="term-tab-dir"]')
  await expect(badge).toHaveText(SUB, { timeout: 15000 })
  await expect(badge).toHaveAttribute('title', SUB, { timeout: 15000 })

  // 落点真实性：终端会话表 path 在子目录（服务端快照，广播对账后的权威面）
  const headers = await unlockHeaders(page.request)
  await expect.poll(async () => {
    const res = await page.request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; path: string }[] }).data || []
    return list.some(s => s.path.replace(/\\/g, '/').endsWith(`/${SUB}`))
  }, { timeout: 20000 }).toBe(true)
})

test('面包屑右键（当前文件所在目录）→ 在此目录打开终端', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await enterProject(page)

  // 打开 sub/deeper/probe.txt：展开两级目录后点击文件（文件树单击即进编辑器）
  const subDir = itemByName(page, SUB)
  await expect(subDir).toBeVisible({ timeout: 10000 })
  for (let i = 0; i < 5; i++) {
    if (await itemByName(page, 'deeper').isVisible().catch(() => false)) break
    await subDir.click()
    await page.waitForTimeout(600)
  }
  const deepDir = itemByName(page, 'deeper')
  await expect(deepDir).toBeVisible({ timeout: 10000 })
  for (let i = 0; i < 5; i++) {
    if (await itemByName(page, PROBE).isVisible().catch(() => false)) break
    await deepDir.click()
    await page.waitForTimeout(600)
  }
  await itemByName(page, PROBE).click()
  const crumbBar = page.locator('.breadcrumb-bar')
  await expect(crumbBar).toBeVisible({ timeout: 10000 })

  // 右键面包屑（落在末段文件名上 = 冒泡到条栏 → 取当前文件所在目录 sub/deeper）
  await crumbBar.locator('.crumb.active').click({ button: 'right' })
  const item = page.getByTestId('breadcrumb-open-terminal')
  await expect(item).toBeVisible()
  await item.click()

  // 新会话 tab：徽标短标 deeper、title 全路径
  const activeTab = page.locator('.term-tab.is-active')
  const badge = activeTab.locator('[data-testid="term-tab-dir"]')
  await expect(badge).toHaveText('deeper', { timeout: 20000 })
  await expect(badge).toHaveAttribute('title', DEEP, { timeout: 15000 })
})
