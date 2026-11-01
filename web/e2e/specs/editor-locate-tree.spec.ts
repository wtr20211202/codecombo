import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器「在文件树中定位」（P-20261003-294）E2E：
 *   1. 树内打开深层文件（src/feat/deep/probe.ts）→ 收起侧栏 → tab 右键
 *      「在文件树中定位」→ 侧栏自动重开 + 目标行聚焦高亮（父链已逐层展开）
 *   2. 侧栏停在 changes 视图（FileTreeView 未挂载、OPS_LOCATE_IN_TREE 无人
 *      监听的形态）→ 命令面板「定位当前文件到树」→ 派发方先切回 files 视图
 *      再派发 → 目标行聚焦
 * 定位目标行断言 .tree-item.focused：虚拟列表只渲染展开父目录下的可见条目，
 * 深层行出现即证明「逐层展开 + 滚动定位」整链生效（terminal-locate-tree 同款）。
 * 自备临时仓库，afterAll 清理项目与夹具。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-editor-locate-tree'
const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-locate-tree')
const FILE = 'src/feat/deep/probe.ts'

let unlockToken = ''
let projectId = ''

function git(cwd: string, args: string[]) {
  return execFileSync(
    'git',
    ['-c', 'user.name=e2e', '-c', 'user.email=e2e@test.local', ...args],
    { cwd, encoding: 'utf8' },
  )
}

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await (await fetch(BASE + '/api/projects', { headers: { 'X-Lock-Token': unlockToken } })).json()
  const old = ((stale?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (old) await api('DELETE', `/api/projects/${old.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 残留忽略 */ }
  fs.mkdirSync(path.dirname(path.join(REPO_DIR, FILE)), { recursive: true })
  fs.writeFileSync(path.join(REPO_DIR, FILE), 'export const probe = "locate me"\n')
  git(REPO_DIR, ['init'])
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: deep probe'])

  const res = await fetch(BASE + '/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ name: PROJ_NAME, path: serverPath(REPO_DIR) }),
  })
  const body = (await res.json()) as { data?: { id?: string } }
  projectId = body.data?.id || ''

  // 预置良性布局命名空间（面板开 + files 视图）：boot 的 restoreLayoutState
  //（useLayoutBootstrap）先拉项目清单与 aheadBehind 实例探活才恢复布局，负载下
  // 落地时机可晚于页面交互——迟到的恢复会把上一关页页面保存的任意面板态
  // （如收起）翻回来，把交互途中的文件树 v-show 藏掉（树行「已解析但不可见」）。
  // 预置同欲态后，恢复无论何时落地都是无操作回放（键值与出厂默认一致）
  await api('PUT', '/api/ui-state', { local: { layout: { showSidePanel: true, sideView: 'files' } } })
})

test.afterAll(async () => {
  if (projectId) await api('DELETE', `/api/projects/${projectId}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
})

function itemByName(page: Page, name: string) {
  const re = new RegExp(`^${name}$`)
  return page.locator('.tree-item').filter({ has: page.locator('.item-name').filter({ hasText: re }) }).first()
}

/** 树行点击（自愈重试）：boot 布局恢复是异步一次性落地，落在交互中途会把
 *  面板 v-show 藏掉（树行「已解析但不可见」的稳定态）——每次尝试前先归一面板
 *  可见（rail-files toggle 语义：不可见才点）再点；恢复只落地一次，归一即收敛。
 *  面板可见但视图不在 files（rail-files 会切视图）同样被此检查覆盖 */
async function clickTreeItem(page: Page, loc: import('@playwright/test').Locator, attempts = 8) {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    if (!(await page.locator('.file-tree .item-name').first().isVisible().catch(() => false))) {
      await page.locator('[data-testid="rail-files"]').click().catch(() => {})
      await page.waitForTimeout(600)
    }
    try { await loc.click({ timeout: 2000 }); return } catch (err) { lastErr = err; await page.waitForTimeout(300) }
  }
  throw lastErr
}

/** 收起文件侧栏（无论当前开合态）：保证「点定位 → 面板被自动打开」链路被测到 */
async function collapseSidePanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel')).toBeHidden()
}

/** 进项目并经文件树逐层打开深层文件（点击带自愈重试，ask-agent 重试口径 + 面板归一） */
async function openProjectAndDeepFile(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, BASE + '/')
  await page.locator('.project-card').filter({ hasText: PROJ_NAME }).first().click()
  await page.waitForURL('**/project')
  // 树数据就绪（加载指示消失）；面板可见性归一交给 clickTreeItem 每次尝试自愈
  await page.locator('.tree-loading').waitFor({ state: 'detached', timeout: 30000 }).catch(() => {})
  // 逐层展开 src → feat → deep，点开 probe.ts（深路径夹具）
  await clickTreeItem(page, itemByName(page, 'src'))
  await clickTreeItem(page, itemByName(page, 'feat'))
  await clickTreeItem(page, itemByName(page, 'deep'))
  await clickTreeItem(page, itemByName(page, 'probe.ts'))
  await expect(page.locator('.editor-tab').filter({ hasText: 'probe.ts' })).toBeVisible({ timeout: 15000 })
  await expect(page.locator('.monaco-editor').first()).toBeVisible({ timeout: 20000 })
}

test('tab 右键「在文件树中定位」：侧栏收起态重开面板并聚焦深层文件行', async ({ page }) => {
  test.setTimeout(180000)
  await openProjectAndDeepFile(page)

  // 收起侧栏后右键 tab 定位：面板被自动打开，目标行聚焦（父链已展开）
  await collapseSidePanel(page)
  await page.locator('.editor-tab').filter({ hasText: 'probe.ts' }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在文件树中定位' }).click()

  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
  const focused = page.locator('.tree-item.focused')
  await expect(focused).toBeVisible({ timeout: 5000 })
  await expect(focused.locator('.item-name')).toHaveText('probe.ts')
  // 高亮行渲染即证明父链已逐层展开（虚拟列表只渲染展开父目录下的可见条目）
  await expect(itemByName(page, 'deep')).toBeVisible()
  await expect(itemByName(page, 'src')).toBeVisible()
})

test('命令面板「定位当前文件到树」：侧栏停 changes 视图时切回 files 并聚焦', async ({ page }) => {
  test.setTimeout(180000)
  await openProjectAndDeepFile(page)

  // 侧栏切到 changes 视图：FileTreeView 随 v-if 卸载（定位事件此时无人监听，
  // 依赖派发方先切回 files 视图再派发）
  await page.locator('[data-testid="rail-changes"]').click()
  await expect(page.locator('.tree-item')).toHaveCount(0)

  // 焦点移出 Monaco（Monaco 会吞 Ctrl+K 弦），命令面板执行「定位当前文件到树」
  await page.locator('.editor-tab').filter({ hasText: 'probe.ts' }).click()
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>定位当前文件')
  const item = page.locator('.palette-item').filter({ hasText: '定位当前文件到树' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
  const focused = page.locator('.tree-item.focused')
  await expect(focused).toBeVisible({ timeout: 10000 })
  await expect(focused.locator('.item-name')).toHaveText('probe.ts')
  await expect(itemByName(page, 'deep')).toBeVisible()
})
