import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端「复制上一条命令输出」（P-20261002-56）E2E：
 *   1. 新终端未跑命令 → 右键菜单项在位 → 点击提示「没有可复制的命令输出」
 *   2. 跑一条 echo → 右键「复制上一条命令输出」→ 剪贴板内容 = 输出文本
 *      （OSC 133 C/D 行号记账区间提取：C 记账已按 shell 时序归一为输出首行，D 记账为输出末行）
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-copy-last'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-copy-last')

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
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
  // Linux bash 提示符以 $（普通用户）或 #（root，如 WSL 实例）收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

test('新终端未跑命令：菜单项在位，点击提示无可复制输出', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 右键打开 pane 菜单：新菜单项在位（OSC 133 无 C 记账 → 不禁用、点击后提示）
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const item = ctxMenu.locator('[data-testid="term-copy-last-output"]')
  await expect(item).toBeVisible()
  await expect(item).toContainText('复制上一条命令输出')

  // 无命令记账：点击后 toast 提示而非写剪贴板
  await item.click()
  await expect(ctxMenu).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '没有可复制的命令输出' })).toBeVisible({ timeout: 5000 })
})

test('echo 后复制上一条命令输出：剪贴板 = 输出文本', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 跑一条 echo：输出唯一标记（同 run 内唯一，断言等值不受历史轮次污染）
  const marker = `SC-E2E-COPY-LAST-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })
  // 等 D 帧（下个 prompt 渲染时发出）处理入账——与输出同一 WS 流，1s 富余
  await page.waitForTimeout(1000)

  // 右键 → 复制上一条命令输出
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  await ctxMenu.locator('[data-testid="term-copy-last-output"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible({ timeout: 5000 })

  // 剪贴板内容断言 = 输出文本（区间提取恰好覆盖 echo 输出行，不含提示符行）
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip).toBe(marker)
})
