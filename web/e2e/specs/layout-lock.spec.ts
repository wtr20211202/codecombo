import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 布局锁定（P-20261003-180）：顶栏小锁 toggle——锁定时分隔条拖拽/文件树拖拽
 * （含多选）等拖拽类交互统一短路，点击与键盘不受影响；解锁恢复；状态落
 * uiState layoutLock 命名空间、刷新后恢复。
 *   ① 锁定→侧栏 resizer 拖不动（同用例内先做解锁正控）+ 树拖拽不移动 +
 *     body 类；点击（展开/开文件）照常
 *   ② 解锁（命令面板同源入口）→拖拽恢复（resizer 生效 + 树移动正控落盘）
 *   ③ 刷新持久：锁定→reload 仍锁定且拖拽仍无效；解锁→reload 仍解锁
 * 自备临时仓库（README + docs/ + 探针文件），afterAll 清理。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-layout-lock')
const PROJ = 'e2e-layout-lock'
const PROBE = 'lockprobe.md'
/** #side-panel 内联宽度样式断言（出厂 280 / 拖窄钳位下限 180） */
const widthStyle = (w: number) => new RegExp(`width:\\s*${w}px`)

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
  fs.mkdirSync(path.join(REPO_DIR, 'docs'), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, 'README.md'), 'layout lock baseline\n')
  fs.writeFileSync(path.join(REPO_DIR, 'docs', 'note.md'), 'target dir\n')
  fs.writeFileSync(path.join(REPO_DIR, PROBE), 'drag probe\n')
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 布局锁定基线'])
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
  // 清 uiState（layoutLock 命名空间随实例记录整体清掉，不给邻域 spec 留残留）
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: JSON.stringify({ local: null }),
  })
})

/** 进入项目页并保证文件树可见。每用例先清 uiState 再 reload：前序用例/重试
 *  残留（含上轮的 layoutLock 锁定态）不再作为依赖，行为只由本用例驱动 */
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
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name').first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
}

function lockButton(page: Page) {
  return page.locator('[data-testid="topbar-layout-lock"]')
}

function itemName(page: Page, name: string) {
  return page.locator('.item-name').filter({ hasText: new RegExp(`^${name.replace(/\./g, '\\.')}$`) })
}

/** 侧栏 resizer 拖拽 dx 像素（负=拖窄；钳位 [180,500]。锁定时被短路原地不动） */
async function dragSideResizer(page: Page, dx = -120) {
  const resizer = page.locator('.ide-side-resizer')
  const box = await resizer.boundingBox()
  const startX = box!.x + box!.width / 2
  const y = box!.y + 200
  await page.mouse.move(startX, y)
  await page.mouse.down()
  await page.mouse.move(startX + dx, y, { steps: 5 })
  await page.mouse.up()
}

/** 派发完整行拖放序列（file-tree-multi-move 同款：dragstart 打在源行真实
 *  handler 上，dragover/drop 打在目标目录行，dragend 收尾） */
async function dragRowTo(page: Page, srcName: string, dstName: string) {
  const src = await page.locator('.tree-item').filter({ has: itemName(page, srcName) }).first().elementHandle()
  const dst = await page.locator('.tree-item').filter({ has: itemName(page, dstName) }).first().elementHandle()
  await page.evaluate(([s, d]) => {
    const dt = new DataTransfer()
    s!.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }))
    d!.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }))
    s!.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true, cancelable: true }))
  }, [src, dst])
}

/** 轮询服务端 uiState layoutLock 命名空间（即时写链路，落定即判） */
async function serverLockState(): Promise<boolean | undefined> {
  const headers = await unlockHeaders()
  const res = await fetch(`${API_BASE}/api/ui-state`, { headers })
  const body = (await res.json()) as { data?: { local?: { layoutLock?: { locked?: boolean } } } }
  return body.data?.local?.layoutLock?.locked
}

/** 等服务端锁定态到达期望值 */
async function waitForServerLock(expected: boolean, page: Page) {
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    if ((await serverLockState()) === expected) return
    await page.waitForTimeout(500)
  }
  expect(await serverLockState(), `服务端 layoutLock 未到达 ${expected}`).toBe(expected)
}

test.describe('布局锁定（防误拖）', () => {
  test('锁定→分隔条拖不动+树拖拽不移动+body类，点击（展开/开文件）照常', async ({ page }) => {
    await enterProject(page)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280))

    // 锁定前正控：resizer 可拖（280→180）再拖回复位（证明短路是锁的效果而非拖拽坏了）
    await dragSideResizer(page, -120)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180), { timeout: 3000 })
    await dragSideResizer(page, 100)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280), { timeout: 3000 })

    // 锁定：按钮 active 态 + tooltip 翻转为「解锁布局」+ body 类
    await lockButton(page).click()
    await expect(lockButton(page)).toHaveClass(/active/)
    await expect(lockButton(page)).toHaveAttribute('title', /解锁布局/)
    expect(await page.evaluate(() => document.body.classList.contains('sc-layout-locked'))).toBe(true)

    // 锁定后：resizer 拖拽短路——宽度原地不动
    await dragSideResizer(page, -120)
    await page.waitForTimeout(400)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280))

    // 树拖拽短路：探针文件拖到 docs 目录 → 不移动（根上还在）
    await dragRowTo(page, PROBE, 'docs')
    await page.waitForTimeout(600)
    await expect(itemName(page, PROBE)).toHaveCount(1)

    // 点击/键盘不受影响：docs 目录点击展开（显示 note.md）、点开 README 开签
    await itemName(page, 'docs').click()
    await expect(itemName(page, 'note.md')).toBeVisible({ timeout: 5000 })
    await itemName(page, 'README.md').click()
    await expect(page.locator('.editor-tab', { hasText: 'README.md' })).toBeVisible({ timeout: 30000 })
  })

  test('解锁（命令面板同源入口）→拖拽恢复：resizer 生效+树移动正控落盘', async ({ page }) => {
    await enterProject(page)
    await lockButton(page).click()
    await expect(lockButton(page)).toHaveClass(/active/)

    // 命令面板入口同源：锁定态下标题为「解锁布局」，执行即解锁
    // （'>' 前缀进命令模式——面板默认 files 模式，layout-reset 同款）
    await page.keyboard.press('Control+k')
    const input = page.locator('.palette-input input')
    await expect(input).toBeVisible({ timeout: 5000 })
    await input.fill('>解锁布局')
    const item = page.locator('.palette-item').filter({ hasText: '解锁布局' }).first()
    await expect(item).toBeVisible({ timeout: 5000 })
    await item.click()
    await expect(lockButton(page)).not.toHaveClass(/active/)
    expect(await page.evaluate(() => document.body.classList.contains('sc-layout-locked'))).toBe(false)

    // 解锁后 resizer 拖拽恢复生效。先等命令面板完全退场——palette-fade 过渡
    // 途中遮罩仍可命中（elementFromPoint 实证命中淡出中的 palette-item），
    // 紧接的 resizer mousedown 会被吞掉
    await expect(page.locator('.palette-input input')).toBeHidden({ timeout: 5000 })
    await dragSideResizer(page, -120)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(180), { timeout: 3000 })

    // 树拖拽正控：探针文件真的移进 docs（对比用例 1 的锁定短路）
    await dragRowTo(page, PROBE, 'docs')
    await expect(itemName(page, PROBE)).toHaveCount(0, { timeout: 5000 })
    await itemName(page, 'docs').click()
    await expect(itemName(page, PROBE)).toBeVisible({ timeout: 5000 })
  })

  test('刷新持久：锁定→reload 仍锁定且拖拽仍无效；解锁→reload 仍解锁（服务端 uiState）', async ({ page }) => {
    await enterProject(page)
    await lockButton(page).click()
    await expect(lockButton(page)).toHaveClass(/active/)
    await waitForServerLock(true, page)

    // reload 后 bootstrap 从 uiState 恢复锁定态：按钮 active + body 类 + 拖拽仍无效
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
    await page.waitForURL('**/project')
    await expect(lockButton(page)).toHaveClass(/active/, { timeout: 10000 })
    expect(await page.evaluate(() => document.body.classList.contains('sc-layout-locked'))).toBe(true)
    await dragSideResizer(page, -120)
    await page.waitForTimeout(400)
    await expect(page.locator('#side-panel')).toHaveAttribute('style', widthStyle(280))

    // 解锁→服务端落盘→reload 后仍解锁
    await lockButton(page).click()
    await expect(lockButton(page)).not.toHaveClass(/active/)
    await waitForServerLock(false, page)
    await page.reload()
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
    await page.waitForURL('**/project')
    await expect(lockButton(page)).not.toHaveClass(/active/, { timeout: 10000 })
    expect(await page.evaluate(() => document.body.classList.contains('sc-layout-locked'))).toBe(false)
  })
})
