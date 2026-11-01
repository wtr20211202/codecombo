import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端大粘贴阈值确认（P-20261002-136）E2E：
 *   1. >64KB 单行粘贴 → 体积感知弹层（标题「大文本粘贴确认」+「内容 70 KB / 1 行」
 *      文案、「不再提示」隐藏）→ 确认后内容入终端
 *   2. >64KB 粘贴取消 → 弹层关闭、终端无内容
 *   3. <64KB 单行粘贴 → 无弹层直接入终端（既有行为）
 *   4. <64KB 多行粘贴 → 既有「多行粘贴确认」弹层（无 KB 文案、「不再提示」在）
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）；
 *   剪贴板读写走 Chromium 权限授予（playwright.config 无 headless 剪贴板默认授权）
 */

// Chromium 剪贴板 API 需显式授予（share-rotate.spec.ts 同款）
test.use({ permissions: ['clipboard-read', 'clipboard-write'] })

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-paste-threshold'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-paste-threshold')
// 阈值常量在 useTerminalClipboard.PASTE_SIZE_WARN_BYTES（64*1024）：超阈值载荷取
// 70*1024 字节整 —— Math.round(70*1024/1024)=70，弹层文案「内容 70 KB / 1 行」可精确断言
const LARGE_KB = 70
const LARGE_MARKER = 'PASTE_LARGE_MARKER_X1'
const LARGE_TEXT = LARGE_MARKER + 'x'.repeat(LARGE_KB * 1024 - LARGE_MARKER.length)
const CANCEL_MARKER = 'PASTE_CANCEL_MARKER_X1'
const CANCEL_TEXT = CANCEL_MARKER + 'y'.repeat(LARGE_KB * 1024 - CANCEL_MARKER.length)
const SMALL_MARKER = 'PASTE_SMALL_OK_Z9'

let unlockToken = ''

async function api(method: string, url: string, body?: unknown) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': unlockToken },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { /* 非 JSON */ }
  return { status: res.status, json }
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''

  const stale = await api('GET', '/api/projects')
  const oldProj = ((stale.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (oldProj) await api('DELETE', `/api/projects/${oldProj.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  const list = await api('GET', '/api/projects')
  const mine = ((list.json?.data || []) as { id: string; name: string }[]).find(p => p.name === PROJ_NAME)
  if (mine) await api('DELETE', `/api/projects/${mine.id}`)
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* shell 占用时忽略 */ }
})

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 面板可能已由 uiState 恢复为展开态：此时再点 rail 会把它收起，需幂等处理
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  // 清 uiState 恢复的历史 tab
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  // 先前用例可能把底部面板留在 Git/控制台分区：归一化到终端分区再点新建
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

// 右键终端 → 菜单「粘贴」（pasteFromClipboard 链路：读剪贴板 → 阈值闸门）
async function pasteViaContextMenu(page: Page, xterm: ReturnType<Page['locator']>, text: string) {
  await page.evaluate((t) => navigator.clipboard.writeText(t), text)
  await xterm.click({ button: 'right' })
  const menu = page.locator('.term-context-menu')
  await expect(menu).toBeVisible()
  await menu.locator('.term-context-item').filter({ hasText: '粘贴' }).first().click()
}

test('>64KB 粘贴：体积感知弹层含 KB/行数，确认后入终端', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await pasteViaContextMenu(page, xterm, LARGE_TEXT)

  // 体积感知版：大文本标题 + 「内容 70 KB / 1 行」 + 「不再提示」隐藏（常量阈值无设置项）
  const dialog = page.locator('.n-dialog').filter({ hasText: '大文本粘贴确认' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('内容 70 KB / 1 行')
  await expect(dialog.locator('.n-checkbox')).toHaveCount(0)

  // 确认 → applyPaste：标记进终端输入行（载荷 70KB 仅断言首部标记，避全量渲染断言）
  await dialog.locator('.n-dialog__action button').filter({ hasText: '仍然粘贴' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(xterm).toContainText(LARGE_MARKER, { timeout: 20000 })
})

test('>64KB 粘贴：取消后终端无内容', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await pasteViaContextMenu(page, xterm, CANCEL_TEXT)

  const dialog = page.locator('.n-dialog').filter({ hasText: '大文本粘贴确认' })
  await expect(dialog).toBeVisible()
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
  // 等一拍终端渲染后仍无标记（取消 = 不落键）
  await page.waitForTimeout(1000)
  await expect(xterm).not.toContainText(CANCEL_MARKER)
})

test('<64KB 单行粘贴：无弹层直接入终端（既有行为）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await pasteViaContextMenu(page, xterm, SMALL_MARKER)

  // 先等粘贴生效（正向证据），再断言弹层从未出现
  await expect(xterm).toContainText(SMALL_MARKER, { timeout: 10000 })
  await expect(page.locator('.n-dialog')).toHaveCount(0)
})

test('<64KB 多行粘贴：既有「多行粘贴确认」弹层，无体积文案', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await pasteViaContextMenu(page, xterm, 'echo a1\necho b2')

  // 既有版：多行标题 + 行数文案 + 「不再提示」在（体积感知隐藏不泄漏到存量多行弹层）
  const dialog = page.locator('.n-dialog').filter({ hasText: '多行粘贴确认' })
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('剪贴板内容包含 2 行')
  await expect(dialog).not.toContainText('KB')
  await expect(dialog.locator('.n-checkbox')).toHaveCount(1)
  await dialog.locator('.n-dialog__action button').filter({ hasText: '取消' }).click()
  await expect(dialog).toHaveCount(0)
})
