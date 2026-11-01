import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 编辑器区接收树内拖放打开（P-20261003-13 + P-20261004-74 按落点插入）E2E：
 *   ① 树拖文件到主组 → 悬停组高亮（复用活跃组高亮语）+ 松手落主组打开（空态欢迎页亦可落）
 *   ② 分屏开挂：拖到分屏组内容区 → 该组打开，主组不动；反向拖主组 → 主组打开，分屏组不动
 *   ③ 外部文件（types 含 Files）拖编辑器区 → 不高亮不打开（上传语义只属树/根）
 *   ④ 树拖文件到 tab 条两签之间 → 插入线反馈 + 新签按落点插入该位（不再一律组尾）
 * 拖放以 dispatchEvent + 共享 DataTransfer 模拟（tests/terminal-dnd-path.spec.ts 同款：
 * dragstart 由树行真实 handler 携带 application/x-sc-file-path payload）。
 * 自备临时仓库，afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-editor-drop')
const PROJ = 'e2e-editor-drop'
const FILES = [
  { name: 'drop-a.txt', content: 'drop alpha content' },
  { name: 'drop-b.txt', content: 'drop beta content' },
  { name: 'drop-c.txt', content: 'drop gamma content' },
  { name: 'drop-d.txt', content: 'drop delta content' },
]

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
  for (const f of FILES) fs.writeFileSync(path.join(REPO_DIR, f.name), f.content + '\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 拖放打开基线'])
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

/** 打开项目并确保侧栏文件树可见（树行是拖拽源） */
async function openProject(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.file-tree .item-name', { hasText: FILES[0]!.name })).toBeVisible()
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

/** 派发完整拖放序列：dragstart（树行真实 handler 携带路径 payload）→ dragover → drop → dragend */
async function dragTreeItemTo(page: import('@playwright/test').Page, fileName: string, dst: ReturnType<import('@playwright/test').Page['locator']>) {
  const src = page.locator('.tree-item').filter({ hasText: fileName }).first()
  const srcEl = await src.elementHandle()
  const dstEl = await dst.elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }))
  }, [srcEl, dstEl])
}

test('树拖文件到主组：悬停高亮 + 松手落主组打开（空态欢迎页亦可落）', async ({ page }) => {
  await openProject(page)
  await ensureSplitClosed(page)
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(0) // 空态（欢迎页承载）

  // dragover 高亮（复用活跃组高亮语：pane-drop-target 类）→ dragleave 熄灭
  const pane = page.locator('.pane-primary')
  const paneEl = await pane.elementHandle()
  await page.evaluate(([p, path]) => {
    const dt = new DataTransfer()
    dt.setData('application/x-sc-file-path', path!)
    dt.setData('text/plain', path!)
    p!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [paneEl, FILES[0]!.name])
  await expect(pane).toHaveClass(/pane-drop-target/)
  await page.evaluate((p) => {
    const dt = new DataTransfer()
    p!.dispatchEvent(new DragEvent('dragleave', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, paneEl)
  await expect(pane).not.toHaveClass(/pane-drop-target/)

  // 树行 dragstart（真实 payload）→ 落主组：tab 打开且激活，内容可见，高亮随 drop 熄灭
  await dragTreeItemTo(page, FILES[0]!.name, pane)
  await expect(pane.locator('.editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  await expect(pane.locator('.monaco-editor .view-lines')).toContainText(FILES[0]!.content, { timeout: 8000 })
  await expect(pane).not.toHaveClass(/pane-drop-target/)
})

test('分屏开挂：拖到分屏组落该组，主组不动；反向拖主组落主组，分屏组不动', async ({ page }) => {
  await openProject(page)
  await ensureSplitClosed(page)
  await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()

  // 开分屏：a 落右侧组
  await page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '在右侧分屏打开' }).click()
  await expect(page.locator('.pane-split')).toBeVisible()
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)

  // 树拖 b 到分屏组内容区（经子元素冒泡到组根）：落分屏组，主组仅 a 一签
  await dragTreeItemTo(page, FILES[1]!.name, page.locator('.pane-split .editor-content'))
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[1]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split .monaco-editor .view-lines')).toContainText(FILES[1]!.content, { timeout: 8000 })
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[1]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-primary .editor-tab')).toHaveCount(1)

  // 反向：拖 c 到主组（此刻活跃组是分屏组）→ 落主组，分屏组不动
  await dragTreeItemTo(page, FILES[2]!.name, page.locator('.pane-primary .editor-content'))
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[2]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-primary .monaco-editor .view-lines')).toContainText(FILES[2]!.content, { timeout: 8000 })
  await expect(page.locator('.pane-split .editor-tab', { hasText: FILES[2]!.name })).toHaveCount(0)
  await expect(page.locator('.pane-split .editor-tab')).toHaveCount(2)
})

test('外部文件拖编辑器区：不高亮不打开（上传语义只属树/根）', async ({ page }) => {
  await openProject(page)
  await ensureSplitClosed(page)
  await page.locator('.file-tree .item-name', { hasText: FILES[0]!.name }).first().click()
  await expect(page.locator('.pane-primary .editor-tab', { hasText: FILES[0]!.name })).toBeVisible()

  const pane = page.locator('.pane-primary')
  const contentEl = await page.locator('.pane-primary .editor-content').elementHandle()
  await page.evaluate((dst) => {
    const dt = new DataTransfer()
    dt.items.add(new File(['external'], 'outside.txt', { type: 'text/plain' })) // types 含 Files
    dst!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    dst!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, contentEl)

  // 不进打开路径：无高亮、无新签、无分屏弹出、页面仍在项目路由（未被改写）
  await expect(pane).not.toHaveClass(/pane-drop-target/)
  await expect(pane.locator('.editor-tab')).toHaveCount(1)
  await expect(pane.locator('.editor-tab', { hasText: FILES[0]!.name })).toHaveClass(/active/)
  await expect(page.locator('.pane-split')).toHaveCount(0)
  await expect(page).toHaveURL(/\/project/)
})

/**
 * 树拖文件到 tab 条按落点插入（P-20261004-74）：三 tab 态拖树文件到第 1/2 签
 * 之间 → dragover 期第 2 签左缘出现插入线（drop-line-before），drop 后新签落
 * 下标 1 且激活（对照阅读的顺序意图兑现，不再一律组尾）。
 * 前序用例残留的打开签经树点击幂等（已开即激活），断言锚定「第 2 签左缘」
 * 几何落点而非文件名次序，对恢复残留态鲁棒。
 * 拖拽仍以 dispatchEvent + DataTransfer 模拟：dragstart 走树行真实 handler 携
 * 路径 payload；dragover/drop 定位到 tab 条容器并携 clientX（落点命中判定输入）。
 */
test('树拖文件到 tab 条两签之间：插入线 + 新签按落点插入该位', async ({ page }) => {
  await openProject(page)
  await ensureSplitClosed(page)
  // 三 tab 态：a/b/c 依次树点开
  for (const f of FILES.slice(0, 3)) {
    await page.locator('.file-tree .item-name', { hasText: f.name }).first().click()
  }
  const pane = page.locator('.pane-primary')
  const tabs = pane.locator('.editor-tab')
  await expect(tabs).toHaveCount(3)

  // dragover 期：落点取第 2 签左缘（中点判定 → 插入下标 1），dragstart 用树行
  // 真实 handler 携双 payload；插入线应出现在第 2 签（drop-line-before）
  const tab2 = tabs.nth(1)
  const box = await tab2.boundingBox()
  const tabsEl = await pane.locator('.editor-tabs').elementHandle()
  const srcEl = await page.locator('.tree-item').filter({ hasText: FILES[3]!.name }).first().elementHandle()
  expect(box).toBeTruthy()
  expect(tabsEl).toBeTruthy()
  await page.evaluate(([s, d, cx, cy]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx!, clientY: cy! }))
  }, [srcEl, tabsEl, box!.x + 2, box!.y + box!.height / 2])
  await expect(tab2).toHaveClass(/drop-line-before/)

  // drop 定案：drop 事件另起同 payload DataTransfer（应用侧 drop 只读本事件
  // dataTransfer + dragover 期记录的落点下标，两段 dt 一致性无依赖）；新签落
  // 下标 1、激活、内容装载，插入线随 drop 熄灭
  await page.evaluate(([d, cx, cy, p]) => {
    const dt = new DataTransfer()
    dt.setData('application/x-sc-file-path', p!)
    dt.setData('text/plain', p!)
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true, clientX: cx!, clientY: cy! }))
  }, [tabsEl, box!.x + 2, box!.y + box!.height / 2, FILES[3]!.name])
  await expect(tabs).toHaveCount(4)
  await expect(tabs.nth(1).locator('.tab-name')).toHaveText(FILES[3]!.name)
  await expect(tabs.nth(1)).toHaveClass(/active/)
  await expect(pane.locator('.monaco-editor .view-lines')).toContainText(FILES[3]!.content, { timeout: 8000 })
  await expect(tab2).not.toHaveClass(/drop-line-before/)
})
