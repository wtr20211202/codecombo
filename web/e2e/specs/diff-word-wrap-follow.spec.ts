import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * DiffEditor 折行跟随编辑器设置 E2E（P-20261004-55）：diff 标签的 wordWrap 不再
 * 硬编码 off，读 fontStore.editor.wordWrap（设置·外观「自动换行」同源）。
 * 夹具 = 单文件第 3 行为超长行（~600 字符，1280 视口必横向溢出），c2 原地改写。
 * 断言锚 = Monaco 横向滚动条根节点的可见性类（ScrollableVisibilityController 在
 * 「有溢出/无溢出」间切换 `visible scrollbar horizontal` / `invisible scrollbar
 * horizontal`——overflow 实测驱动，等价「无横向滚动条」语义断言，不碰像素内幕）：
 *   ① 反应式路径（主流程）：默认关（存量行为）→ 横滚可见；设置开 → 已打开的
 *      diff 标签即时折行（updateOptions watch，无需重开标签）；关 → 恢复横滚
 *   ② 初装路径：localStorage font-settings 预置 wordWrap:on → diff 打开即折行
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-word-wrap-follow')
const PROJ = 'e2e-diff-word-wrap-follow'
const FILE = 'long.txt'
const LONG_PREFIX = 'l3-'
const OLD_TAIL = 'OLD-TAIL'
const NEW_TAIL = 'NEW-TAIL'

/** 5 行夹具，第 3 行超长（600 字符 ≈ 4700px @13px 等宽，1280 视口必溢出） */
function content(tail: string, filler: string): string {
  const longLine = LONG_PREFIX + filler.repeat(600) + '-' + tail
  return ['line-001 short', 'line-002 short', longLine, 'line-004 short', 'line-005 short', ''].join('\n')
}

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
  fs.writeFileSync(path.join(REPO_DIR, FILE), content(OLD_TAIL, 'a'))
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  fs.writeFileSync(path.join(REPO_DIR, FILE), content(NEW_TAIL, 'b'))
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: rewrite long line'])
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

/** Monaco 横向滚动条根（双侧子编辑器各一条）：可见性类即溢出实测信号 */
function horizontalScrollbars(page: import('@playwright/test').Page) {
  return page.locator('.monaco-diff-editor .scrollbar.horizontal')
}

test('默认关横滚 → 设置开即时折行（已开标签无需重开）→ 关恢复横滚', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // 默认（wordWrap:off 存量行为）：长行溢出 → 至少一侧横滚可见；变更内容就位
  const bars = horizontalScrollbars(page)
  await expect(bars.first()).toHaveClass(/^visible scrollbar horizontal$/, { timeout: 10000 })
  await expect(page.locator('.monaco-diff-editor .view-line', { hasText: NEW_TAIL }).first()).toBeVisible({ timeout: 10000 })

  // 设置 → 外观 → 自动换行=开启（编辑器行为选项直写 store 即时生效，不参与脏护栏）
  await page.locator('[data-testid="rail-settings"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('[data-testid="settings-nav-appearance"]').click()
  const row = page.locator('.settings-content .slider-row', { hasText: '自动换行' })
  await expect(row).toBeVisible({ timeout: 3000 })
  await row.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: '开启' }).first().click()

  // 反应式路径：已打开的 diff 标签即时折行——横滚条全部转 invisible（无溢出），
  // 模态开着也能生效（updateOptions watch，编辑器常驻挂载）
  await expect(bars.first()).toHaveClass(/^invisible scrollbar horizontal$/, { timeout: 10000 })
  await expect(page.locator('.monaco-diff-editor .scrollbar.horizontal.visible')).toHaveCount(0)

  // 关 → 恢复横滚（可逆，同一标签内）
  await row.locator('.n-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: '关闭' }).first().click()
  await expect(bars.first()).toHaveClass(/^visible scrollbar horizontal$/, { timeout: 10000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
})

test('初装路径：font-settings 预置换行开 → diff 打开即折行无横滚', async ({ page }) => {
  // 固定 locale 后预置 font-settings（store load 与 EDITOR_DEFAULTS 展开合并，
  // 只覆写 wordWrap 其余段走默认）——DiffEditor create 路径直读该值
  await fixedLocale(page)
  await page.addInitScript(() => {
    localStorage.setItem('font-settings', JSON.stringify({ editor: { wordWrap: 'on' } }))
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.commit-item').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-git"]').click()
    await page.waitForTimeout(600)
  }
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // 打开即折行：横滚条全部 invisible，且长行尾段在不滚动时可见（折行收纳进视口）
  const bars = horizontalScrollbars(page)
  await expect(bars.first()).toHaveClass(/^invisible scrollbar horizontal$/, { timeout: 10000 })
  await expect(page.locator('.monaco-diff-editor .scrollbar.horizontal.visible')).toHaveCount(0)
  await expect(page.locator('.monaco-diff-editor .view-line', { hasText: NEW_TAIL }).first()).toBeVisible({ timeout: 10000 })
})
