import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 视图并排/行内切换 E2E（P-20261002-63）：夹具 = c2 相对 c1 一行修改 + 一行新增。
 * 断言锚 = Monaco 根节点 side-by-side 类（随 renderSideBySide 联动，diffEditorWidget
 * 内部 classList.toggle）：
 *   1. 宽屏（≥900px）默认并排 → 切行内（side-by-side 类消失，line-delete/line-insert
 *      语义色带仍渲染）→ 切回并排恢复（会话级，可逆）
 *   2. 窄屏（<900px）打开 diff 默认行内（响应式初值）→ 切并排可逆
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-inline-toggle')
const PROJ = 'e2e-diff-inline-toggle'
const FILE = 'logic.txt'

const C1_CONTENT = 'alpha line\nbeta line\ngamma line\n'
const C2_CONTENT = 'alpha line\nbeta CHANGED line\nnew delta line\ngamma line\n'

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
  git(REPO_DIR, ['config', 'core.autocrlf', 'false']) // Windows 服务端 git 也不 smudge，与 Linux 视图一致
  git(REPO_DIR, ['config', 'user.name', 'e2e'])
  git(REPO_DIR, ['config', 'user.email', 'e2e@test.local'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C1_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), C2_CONTENT)
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: change + insert'])
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

/** 选中 c2（点 meta 行，消息区单击是展开 body）→ 返回右侧变更文件节点 */
async function selectChangeCommit(page: import('@playwright/test').Page) {
  await page.locator('.commit-item').filter({ hasText: c2.slice(0, 8) }).first().locator('.commit-meta').click()
  const node = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE })
    .first()
  await expect(node).toBeVisible({ timeout: 5000 })
  return node
}

/** 右键节点 →「查看此次变更」→ DiffEditor 标签挂载 */
async function openDiffEditor(page: import('@playwright/test').Page, node: import('@playwright/test').Locator) {
  await node.click({ button: 'right' })
  const changeDiff = page.locator('.n-dropdown-menu').getByText('查看此次变更', { exact: true })
  await expect(changeDiff).toBeVisible({ timeout: 3000 })
  await changeDiff.click()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
}

test('宽屏默认并排 → 切行内色带仍渲染 → 切回并排恢复', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // 默认（视口 1280 ≥ 900）：并排模式，根节点带 side-by-side 类
  const sbs = page.locator('.monaco-diff-editor.side-by-side')
  await expect(sbs).toHaveCount(1)
  // 切换按钮 title 跟随当前模式（切到哪档 title 就变成哪档），按档位分别定位
  const sbsToggle = page.locator('.diff-nav-bar button[title="并排视图"]')
  await expect(sbsToggle).toHaveAttribute('aria-pressed', 'true')

  // 切行内：side-by-side 类消失，删除/新增行仍走 line-delete/line-insert 语义色带
  await sbsToggle.click()
  const inlineToggle = page.locator('.diff-nav-bar button[title="行内视图"]')
  await expect(inlineToggle).toBeVisible({ timeout: 5000 })
  await expect(inlineToggle).toHaveAttribute('aria-pressed', 'false')
  await expect(sbs).toHaveCount(0, { timeout: 5000 })
  await expect(page.locator('.monaco-diff-editor .line-delete').first()).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.monaco-diff-editor .line-insert').first()).toBeVisible()

  // 切回并排：视图级会话状态，可逆
  await inlineToggle.click()
  await expect(sbs).toHaveCount(1, { timeout: 5000 })
})

test('窄屏打开默认行内 → 切并排可逆', async ({ page }) => {
  await enterAndOpenLog(page)

  // 导航在宽屏完成，仅打开 diff 前切窄视口（初值在 DiffEditor 挂载时读取）
  await page.setViewportSize({ width: 800, height: 700 })
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // <900px 响应式初值：默认行内（根节点无 side-by-side 类）
  const sbs = page.locator('.monaco-diff-editor.side-by-side')
  await expect(page.locator('.monaco-diff-editor')).toBeVisible()
  await expect(sbs).toHaveCount(0)

  // 切并排 → 再切回行内：可逆
  const toggle = page.locator('.diff-nav-bar button[title="行内视图"]')
  await expect(toggle).toBeVisible()
  await toggle.click()
  await expect(sbs).toHaveCount(1, { timeout: 5000 })
  await page.locator('.diff-nav-bar button[title="并排视图"]').click()
  await expect(sbs).toHaveCount(0, { timeout: 5000 })
})
