import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 活动栏面板拖拽重排（P-20261003-252）：rail-top 图标拖到目标图标 = 移到其前，
 * 顺序落 uiState railOrder 命名空间（即时写），刷新后 bootstrap 恢复；
 * Ctrl+1-9 数字直达按视觉位置取面板（registry panelList 唯一出口）——重排后
 * 「数字 = 位置」随新序；布局锁定（P-20261003-180）锁定态拖拽短路（interceptDrag
 * 拖拽不启动），解锁后恢复、点击不受影响。
 *   ① 拖拽重排生效（服务端落盘）+ 刷新持久（bootstrap 恢复链）
 *   ② Ctrl+N 随新序：重排后 Ctrl+1 打开的是新第 1 位面板（终端），Ctrl+2 文件
 *   ③ 锁定→拖拽短路（顺序与服务端均不变）+ 点击照常；解锁→拖拽恢复
 * 自备临时仓库（活动栏挂载宿主=项目页），afterAll 清理（含 uiState local，
 * railOrder 不残留给邻域 spec）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-rail-drag')
const PROJ = 'e2e-rail-drag'

/** 出厂视觉序（registry.test.ts 同源：内置 order 升序的 testid 表）
 *  rail-env（项目环境画像，P-20261007-14，order 66）居 dashboard(65) 之后；
 *  rail-sync（多实例同步中心，P-20261023-1，order 67）居 env(66) 之后尾部追加。 */
const DEFAULT_ORDER = [
  'rail-files', 'rail-changes', 'rail-todos', 'rail-git', 'rail-terminal',
  'rail-notes', 'rail-stream', 'rail-agent-terminal', 'rail-share-manager',
  'rail-dsh-console', 'rail-remote-console', 'rail-dashboard', 'rail-env', 'rail-sync',
]
/** terminal 拖到 files 前（insert-before）后的期望序 */
const AFTER_ORDER = [
  'rail-terminal', 'rail-files', 'rail-changes', 'rail-todos', 'rail-git',
  'rail-notes', 'rail-stream', 'rail-agent-terminal', 'rail-share-manager',
  'rail-dsh-console', 'rail-remote-console', 'rail-dashboard', 'rail-env', 'rail-sync',
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
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'rail drag baseline\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 活动栏拖拽重排基线'])
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
  // 清 uiState（railOrder 命名空间随实例记录整体清掉，不给邻域 spec 留残留）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进入项目页。每用例先清 uiState 再 reload：前序用例/重试残留（含上轮的
 *  railOrder/锁定态）不再作为依赖，行为只由本用例驱动（layout-lock 同款） */
async function enterProject(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.evaluate(async () => {
    // 页内同源 fetch 自动携带 HttpOnly 锁 cookie（P-20261019-2 起无头可带）
    await fetch('/api/ui-state', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ local: null }),
    })
  })
  await page.reload()
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  // 解锁后延迟出现的默认密码提醒遮罩会拦截后续点击/快捷键，先收起
  //（panel-registry 同款防御；全新数据面上才弹出，出现与否两可）
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  try {
    await pwdTip.waitFor({ state: 'visible', timeout: 4000 })
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
  } catch { /* 未出现则继续 */ }
  await expect(page.locator('.ide-rail .rail-top .rail-btn').first()).toBeVisible()
}

/** 归一化基线：侧栏与底部面板均关闭（toggle 语义下只有从关闭基线出发
 *  数字键结果才确定；panel-registry 数字直达用例同款） */
async function closePanelsBaseline(page: Page) {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('#side-panel').isVisible().catch(() => false))) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(400)
  }
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('.bottom-tabs button').first().isVisible().catch(() => false))) break
    await page.keyboard.press('Control+`')
    await page.waitForTimeout(400)
  }
  await expect(page.locator('#side-panel')).toBeHidden()
  await expect(page.locator('.bottom-tabs button').first()).toBeHidden()
}

/** 活动栏视觉序（rail-top 按钮 testid 表，DOM 序 = 注册表 panelList 输出） */
function railOrder(page: Page): Promise<string[]> {
  return page.locator('.ide-rail .rail-top .rail-btn').evaluateAll(els =>
    els.map(e => e.getAttribute('data-testid') || ''))
}

/** 派发完整行拖放序列（layout-lock 树拖拽同款：dragstart 打在源按钮真实
 *  handler 上，dragover/drop 打在目标按钮，dragend 收尾） */
async function dragRailTo(page: Page, srcId: string, dstId: string) {
  const src = await page.locator(`[data-testid="${srcId}"]`).elementHandle()
  const dst = await page.locator(`[data-testid="${dstId}"]`).elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [src, dst])
}

/** 服务端 uiState railOrder 命名空间（即时写链路，落定即判） */
async function serverRailTop(): Promise<string[] | undefined> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as { data?: { local?: { railOrder?: { railTop?: string[] } } } }
  return body.data?.local?.railOrder?.railTop
}

test.describe('活动栏面板拖拽重排', () => {
  test('拖拽重排生效（落点序+服务端落盘），刷新后 bootstrap 恢复持久', async ({ page }) => {
    await enterProject(page)
    await expect.poll(() => railOrder(page)).toEqual(DEFAULT_ORDER)

    // terminal 图标拖到 files 上 = 移到其前（insert-before）
    await dragRailTo(page, 'rail-terminal', 'rail-files')
    await expect.poll(() => railOrder(page)).toEqual(AFTER_ORDER)

    // 拖拽反馈清理：落点插入线随 dragend 退场
    await expect(page.locator('.rail-btn.rail-drop-target')).toHaveCount(0)
    await expect(page.locator('.rail-btn.rail-dragging')).toHaveCount(0)

    // 即时写落盘（不等防抖/关页）
    await expect.poll(() => serverRailTop(), { timeout: 10000 }).toEqual(AFTER_ORDER.map(t => t.replace(/^rail-/, '')))

    // 刷新持久：bootstrap 从 uiState railOrder 恢复视觉序
    await page.reload()
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
    await page.waitForURL('**/project')
    await expect.poll(() => railOrder(page)).toEqual(AFTER_ORDER)
  })

  test('Ctrl+N 随新序：重排后 Ctrl+1=终端（底部）、Ctrl+2=文件（侧栏）', async ({ page }) => {
    await enterProject(page)
    await closePanelsBaseline(page)
    await expect.poll(() => railOrder(page)).toEqual(DEFAULT_ORDER)
    await dragRailTo(page, 'rail-terminal', 'rail-files')
    await expect.poll(() => railOrder(page)).toEqual(AFTER_ORDER)

    // 重排前 Ctrl+1 = 项目文件（panel-registry.spec 已锁）；重排后第 1 位是
    // 终端——数字=位置语义随新序：Ctrl+1 直达底部终端面板
    await page.keyboard.press('Control+1')
    await expect(page.locator('.bottom-tabs button').filter({ hasText: '终端' })).toHaveClass(/primary/, { timeout: 5000 })
    await expect(page.locator('.ide-rail [data-testid="rail-terminal"]')).toHaveClass(/active/)

    // Ctrl+2 = 新第 2 位（项目文件）→ 侧栏开
    await page.keyboard.press('Control+2')
    await expect(page.locator('#side-panel')).toBeVisible({ timeout: 5000 })
    await expect(page.locator('.ide-rail [data-testid="rail-files"]')).toHaveClass(/active/)
  })

  test('锁定态拖拽短路（顺序与服务端均不变）+点击照常；解锁拖拽恢复', async ({ page }) => {
    await enterProject(page)
    await expect.poll(() => railOrder(page)).toEqual(DEFAULT_ORDER)

    // 锁定（顶栏小锁）：body 类 + 拖拽短路
    await page.locator('[data-testid="topbar-layout-lock"]').click()
    await expect(page.locator('[data-testid="topbar-layout-lock"]')).toHaveClass(/active/)
    expect(await page.evaluate(() => document.body.classList.contains('sc-layout-locked'))).toBe(true)
    await dragRailTo(page, 'rail-terminal', 'rail-files')
    await expect.poll(() => railOrder(page)).toEqual(DEFAULT_ORDER)
    // 短路在 dragstart：drop 未发生，服务端零 railOrder 写
    expect(await serverRailTop()).toBeUndefined()

    // 点击不受锁定影响（interceptDrag 只拦拖拽类手势）
    await page.locator('[data-testid="rail-git"]').click()
    await expect(page.locator('.bottom-tabs button').filter({ hasText: 'Git' })).toHaveClass(/primary/, { timeout: 5000 })

    // 解锁→同一拖拽恢复生效并落盘（失败可恢复：锁定不吞重排能力）
    await page.locator('[data-testid="topbar-layout-lock"]').click()
    await expect(page.locator('[data-testid="topbar-layout-lock"]')).not.toHaveClass(/active/)
    await dragRailTo(page, 'rail-terminal', 'rail-files')
    await expect.poll(() => railOrder(page)).toEqual(AFTER_ORDER)
    await expect.poll(() => serverRailTop(), { timeout: 10000 }).toEqual(AFTER_ORDER.map(t => t.replace(/^rail-/, '')))
  })
})
