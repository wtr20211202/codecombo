import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 片段面板快捷键（P-20261003-43）E2E——Ctrl+Shift+J 与历史 Ctrl+Shift+H 对称：
 *   ① Ctrl+Shift+J 开片段面板；再按关闭（开关切换）
 *   ② 互斥展开（开此关彼）：Ctrl+Shift+H 先开历史 → Ctrl+Shift+J 开片段且历史关闭
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）
 */

const BASE = API_BASE
const PROJ_NAME = 'e2e-snippet-shortcut'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-snippet-shortcut')

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
  // 注册路径按服务端形态交接（linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
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
  // 用 rail 按钮精确定位：底部面板展开时 DOM 里还有面板切换钮/新建终端钮，
  // getByRole('终端') 会命中多个元素（strict violation）。
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
  // 项目切换的异步布局应用可能在上面的步骤之间把面板收起（新项目无持久化
  // 布局，apply 默认收起）：点新建前重验一次，收起则重开（幂等）
  await ensureOpen()
  // 先前用例可能把底部面板留在 Git/控制台分区且经 uiState 持久化（服务端
  // 状态跨 spec 存活）：面板开着 ≠ 终端分区，归一化到终端分区再点新建
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 聚焦终端（keydown 经 xterm helper textarea 冒泡到 document 快捷键 handler）
  await xterm.click()
  return xterm
}

test('Ctrl+Shift+J 开片段面板，再按关闭', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await openFreshTerminal(page)

  // 基线：两面板均关
  await expect(page.locator('.snippet-panel')).toHaveCount(0)
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // Ctrl+Shift+J：片段面板开（历史保持关）
  await page.keyboard.press('Control+Shift+j')
  await expect(page.locator('.snippet-panel')).toBeVisible()
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // 再按：片段面板关
  await page.keyboard.press('Control+Shift+j')
  await expect(page.locator('.snippet-panel')).toHaveCount(0)
})

test('互斥展开：Ctrl+Shift+H 开历史后 Ctrl+Shift+J 开片段且历史关闭', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await openFreshTerminal(page)

  // Ctrl+Shift+H 先开历史（对称锚的既有行为）
  await page.keyboard.press('Control+Shift+h')
  await expect(page.locator('.history-panel')).toBeVisible()

  // Ctrl+Shift+J：片段开、历史关（开此关彼，与工具条按钮互斥语义一致）
  await page.keyboard.press('Control+Shift+j')
  await expect(page.locator('.snippet-panel')).toBeVisible()
  await expect(page.locator('.history-panel')).toHaveCount(0)

  // 再按 J：片段关闭，历史不被误开
  await page.keyboard.press('Control+Shift+j')
  await expect(page.locator('.snippet-panel')).toHaveCount(0)
  await expect(page.locator('.history-panel')).toHaveCount(0)
})
