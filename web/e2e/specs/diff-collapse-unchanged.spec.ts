import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * diff 折叠未变区域开关 E2E（P-20261003-40）：夹具 = c2 相对 c1 改两个大文件，
 * 未变区各段均远超 Monaco minimumLineCount(3)、扣除 contextLineCount(3) 后仍有
 * 大段隐藏行。
 * 断言锚 = 折叠区 overlay 根节点 .diff-hidden-lines-widget（Monaco
 * hideUnchangedRegionsFeature 的 CollapsedCodeOverlayWidget，overlay widget 常驻
 * DOM 不随视口虚拟化，仅选项开启且区域实际隐藏时渲染；数量 = 可折叠区段数 ×
 * 并排双侧，随夹具几何确定）。变更行的文本在 .view-line 上（.line-insert 是
 * 空文本的装饰层元素，hasText 过滤不命中——见 diff-ignore-ws 只断言其可见）：
 *   1. FILE1（200 行 5 处散布修改）：默认关（行为不变）→ 开开关即时折叠（12 个
 *      折叠区、未变内容行不可见）→ 关开关即时恢复（可逆）→ 再开折叠后「下一个
 *      变更」连跳 5 处直达末个修改（首处修改滚出视口——导航跳过折叠区，折叠态下
 *      内容仍超出视口故滚动位移可断言）
 *   2. 切换同提交另一文件 diff：EditorGroupPane 在 loading 分支卸载编辑器，切换
 *      后是全新实例——折叠回默认关（会话级状态不跨实例，与不持久化惯例一致），
 *      开关对新文件同样生效且可逆
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-diff-collapse-unchanged')
const PROJ = 'e2e-diff-collapse-unchanged'
const FILE1 = 'big.txt'
const FILE2 = 'huge.txt'

/** 200 行基线，第 20/60/100/140/180 行五处原地修改（折叠后仍 ~780px 内容，
 *  超出 ~450px 视口——导航产生真实滚动位移可断言） */
function content200(overrides: Record<number, string>): string {
  const lines: string[] = []
  for (let i = 1; i <= 200; i++) lines.push(overrides[i] ?? `line-${String(i).padStart(3, '0')} content`)
  return lines.join('\n') + '\n'
}

/** 24 行基线，第 12 行原地修改 → 未变区 11/12 行两段可折叠 */
function content24(overrides: Record<number, string>): string {
  const lines: string[] = []
  for (let i = 1; i <= 24; i++) lines.push(overrides[i] ?? `row-${String(i).padStart(2, '0')} content`)
  return lines.join('\n') + '\n'
}

const C1_FILES: Record<string, string> = {
  [FILE1]: content200({}),
  [FILE2]: content24({}),
}
const C2_FILES: Record<string, string> = {
  [FILE1]: content200({
    20: 'line-020 CHANGED-ALPHA',
    60: 'line-060 CHANGED-BRAVO',
    100: 'line-100 CHANGED-CHARLIE',
    140: 'line-140 CHANGED-DELTA',
    180: 'line-180 CHANGED-ECHO',
  }),
  [FILE2]: content24({ 12: 'row-12 CHANGED-GAMMA' }),
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
  for (const [name, content] of Object.entries(C1_FILES)) {
    fs.writeFileSync(path.join(REPO_DIR, name), content)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c1: baseline'])
  for (const [name, content] of Object.entries(C2_FILES)) {
    fs.writeFileSync(path.join(REPO_DIR, name), content)
  }
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'c2: scattered changes in big files'])
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
    .filter({ hasText: FILE1 })
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

test('默认关 → 开折叠未变区折叠显示 → 关恢复 → 再开导航连跳 5 处直达末个修改', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // 默认（开关关）：Monaco hideUnchangedRegions 默认 enabled:false，无折叠区，
  // 顶部未变行照常渲染（第 6 行距顶 132px，必在视口内）
  const toggle = page.locator('.diff-nav-bar button[title="折叠未变区域"]')
  await expect(toggle).toBeVisible()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  const widgets = page.locator('.monaco-diff-editor .diff-hidden-lines-widget')
  await expect(widgets).toHaveCount(0)
  const topLine = page.locator('.monaco-diff-editor .view-line', { hasText: 'line-006 content' }).first()
  await expect(topLine).toBeVisible({ timeout: 10000 })

  // 开折叠 → 即时生效：6 个可折叠区段 × 并排双侧 = 12 个折叠区 overlay，
  // 顶部未变行落入隐藏区（1..15 行被折叠，16..19 为变更上文 context 保留）
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(widgets).toHaveCount(12, { timeout: 10000 })
  await expect(topLine).not.toBeVisible()

  // 关折叠 → 即时恢复：折叠区清零，未变内容回显（可逆）
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(widgets).toHaveCount(0, { timeout: 10000 })
  await expect(topLine).toBeVisible({ timeout: 10000 })

  // 再开折叠 → 「下一个变更」连跳 5 处直达第 5 个修改（line-180 ECHO）：
  // 折叠态下内容仍超出视口，首处修改（line-20 ALPHA）滚出视口——导航跳过
  // 折叠区直达变更，折叠区保持（变更行永不落入折叠区）
  await toggle.click()
  await expect(widgets).toHaveCount(12, { timeout: 10000 })
  const nextBtn = page.locator('.diff-nav-bar button[title="下一个变更 (Alt+↓)"]')
  for (let i = 0; i < 5; i++) await nextBtn.click()
  const echoRow = page.locator('.monaco-diff-editor .view-line', { hasText: 'CHANGED-ECHO' }).first()
  await expect(echoRow).toBeVisible({ timeout: 10000 })
  const alphaRow = page.locator('.monaco-diff-editor .view-line', { hasText: 'CHANGED-ALPHA' }).first()
  await expect(alphaRow).not.toBeVisible()
  await expect(widgets.first()).toBeVisible()
})

test('切换同提交另一文件 diff：实例热切——折叠开关态保持（aria-pressed 不回 false）→内容正确切换', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // FILE1 上开折叠（6 区段 × 2 侧 = 12 个折叠区）确认开关生效
  const toggle = page.locator('.diff-nav-bar button[title="折叠未变区域"]')
  await expect(toggle).toBeVisible()
  await toggle.click()
  const widgets = page.locator('.monaco-diff-editor .diff-hidden-lines-widget')
  await expect(widgets).toHaveCount(12, { timeout: 10000 })

  // 双击 FILE2 节点（与「查看此次变更」同语义）切换 diff：目标 tab 装载窗口内
  // 编辑器不卸载（P-20261004-100 实例热切），开关态跨文件保持——FILE2 内容
  // 就位后折叠即已生效（2 可折叠区段 × 2 侧 = 4 个折叠区，无需再点开关）
  const node2 = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE2 })
    .first()
  await node2.dblclick()
  await expect(page.locator('.monaco-diff-editor')).toBeVisible({ timeout: 15000 })
  await expect(toggle).toHaveAttribute('aria-pressed', 'true')
  await expect(widgets).toHaveCount(4, { timeout: 10000 })

  // 内容正确切换：FILE2 的变更行（row-12 GAMMA）可见，顶部未变行 row-01
  // 落入隐藏区 1..8 不可见
  const gammaRow = page.locator('.monaco-diff-editor .view-line', { hasText: 'CHANGED-GAMMA' }).first()
  await expect(gammaRow).toBeVisible({ timeout: 10000 })
  const row1 = page.locator('.monaco-diff-editor .view-line', { hasText: 'row-01 content' }).first()
  await expect(row1).not.toBeVisible()

  // 开关对新文件仍可逆：关 → 折叠区清零回显，开 → 重新折叠
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-pressed', 'false')
  await expect(widgets).toHaveCount(0, { timeout: 10000 })
  await expect(row1).toBeVisible({ timeout: 10000 })
  await toggle.click()
  await expect(widgets).toHaveCount(4, { timeout: 10000 })
})

test('同组 diff 标签间往返：滚动位不跳顶（切回上一文件恢复原位）', async ({ page }) => {
  await enterAndOpenLog(page)
  const node = await selectChangeCommit(page)
  await openDiffEditor(page, node)

  // FILE1（默认折叠关）：「下一个变更」跳到首处修改 line-20 ALPHA——视口随动，
  // 顶部 line-006（~132px 处）滚出视口
  const nextBtn = page.locator('.diff-nav-bar button[title="下一个变更 (Alt+↓)"]')
  await nextBtn.click()
  const alphaRow = page.locator('.monaco-diff-editor .view-line', { hasText: 'CHANGED-ALPHA' }).first()
  await expect(alphaRow).toBeVisible({ timeout: 10000 })
  const topLine = page.locator('.monaco-diff-editor .view-line', { hasText: 'line-006 content' }).first()
  await expect(topLine).not.toBeVisible()

  // 切到 FILE2 diff（新 tab 装载窗口内沿用 FILE1 画面）→ 内容就位
  const node2 = page.locator('.commits-right .diff-node')
    .filter({ has: page.locator('.diff-status') })
    .filter({ hasText: FILE2 })
    .first()
  await node2.dblclick()
  const gammaRow = page.locator('.monaco-diff-editor .view-line', { hasText: 'CHANGED-GAMMA' }).first()
  await expect(gammaRow).toBeVisible({ timeout: 15000 })

  // 点标签切回 FILE1：滚动位恢复到离开时的 ALPHA 位（视图状态按伪键快照），
  // 不回顶——回顶则 line-006 必然可见
  await page.locator('.editor-tab').filter({ hasText: FILE1 }).first().click()
  await expect(alphaRow).toBeVisible({ timeout: 10000 })
  await expect(topLine).not.toBeVisible()
})
