import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * tab 跨分屏组拖拽移动（P-20261003-38）E2E：
 *   ① 组 0 拖 tab 到组 1：悬停整组高亮（pane-drop-target，树拖放同视觉语）→
 *      松手移动语义——组 1 打开且激活、组 0 摘签、滚动位置/光标随签保持
 *      （viewState 快照桶随 moveTabToGroup 迁移）
 *   ② 同组拖拽仍为组内重排（跨组载荷不误伤既有重排语义）
 *   ③ Alt 修饰落点 = 复制：目标组成签、源组保留（同一共享对象双签）
 *   ④ 组 1 最后一签拖回组 0：分屏收组（既有「组空即收组」规则）
 * 拖放以 dispatchEvent + 共享 DataTransfer 模拟，dragstart 打在真实 tab 元素上
 * 由组件 handler 携带 application/x-sc-editor-tab 载荷（editor-drop-open.spec
 * 树拖放同款手法）；滚动/光标断言复用 editor-viewstate.spec 的取数方式。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-tab-cross-drag')
const PROJ = 'e2e-tab-cross-drag'
const FILE_A = 'cross-a.txt'
const FILE_B = 'cross-b.txt'
/** 光标落点（1-based 行号，fixture 中与 MARK 行号严格一致） */
const MARK_LINE = 120

function buildFixtureA(): string {
  const lines: string[] = ['// cross-drag fixture A：滚动位置随签迁移']
  for (let i = 1; i <= 260; i++) {
    if (i === MARK_LINE) lines.push(`// MARK-A-${i} 光标落点`)
    else lines.push(`// fixture A line ${i}`)
  }
  return lines.join('\n')
}

function buildFixtureB(): string {
  const lines: string[] = ['// fixture B line 0']
  for (let i = 1; i <= 40; i++) lines.push(`// fixture B line ${i} b-marker-${i}`)
  return lines.join('\n')
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
  fs.writeFileSync(path.join(REPO_DIR, FILE_A), buildFixtureA())
  fs.writeFileSync(path.join(REPO_DIR, FILE_B), buildFixtureB())
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: tab 跨组拖拽基线'])
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
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 打开项目并经文件树打开 A、B 两文件（幂等：已开的只会被激活） */
async function openProjectAndFiles(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: FILE_A }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
  await page.locator('.file-tree .item-name', { hasText: FILE_B }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toBeVisible()
}

/** 若上次会话恢复出分屏（空态占位或带文件），先一键关闭归到单组 */
async function ensureSplitClosed(page: import('@playwright/test').Page) {
  if (!(await page.locator('.pane-split').isVisible().catch(() => false))) return
  const emptyClose = page.locator('.split-empty-close')
  if (await emptyClose.isVisible().catch(() => false)) {
    await emptyClose.click()
  } else {
    await page.locator('.pane-split .editor-tab').first().click({ button: 'right' })
    await page.getByRole('menuitem', { name: '关闭分屏' }).click()
  }
  await expect(page.locator('.pane-split')).toHaveCount(0)
}

/** 分屏组经 tab 右键「在右侧分屏打开」开出 FILE_B（幂等：已开只激活） */
async function ensureSplitWithB(page: import('@playwright/test').Page) {
  if (await page.locator('.pane-split .editor-tab', { hasText: FILE_B }).isVisible().catch(() => false)) return
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_B }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILE_B })).toBeVisible()
}

/**
 * 派发完整 tab 拖放序列：dragstart 打在源 tab 上（真实 handler 携带
 * application/x-sc-editor-tab 载荷）→ dragover/drop 打在目标组（组根经冒泡承接）
 * → dragend 收尾清会话态。alt=true 时 drop 带 Alt 修饰（复制语义）
 */
async function dragTabTo(
  page: import('@playwright/test').Page,
  srcTab: ReturnType<import('@playwright/test').Page['locator']>,
  dst: ReturnType<import('@playwright/test').Page['locator']>,
  opts?: { alt?: boolean },
) {
  const srcEl = await srcTab.elementHandle()
  const dstEl = await dst.elementHandle()
  await page.evaluate(([s, d, alt]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, altKey: alt! }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, altKey: alt! }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [srcEl, dstEl, opts?.alt ?? false])
}

/** 垂直滚动位置：本 Monaco 版本滚动作用在 .view-lines 位移上
 *  （editor-viewstate.spec 同款取数） */
async function readScrollTop(page: import('@playwright/test').Page, pane: string): Promise<number> {
  const ed = await page.locator(`${pane} .monaco-editor`).boundingBox()
  const vl = await page.locator(`${pane} .monaco-editor .view-lines`).boundingBox()
  return ed && vl ? Math.max(0, ed.y - vl.y) : 0
}

/** 光标 1-based 行号：cursor 的 content 坐标 top / 行高（滚出视口也成立） */
async function cursorLine(page: import('@playwright/test').Page, pane: string): Promise<number> {
  return page.locator(`${pane} .monaco-editor .cursor`).first().evaluate((el) => {
    const h = parseFloat((el as HTMLElement).style.height) || 22
    return Math.round(parseFloat((el as HTMLElement).style.top) / h) + 1
  })
}

/** Ctrl+G 转行落光标（键盘路径确定性最好，viewstate spec 同款），返回滚动位 */
async function gotoLine(page: import('@playwright/test').Page, pane: string, line: number): Promise<number> {
  await page.locator(`${pane} .monaco-editor`).click({ position: { x: 250, y: 200 } })
  await page.keyboard.press('Control+G')
  await page.keyboard.type(String(line))
  await page.keyboard.press('Enter')
  await expect.poll(() => cursorLine(page, pane), { timeout: 5000 }).toBe(line)
  const top = await readScrollTop(page, pane)
  expect(top).toBeGreaterThan(1000) // 120 行深处的滚动位，非 1:1 顶部
  return top
}

test('组 0 拖 tab 到组 1：整组高亮 + 移动语义（组 1 打开组 0 摘签）+ 滚动位置保持', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)
  await ensureSplitWithB(page)

  // 主组 A 落 120 行（分屏布局稳定后再取基线：分屏开合会触发 Monaco 重排）
  await page.locator('.pane-primary .editor-tab', { hasText: FILE_A }).click()
  const scrollBefore = await gotoLine(page, '.pane-primary', MARK_LINE)

  // 拖 A 的 tab 到分屏组 tab 条：dragover 整组高亮（树拖放同视觉语）
  const splitPane = page.locator('.pane-split')
  await dragTabTo(
    page,
    page.locator('.pane-primary .editor-tab', { hasText: FILE_A }),
    page.locator('.pane-split .editor-tabs'),
    { alt: false },
  )

  // 移动语义：组 1 打开 A 且激活，组 0 摘签只剩 B，高亮随 drop 熄灭
  await expect(splitPane.locator('.editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(1)
  await expect(splitPane).not.toHaveClass(/pane-drop-target/)

  // 滚动位置/光标随签保持（viewState 快照桶随移动迁移）
  await expect.poll(() => cursorLine(page, '.pane-split'), { timeout: 5000 }).toBe(MARK_LINE)
  await expect.poll(async () => readScrollTop(page, '.pane-split'), { timeout: 5000 })
    .toBeGreaterThan(scrollBefore - 2)
})

test('同组拖拽仍为组内重排：顺序对调、不跨组、不触发分屏变化', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)

  // 新页面 boot 不恢复文件列表：树点击顺序即组 0 顺序 [A, B]
  const before = await page.locator('.pane-primary .editor-tab .tab-name').allTextContents()
  expect(before).toEqual([FILE_A, FILE_B])

  // 组内拖 A 到 B（dragover 即实时重排，既有语义）→ A 跨过 B 落到其右 [B, A]
  await dragTabTo(
    page,
    page.locator('.pane-primary .editor-tab', { hasText: FILE_A }),
    page.locator('.pane-primary .editor-tab', { hasText: FILE_B }),
  )

  const names = await page.locator('.pane-primary .editor-tab .tab-name').allTextContents()
  expect(names).toEqual([FILE_B, FILE_A])
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-split')).toHaveCount(0) // 同组拖拽不弹分屏
})

test('Alt 落点=复制：目标组成签源组保留，同一共享对象双签', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)
  await ensureSplitWithB(page)

  // Alt 拖 A → 组 1：A 成签但组 0 保留（对比移动语义的摘签）
  await dragTabTo(
    page,
    page.locator('.pane-primary .editor-tab', { hasText: FILE_A }),
    page.locator('.pane-split .editor-tabs'),
    { alt: true },
  )

  await expect(page.locator('.pane-split .editor-tab', { hasText: FILE_A })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(2)
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_A })).toBeVisible()
})

test('组 1 最后一签拖回组 0：移动完成即收分屏（组空即收组既有规则）', async ({ page }) => {
  await openProjectAndFiles(page)
  await ensureSplitClosed(page)
  await ensureSplitWithB(page)
  // 确保组 1 仅 B 一签（前例可能把 A 留在组 1：先拖回组 0 归一）
  if (await page.locator('.pane-split .editor-tab', { hasText: FILE_A }).isVisible().catch(() => false)) {
    await dragTabTo(
      page,
      page.locator('.pane-split .editor-tab', { hasText: FILE_A }),
      page.locator('.pane-primary .editor-tabs'),
    )
    await expect(page.locator('.pane-split .editor-tab', { hasText: FILE_A })).toHaveCount(0)
  }

  // 拖组 1 仅剩的 B 回组 0：组 1 搬空 → 分屏收起，B 落回组 0 激活（共享对象不重复）
  await dragTabTo(
    page,
    page.locator('.pane-split .editor-tab', { hasText: FILE_B }),
    page.locator('.pane-primary .editor-tabs'),
  )

  await expect(page.locator('.pane-split')).toHaveCount(0)
  const names = await page.locator('.pane-primary .editor-tab .tab-name').allTextContents()
  expect(names.filter(n => n === FILE_B)).toHaveLength(1) // 共享对象不重复成签
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILE_B })).toHaveClass(/active/)
})
