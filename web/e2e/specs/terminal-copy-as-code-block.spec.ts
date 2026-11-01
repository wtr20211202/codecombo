import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 终端选区「复制为代码块」（P-20261003-270）E2E：
 *   1. 无选区右键 → 菜单项在位但置灰（与「复制」同一 selectionLength 门禁）
 *   2. echo 输出唯一标记行 → 鼠标拖选该行 → 右键「复制为代码块」→ 剪贴板 =
 *      ```bash 围栏 + `$ <最近命令>` 命令行头 + 选中输出；先写哨兵值再点，证明
 *      内容来自菜单动作而非 copy-on-select 的既有写入
 *   3. 纯文本「复制」与代码块入口并存：同一选区右键点「复制」→ 剪贴板仍为
 *      选区原文（无围栏/无命令头），既有复制族行为保真
 * 选区口径与 terminal-ask-selection 同款（xterm 真实鼠标拖选，DOM renderer
 * 行内 Range 定位）；markerRect 取最后一条匹配行 = 输出行（命令回显行也含
 * 同一标记，取首条会选中命令行而不是输出）。
 * 自备临时空项目（终端对项目路径无 git 要求），afterAll 清理项目与夹具。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-copy-code-block'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-copy-code-block')

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

/** marker 文本最后一条屏上行矩形（DOM renderer 行内 Range 定位）。命令回显行
 *  与输出行都含 marker，取最后一条 = 输出行；轮询至出现 */
async function waitForMarkerRect(page: Page, marker: string, timeout = 10000): Promise<{ left: number; right: number; centerY: number }> {
  const deadline = Date.now() + timeout
  for (;;) {
    const rect = await markerRect(page, marker)
    if (rect) return rect
    if (Date.now() > deadline) throw new Error(`viewport 中找不到输出标记行: ${marker}`)
    await page.waitForTimeout(200)
  }
}

function markerRect(page: Page, marker: string): Promise<{ left: number; right: number; centerY: number } | null> {
  return page.evaluate((n) => {
    let hit: { left: number; right: number; centerY: number } | null = null
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div')) as HTMLElement[]
    for (const row of rows) {
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const t = node.textContent || ''
        const i = t.indexOf(n)
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(node, i)
        range.setEnd(node, i + n.length)
        const rect = range.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) {
          hit = { left: rect.left, right: rect.right, centerY: rect.top + rect.height / 2 }
        }
      }
    }
    return hit
  }, marker)
}

/** 拖选 marker 输出行（起止点收进首/尾字符单元格内，同 terminal-ask-selection 口径） */
async function selectMarkerLine(page: Page, marker: string) {
  const rect = await waitForMarkerRect(page, marker)
  await page.mouse.move(rect.left + 3, rect.centerY)
  await page.mouse.down()
  await page.mouse.move(rect.right + 3, rect.centerY, { steps: 5 })
  await page.mouse.up()
}

test('无选区：复制为代码块菜单项在位但置灰', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const item = ctxMenu.locator('[data-testid="term-copy-as-code-block"]')
  await expect(item, '菜单项在位（对照：非隐藏而是置灰）').toBeVisible()
  await expect(item).toContainText('复制为代码块')
  await expect(item, '无选区 → 与「复制」同一门禁置灰').toBeDisabled()
  await page.keyboard.press('Escape')
  await expect(ctxMenu).toHaveCount(0)
})

test('选中输出 → 复制为代码块：剪贴板含 ```bash 围栏与命令行头', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 跑一条 echo：输出唯一标记（同 run 内唯一，断言不受历史轮次污染）
  const marker = `SC-E2E-CODEBLOCK-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })
  // 等 D 帧（下个 prompt 渲染时发出）处理入账——命令行头取自 E 帧命令文本
  await page.waitForTimeout(1000)

  await selectMarkerLine(page, marker)
  // 哨兵值：拖选触发的 copy-on-select 已写入选区原文，先覆盖再点菜单，
  // 证明最终内容确实来自「复制为代码块」动作
  await page.evaluate(() => navigator.clipboard.writeText('SC-E2E-SENTINEL'))

  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const item = ctxMenu.locator('[data-testid="term-copy-as-code-block"]')
  await expect(item, '有选区 → 菜单项可用').toBeEnabled()
  await item.click()
  await expect(ctxMenu).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible({ timeout: 5000 })

  // Windows 剪贴板层会把 writeText 的 LF 归一为 CRLF（OS 剪贴板惯例，跨平台实现
  // 正确性不依赖行尾形态）；断言前归一，Linux/mac 实例同样成立
  const clip = (await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n')
  expect(clip, '```bash 围栏开头').toMatch(/^```bash\n/)
  expect(clip, '命令行头 = 最近一条命令（$ 前缀）').toContain(`$ echo ${marker}`)
  expect(clip, '选中输出在围栏内').toContain(marker)
  expect(clip, '闭合围栏收尾').toMatch(/\n```$/)
  expect(clip).not.toContain('SC-E2E-SENTINEL')
})

test('纯文本「复制」与代码块入口并存：剪贴板仍为选区原文', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  const marker = `SC-E2E-PLAINCOPY-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })
  await page.waitForTimeout(1000)

  await selectMarkerLine(page, marker)
  await page.evaluate(() => navigator.clipboard.writeText('SC-E2E-SENTINEL'))

  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  await ctxMenu.locator('[data-testid="term-copy"]').click()
  await expect(ctxMenu).toHaveCount(0)
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible({ timeout: 5000 })

  // 既有纯文本复制语义保真：原样选区、无围栏/无命令头（尾随定宽空格由 trimEnd 归一）
  const clip = await page.evaluate(() => navigator.clipboard.readText())
  expect(clip.trimEnd()).toBe(marker)
  expect(clip).not.toContain('```')
  expect(clip).not.toContain(`$ echo ${marker}`)
})
