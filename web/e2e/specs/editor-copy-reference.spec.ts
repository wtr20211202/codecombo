import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 「复制引用（路径:行）」E2E（P-20261006-17）：「路径:行」直达生态的产出侧——
 *   ① 编辑器右键复制引用：光标行拼项目相对路径（与 Quick Open 行号直达语法
 *     严格一致），闭环断言「复制 → 粘进 palette → 直达同文件同行」
 *   ② tab 右键复制引用（非活动 tab）：viewState 快照的最后已知光标行
 *     （P-20261002-11 切 tab 恢复数据同源）
 *   ③ 无光标态降级纯路径：binary 元信息卡内容从未打开过（Monaco 不挂载），
 *     复制结果无 :行号 后缀（缺行号仍是 palette 合法输入）
 * 与既有 copy-path 并存不替换（纯路径项回归由 tab-copy-path.spec 守）。
 * 自备临时仓库，afterAll 清理并复位 uiState。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-copy-reference')
const PROJ = 'e2e-copy-reference'
// 120 行 fixture：锚点行 80（首屏渲染不到，palette 直达后 revealLineInCenter 才可见）
const REF_FILE = 'ref-target.txt'
const ANCHOR_LINE = 80
const ANCHOR = `sc-ref-anchor-${ANCHOR_LINE}`
// 20 行 fixture：光标定位到中部行（第 12 行）验证 viewState 行取
const OTHER_FILE = 'other.txt'
const OTHER_LINES = Array.from({ length: 20 }, (_, i) => `line${i + 1} content`)
// binary 扩展名（filepolicy 清单命中）：元信息卡呈现，无光标态
const BINARY_FILE = 'logo.png'

function refContent(): string {
  const lines: string[] = []
  for (let i = 1; i <= 120; i++) {
    lines.push(i === ANCHOR_LINE ? `// ${ANCHOR}` : `// pad line ${i}`)
  }
  return lines.join('\n') + '\n'
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
  fs.writeFileSync(path.join(REPO_DIR, REF_FILE), refContent())
  fs.writeFileSync(path.join(REPO_DIR, OTHER_FILE), OTHER_LINES.join('\n') + '\n')
  fs.writeFileSync(path.join(REPO_DIR, BINARY_FILE), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  git(REPO_DIR, ['add', '.'])
  git(REPO_DIR, ['commit', '-m', 'root: 复制引用基线'])
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

/** 进项目并从文件树打开指定文件（编辑器就绪口径同 editor-cursor-position） */
async function openFileInEditor(page: import('@playwright/test').Page, file: string, sample: string) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  await ensureTreeFileVisible(page, file)
  await page.locator('.file-tree .item-name', { hasText: file }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(sample, { timeout: 8000 })
}

/** 树条目可见性保障（rail 未展开/树加载窗口的可见性 flake 防护）：rail-files
 *  轮询点开侧栏至条目可见，随后调用方再 click */
async function ensureTreeFileVisible(page: import('@playwright/test').Page, file: string) {
  const item = page.locator('.file-tree .item-name', { hasText: file }).first()
  for (let i = 0; i < 5; i++) {
    if (await item.isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(800)
  }
  await expect(item).toBeVisible({ timeout: 5000 })
}

/** 光标定位到锚点行：位置徽标点击弹 Monaco 内建 gotoLine quick access（同入口
 *  Ctrl+G），输入行号回车跳转——断言徽标落位（行号来源的事实源）。quick access
 *  输入按 `:<行号>` 形态解析（Monaco goto 系 quick access 的行前缀惯例） */
async function moveCursorToLine(page: import('@playwright/test').Page, line: number) {
  const badge = page.locator('[data-testid="cursor-pos-badge"]')
  await badge.click()
  const quickInput = page.locator('.quick-input-widget')
  await expect(quickInput).toBeVisible()
  await quickInput.locator('input').fill(`:${line}`)
  await page.keyboard.press('Enter')
  await expect(quickInput).not.toBeVisible()
  await expect(badge).toContainText(`Ln ${line}`)
  // 等跳行后的虚拟化渲染收敛：紧随其后的右键若撞上 view-lines 重建窗口，
  // 右键菜单项的事件面会落在被重建掉的节点上（实测点击后动作不触发菜单不关）
  await page.waitForTimeout(500)
}

/** 编辑器右键落点 = 锚点行本体（跳行 revealLineInCenter 后锚点行居视口中部，
 *  避开滚动态下视口顶部 scroll-decoration 阴影/裁剪拦截指针事件的区域；右键落
 *  点与断言行一致——Monaco 右键会把光标移到点击行（VS Code 同款行为），动作
 *  读到的「光标行」即右键落点行）。菜单项按 role=menuitem 点内层锚，点击前等
 *  300ms——Monaco 菜单 item 的 mouseup 激活监听是渲染后 100ms RunOnceScheduler
 *  延迟挂的（menu.js "Add mouse up listener later to avoid accidental clicks"），
 *  右键后立刻点会落进无监听窗口成为 no-op（实测复现）。剪贴板写入是 click 处
 *  理器里的异步链（copyText→writeText），toast 出现即写入已定案，先等 toast 再
 *  读防竞态读空 */
async function copyViaEditorContextMenu(page: import('@playwright/test').Page, anchorText: string): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.monaco-editor .view-line', { hasText: anchorText }).click({ button: 'right', timeout: 15000 })
  await page.waitForTimeout(300)
  const item = page.getByRole('menuitem', { name: '复制引用（路径:行）' })
  await item.click()
  await expect(page.locator('.n-message').filter({ hasText: '引用已复制' })).toBeVisible({ timeout: 5000 })
  return page.evaluate(() => navigator.clipboard.readText())
}

/** tab 右键 → 点「复制引用」菜单项 → 剪贴板读回（tab-copy-path 同款定位+同防竞态；
 *  自绘 HTML 菜单无 Monaco 的监听延迟挂载问题，无需预等待） */
async function copyViaTabContextMenu(page: import('@playwright/test').Page, tabName: string): Promise<string> {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.locator('.editor-tab', { hasText: tabName }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: '复制引用（路径:行）' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '引用已复制' })).toBeVisible({ timeout: 5000 })
  return page.evaluate(() => navigator.clipboard.readText())
}

test('编辑器右键复制引用 → 粘贴 palette → 直达同文件同行（闭环）', async ({ page }) => {
  await openFileInEditor(page, REF_FILE, 'pad line 1')
  const badge = page.locator('[data-testid="cursor-pos-badge"]')

  // 光标落到锚点行 80（首屏外），右键锚点行本体复制引用——Monaco 右键移光标
  // 到落点行（VS Code 同款），动作读到的光标行即锚点行（成功 toast 在助手内等待）
  await moveCursorToLine(page, ANCHOR_LINE)
  const copied = await copyViaEditorContextMenu(page, ANCHOR)
  expect(copied).toBe(`${REF_FILE}:${ANCHOR_LINE}`)

  // 光标先归位 1:1 再粘贴：直达后徽标回到锚点行才证明 palette 行语义生效
  await page.locator('.monaco-editor').first().click()
  await page.keyboard.press('Control+Home')
  await expect(badge).toContainText('Ln 1')

  // 粘贴复制的引用进 Quick Open：命中条目带去向行提示
  await page.keyboard.press('Control+p')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill(copied)
  const item = page.locator('.palette-item', { hasText: REF_FILE })
  await expect(item).toBeVisible()
  await expect(item.locator('.palette-item-linehint')).toHaveText(`→ 第 ${ANCHOR_LINE} 行`)

  await page.keyboard.press('Enter')
  await expect(page.locator('.palette-card')).toHaveCount(0)
  // 直达同文件同行：锚点行随 revealLineInCenter 渲染 + 徽标落锚点行
  await expect(page.locator('.monaco-editor .view-lines')).toContainText(ANCHOR, { timeout: 15000 })
  await expect(badge).toContainText(`Ln ${ANCHOR_LINE}`)
})

test('tab 右键复制引用（非活动 tab）：viewState 最后已知光标行', async ({ page }) => {
  await openFileInEditor(page, OTHER_FILE, 'line1 content')
  const badge = page.locator('[data-testid="cursor-pos-badge"]')

  // other.txt 光标落第 12 行，随后切走（快照按切 tab 恢复同源链落桶）
  await page.locator('.monaco-editor .view-lines .view-line').nth(11).click()
  await page.keyboard.press('Home')
  await expect(badge).toHaveText('Ln 12, Col 1')

  await ensureTreeFileVisible(page, REF_FILE)
  await page.locator('.file-tree .item-name', { hasText: REF_FILE }).first().click()
  await expect(page.locator('.monaco-editor .view-lines')).toContainText('pad line 1', { timeout: 8000 })

  // 非活动 tab 右键复制引用：行号来自 viewState 快照（该 tab 编辑器未挂载）
  expect(await copyViaTabContextMenu(page, OTHER_FILE)).toBe(`${OTHER_FILE}:12`)
})

test('无光标态降级纯路径：binary 元信息卡内容未打开过，复制无行号后缀', async ({ page }) => {
  await openFileInEditor(page, OTHER_FILE, 'line1 content')
  // binary 文件（.png 命中 filepolicy 清单）开成元信息卡，Monaco 不挂载
  await ensureTreeFileVisible(page, BINARY_FILE)
  await page.locator('.file-tree .item-name', { hasText: BINARY_FILE }).first().click()
  await expect(page.locator('.file-meta-card')).toBeVisible({ timeout: 8000 })

  expect(await copyViaTabContextMenu(page, BINARY_FILE)).toBe(BINARY_FILE)
})
