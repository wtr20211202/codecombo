import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'
import { OPS_LOCATE_IN_TREE } from '../../src/utils/opsEvents'

/**
 * 终端「在文件树中定位」（P-20261001-32）E2E：
 * 进项目开终端 → tab tooltip 展示会话 dir → 工具条「在文件树中定位」按钮 →
 * 文件侧栏未开时被自动打开（根 dir 无需展开，树落在项目根）→ 派发定位事件
 * 携带子目录路径 → 文件树逐层展开并高亮目标目录行（.focused）。
 * 会话创建 dir = 项目根（服务端 create 即项目根，MVP 不追踪 shell 内 cd），
 * 根场景经按钮 UI 链路验证；子目录展开/高亮经同一条 window 事件契约验证
 * （事件名与 detail 与生产派发方 useTerminalTreeLocate 完全一致）。
 * 前置（spec 内自备）：临时项目（src/deep/ 夹具），路径交服务端一律 serverPath。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-locate-tree'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-locate-tree')
const PROBE = path.join(REPO_DIR, 'src', 'deep', 'probe.txt')

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

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(path.dirname(PROBE), { recursive: true })
  fs.writeFileSync(PROBE, 'locate probe\n')
  // 注册项目：路径交给服务端一律 serverPath 折算（跨拓扑口径）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
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

/** 收起文件侧栏（无论当前侧栏视图）：保证「点定位 → 面板由按钮打开」链路被测到 */
async function collapseSidePanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel')).toBeHidden()
}

async function openFreshTerminal(page: Page) {
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText('PS ', { timeout: 20000 })
  return xterm
}

test('终端定位文件树：tooltip 展示会话 dir；点定位开面板落根；子目录事件展开高亮', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto(BASE + '/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await openFreshTerminal(page)

  // 1) 会话 dir 可见出口：活动 tab tooltip 展示工作目录（会话创建 dir = 项目根）
  const activeTab = page.locator('.term-tab.is-active')
  await expect(activeTab).toHaveAttribute('title', /工作目录/, { timeout: 10000 })

  // 2) 定位按钮就绪（dir 在项目内 → 可点，标题为动作名本身）
  const locateBtn = page.locator('.term-toolbar button[title="在文件树中定位"]')
  await expect(locateBtn).toBeVisible({ timeout: 5000 })
  await expect(locateBtn).toBeEnabled()

  // 3) 文件侧栏未开 → 点定位：面板被自动打开，树落在项目根（根目录列表可见）
  await collapseSidePanel(page)
  await locateBtn.click()
  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
  await expect(itemByName(page, 'src')).toBeVisible({ timeout: 5000 })

  // 4) 子目录定位（同一条 window 事件契约，detail 与生产派发方一致）：
  //    'src' 逐层展开、'deep' 行滚动进虚拟列表窗口并高亮（.focused）
  const list = await api('GET', '/api/projects')
  const pid = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)!.id
  await page.evaluate(([ev, projectId]) => {
    window.dispatchEvent(new CustomEvent(ev, { detail: { path: 'src/deep', projectId } }))
  }, [OPS_LOCATE_IN_TREE, pid])
  const focused = page.locator('.tree-item.focused')
  await expect(focused).toBeVisible({ timeout: 5000 })
  await expect(focused.locator('.item-name')).toHaveText('deep')
  // 高亮行渲染即证明父链已展开（虚拟列表只渲染展开父目录下的可见条目）
  await expect(itemByName(page, 'src')).toBeVisible()
})
