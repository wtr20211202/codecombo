import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话管理页「在文件树中定位」（P-20261002-125）E2E：
 * 管理页（AgentTerminalView docked）会话行右键菜单「在文件树中定位」→ 复用
 * P-32 解析层（会话 cwd 折算项目相对路径）派发 OPS_LOCATE_IN_TREE → 文件侧栏
 * 未开时被自动打开、树逐层展开并高亮会话 cwd 目录行（.focused）；dir 不在当前
 * 项目内的会话行菜单项置灰、悬浮窗 tab 条只对可定位 tab 渲染行内定位按钮。
 * 会话经管理页对话框创建（纯终端运行时，dir 显式指定），落点侧（FileTreeView
 * 逐层展开）与 terminal-locate-tree.spec.ts（P-32 项目终端工具条入口）共用。
 * 前置（spec 内自备）：临时项目（src/deep/ 夹具），路径交服务端一律 serverPath。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-session-locate-tree'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-session-locate-tree')
const DEEP_DIR = path.join(REPO_DIR, 'src', 'deep')
const NAME_IN = 'sc-locate-src'
const NAME_OUT = 'sc-locate-out'
const LOCATE_LABEL = '在文件树中定位'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  // 清空会话表（服务端全局共享）：管理页侧栏混入外部会话会破坏行定位
  const list = await api('GET', '/api/terminals')
  for (const s of ((list.json?.data || []) as { id: string }[])) {
    await api('DELETE', `/api/terminals/${s.id}`)
  }

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(DEEP_DIR, { recursive: true })
  fs.writeFileSync(path.join(DEEP_DIR, 'probe.txt'), 'session locate probe\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  const terms = await api('GET', '/api/terminals')
  for (const s of ((terms.json?.data || []) as { id: string }[])) {
    await api('DELETE', `/api/terminals/${s.id}`)
  }
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

function switchProject(page: Page, name: string) {
  return page.locator('.header-project-select').click()
    .then(() => page.locator('.n-base-select-option').filter({ hasText: name }).first().click())
}

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 管理页对话框新建会话（纯终端 + 显式命名/工作目录），断言侧栏行出现 */
async function createSession(view: ReturnType<Page['locator']>, page: Page, name: string, dir: string) {
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  // 新建会话对话框 P-20261002-16 起有两枚 .n-base-selection（运行时+任务模板），
  // 裸 locator 会 strict violation——按「运行时」表单锚定（agent-runtime-guide 同款）
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  await dlg.getByPlaceholder('留空自动命名').fill(name)
  await dlg.getByPlaceholder('留空 = 用户主目录').fill(serverPath(dir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 15000 })
  await expect(view.locator('.ats-item').filter({ hasText: name })).toHaveCount(1, { timeout: 10000 })
}

/** 收起文件侧栏（无论当前侧栏视图）：保证「点定位 → 面板由动作打开」链路被测到 */
async function collapseSidePanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel')).toBeHidden()
}

test('会话管理页定位文件树：行右键定位开面板展开高亮 cwd；项目外置灰；悬浮 tab 仅可定位渲染按钮', async ({ page }) => {
  test.setTimeout(240000)
  await fixedLocale(page)
  await page.goto(BASE + '/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)

  // 打开 docked 管理页（活动栏入口）并造两个会话：A cwd 在项目内（src/deep）、
  // B cwd 在项目外（系统临时目录）
  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })
  const outsideDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sc-locate-out-'))
  await createSession(view, page, NAME_IN, DEEP_DIR)
  await createSession(view, page, NAME_OUT, outsideDir)

  // 1) 会话行 A 右键菜单：定位项可用（dir 在当前项目内）→ 点击 → 文件侧栏被
  //    自动打开，树逐层展开并高亮会话 cwd 目录行（src 展开、deep .focused）
  await collapseSidePanel(page)
  await view.locator('.ats-item').filter({ hasText: NAME_IN }).click({ button: 'right' })
  // naive-ui 置灰落在内层 body（n-dropdown-option-body--disabled），外层壳类不变
  const locateOpt = page.locator('.n-dropdown-option-body').filter({ hasText: LOCATE_LABEL })
  await expect(locateOpt).toBeVisible({ timeout: 5000 })
  await expect(locateOpt).not.toHaveClass(/n-dropdown-option-body--disabled/)
  await locateOpt.click()
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
  const focused = page.locator('.tree-item.focused')
  await expect(focused).toBeVisible({ timeout: 5000 })
  await expect(focused.locator('.item-name')).toHaveText('deep')
  // 高亮行渲染即证明父链已展开（虚拟列表只渲染展开父目录下的可见条目）
  await expect(itemByName(page, 'src')).toBeVisible()

  // 2) 会话行 B（cwd 项目外）右键菜单：定位项置灰不可点
  await view.locator('.ats-item').filter({ hasText: NAME_OUT }).click({ button: 'right' })
  const locateOptOut = page.locator('.n-dropdown-option-body').filter({ hasText: LOCATE_LABEL })
  await expect(locateOptOut).toBeVisible({ timeout: 5000 })
  await expect(locateOptOut).toHaveClass(/n-dropdown-option-body--disabled/)
  await page.keyboard.press('Escape')
  await page.locator('.atv-header').click()

  // 3) 悬浮窗 tab 条：仅可定位 tab 渲染行内定位按钮；点击复现同一落点
  await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
  const floatBox = page.locator('.atv-root.is-float')
  await expect(floatBox).toBeVisible({ timeout: 10000 })
  const floatLocate = floatBox.locator('[data-testid^="float-tab-locate"]')
  await expect(floatLocate).toHaveCount(1, { timeout: 5000 })
  await collapseSidePanel(page)
  await floatLocate.click()
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.tree-item.focused').locator('.item-name')).toHaveText('deep', { timeout: 5000 })
})
