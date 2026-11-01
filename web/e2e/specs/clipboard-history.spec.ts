import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 多剪贴板粘贴 E2E（P-20261002-149，Ctrl+Alt+V 呼出——JetBrains 原键
 * Ctrl+Shift+V 已被端口预览面板占用，默认退避 Ctrl+Alt+V）：
 *   1. 应用内复制两段（tab 右键「复制路径 / 复制文件名」，走 copyText 挂钩入史，
 *      同 tab-copy-path 先例）→ Ctrl+Alt+V 弹层两行（MRU 在前）→ 选第一条 →
 *      光标处插入 + 弹层关闭
 *   2. 历史选中写回系统剪贴板（JetBrains 同语义）+ 重复选取经 MRU 去重不产生
 *      重复条目
 * 注：原生 Ctrl+C（document copy 事件捕获链）在 headless Monaco EditContext 下
 * 不可靠（实测复制到 "\r\n" 占位），事件链由单测覆盖（dispatchCopy 合成事件），
 * 本 spec 走 copyText 按钮链覆盖「捕获→入史→弹层→写回→插入」全链。
 * 自备临时仓库，afterAll 清理（项目/仓库/ui-state）。
 */

const REPO_DIR = path.join(os.tmpdir(), 'sc-e2e-clip-history')
const PROJ = 'e2e-clip-history'
const SUB = 'sub'
const REL = 'sub/clip-history.txt'
const NAME = 'clip-history.txt'
const BODY = 'placeholder-body'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(API_BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json().catch(() => null)
  return { status: res.status, json }
}

async function registerProject(): Promise<void> {
  const res = await api('POST', '/api/projects', { name: PROJ, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(res.status)
}

async function cleanupProject(): Promise<void> {
  const list = await api('GET', '/api/projects')
  for (const p of ((list.json?.data || []) as { id: string; name: string }[])) {
    if (p.name === PROJ) await api('DELETE', `/api/projects/${p.id}`)
  }
}

async function cleanupRepo(): Promise<void> {
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
}

async function registerProjectAndSeed(): Promise<void> {
  const unlockRes = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = ((await unlockRes.json()) as { token?: string }).token || ''

  await cleanupProject()
  await cleanupRepo()
  fs.mkdirSync(path.dirname(path.join(REPO_DIR, REL)), { recursive: true })
  execFileSync('git', ['init'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.name', 'e2e'], { cwd: REPO_DIR })
  execFileSync('git', ['config', 'user.email', 'e2e@test.local'], { cwd: REPO_DIR })
  fs.writeFileSync(path.join(REPO_DIR, REL), `${BODY}\n`)
  execFileSync('git', ['add', '.'], { cwd: REPO_DIR })
  execFileSync('git', ['commit', '-m', 'root: 多剪贴板粘贴夹具'], { cwd: REPO_DIR })
  await registerProject()
}

/** 打开项目并进入编辑器（光标落在正文，粘贴落点） */
async function openProjectAndFile(page: Page): Promise<void> {
  await fixedLocale(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').filter({ hasText: PROJ }).first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.file-tree .item-name', { hasText: SUB }).first().isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-files"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.file-tree .item-name', { hasText: SUB }).first().click()
  await page.locator('.file-tree .item-name', { hasText: NAME }).first().click()
  await expect(page.locator('.editor-tab', { hasText: NAME })).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(BODY, { timeout: 8000 })
  await page.locator('.monaco-editor .view-lines').first().click()
}

/** tab 右键 → 点复制菜单项（copyText 挂钩链入史；同 tab-copy-path 交互） */
async function copyViaTabMenu(page: Page, itemName: string): Promise<void> {
  await page.locator('.editor-tab', { hasText: NAME }).click({ button: 'right' })
  await page.getByRole('menuitem', { name: itemName }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制' }).first()).toBeVisible({ timeout: 5000 })
}

/** 光标落文档头（1:1）：粘贴落点确定，断言「插入段+原文」拼接形态 */
async function focusEditorAtDocStart(page: Page): Promise<void> {
  await page.locator('.monaco-editor .view-lines').first().click()
  await page.keyboard.press('Control+Home')
}

/** 呼出剪贴板历史弹层（返回条目 locator） */
async function openHistoryPopover(page: Page): Promise<ReturnType<Page['locator']>> {
  await page.keyboard.press('Control+Alt+v')
  await expect(page.locator('[data-testid="clip-history-modal"]')).toBeVisible({ timeout: 5000 })
  return page.locator('[data-testid="clip-history-item"]')
}

test.beforeAll(async () => {
  await registerProjectAndSeed()
})

test.afterAll(async () => {
  await cleanupProject()
  await cleanupRepo()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: JSON.stringify({ local: null }),
  })
})

test('复制两段 → Ctrl+Alt+V 弹层两行 → 选第一条插入光标处', async ({ page }) => {
  await openProjectAndFile(page)

  // 复制两段（复制路径先、复制文件名后——最新在前）
  await copyViaTabMenu(page, '复制路径')
  await copyViaTabMenu(page, '复制文件名')
  await focusEditorAtDocStart(page)

  const items = await openHistoryPopover(page)
  await expect(items).toHaveCount(2)
  await expect(items.nth(0)).toContainText(NAME)
  await expect(items.nth(1)).toContainText(REL)

  // 选第一条 → 弹层关闭 + 光标处插入（1:1 落点：插入段在原文前）
  await items.nth(0).click()
  await expect(page.locator('[data-testid="clip-history-modal"]')).toBeHidden({ timeout: 5000 })
  await expect(page.locator('.monaco-editor .view-lines').first()).toContainText(`${NAME}${BODY}`, { timeout: 5000 })
})

test('历史选中写回系统剪贴板，重复选取不产生重复条目（MRU 去重）', async ({ page }) => {
  await openProjectAndFile(page)
  await copyViaTabMenu(page, '复制路径')
  await focusEditorAtDocStart(page)

  // 弹层选取唯一条目 → 写回系统剪贴板（JetBrains 同语义）
  const items = await openHistoryPopover(page)
  await expect(items).toHaveCount(1)
  await items.nth(0).click()
  await expect(page.locator('[data-testid="clip-history-modal"]')).toBeHidden({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(REL)

  // 选取动作经 copyText 写剪贴板再次入史：同一文本 MRU 去重 → 重开仍 1 条
  const items2 = await openHistoryPopover(page)
  await expect(items2).toHaveCount(1)
  await expect(items2.nth(0)).toContainText(REL)
  await page.keyboard.press('Escape')
})

// 敏感项遮蔽（P-20261005-14，遮蔽家族第三面）：token 形态串入史后弹层默认打码
// （弱边框 + 尾 4 形态），逐条「显示」揭示，重开回打码；打码态点选取用的仍是
// 原文——遮蔽只挡眼睛不挡数据流
test('敏感条目默认打码 → 点显示揭示 → 重开回打码 → 打码态选取拿原文', async ({ page }) => {
  await openProjectAndFile(page)

  // token 形态串入史：页面内合成选区 + execCommand 复制走真实 copy 事件捕获链
  //（headless Monaco EditContext 原生复制不可靠，spec 头注同款规避；ghp_ 前缀
  // + ≥12 值体命中 sensitiveMask ④ 已知前缀模式）
  const TOKEN = 'export KUBE_TOKEN=ghp_Zk9xQmN4vR7wY2bL'
  await page.evaluate((t) => {
    const div = document.createElement('div')
    div.contentEditable = 'true'
    div.textContent = t
    div.style.position = 'fixed'
    div.style.opacity = '0'
    document.body.appendChild(div)
    const range = document.createRange()
    range.selectNodeContents(div)
    const sel = window.getSelection()
    sel!.removeAllRanges()
    sel!.addRange(range)
    document.execCommand('copy')
    div.remove()
  }, TOKEN)
  await focusEditorAtDocStart(page)

  // 弹层默认打码：显示面是「ghp_***尾4」，值体不可见 + 弱边框 + 揭示钮
  const items = await openHistoryPopover(page)
  await expect(items).toHaveCount(1)
  await expect(items.nth(0)).toContainText('ghp_***Y2bL')
  await expect(items.nth(0)).not.toContainText('Zk9xQmN4vR7wY2bL')
  await expect(items.nth(0)).toHaveClass(/clip-history-item-sensitive/)
  const reveal = items.nth(0).locator('[data-testid="clip-history-reveal"]')
  await expect(reveal).toHaveText('显示')

  // 点显示 → 原文可见（仅本条，眼睛通道解锁）
  await reveal.click()
  await expect(items.nth(0)).toContainText(TOKEN)

  // 重开弹层 → 回打码（揭示是会话级，不跨弹层开关）
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="clip-history-modal"]')).toBeHidden({ timeout: 5000 })
  const items2 = await openHistoryPopover(page)
  await expect(items2).toHaveCount(1)
  await expect(items2.nth(0)).toContainText('ghp_***Y2bL')
  await expect(items2.nth(0)).not.toContainText('Zk9xQmN4vR7wY2bL')

  // 打码态点选 → 系统剪贴板拿到完整原文（数据流不受遮蔽影响）
  await items2.nth(0).click()
  await expect(page.locator('[data-testid="clip-history-modal"]')).toBeHidden({ timeout: 5000 })
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(TOKEN)
})
