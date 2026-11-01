import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 命令成败装饰与失败命令「交给 agent 修」（P-20261003-150）E2E：
 *   1. 失败命令（cmd /c "echo MARK & exit 7" / sh -c "echo MARK; exit 7" 按平台）
 *      → 红色装饰行（.sc-cmd-fail）出现
 *      → 右键「交给 agent 修」可用 → 点击后 create 请求体断言：kind=agent、
 *      dir=项目根、launchArgs 含失败询问头（命令 + exit 7）与输出标记行且
 *      ≤500 字节（服务端上限）
 *   2. 成功命令（echo）→ 绿色装饰行（.sc-cmd-ok）出现
 *   3. 新终端无失败记录 → 菜单项在位但置灰，点击不发起 create
 * 前置：服务端 shell（PowerShell / bash）shellint 产出 C/D/E 帧；自备临时
 * 空项目（终端对项目路径无 git 要求），afterEach 清理全部终端会话，afterAll
 * 清理项目与夹具
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-term-fix-agent'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-term-fix-agent')
const FIX_HEADER_PREFIX = '终端里这条命令执行失败'

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

/** 清理全部终端会话：agent 会话创建走同一会话表，残留会污染载荷断言 */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const unlockRes = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await unlockRes.json()) as { token?: string }).token || ''
  const res = await request.get(`${BASE}/api/terminals`, { headers: { 'X-Lock-Token': token } })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers: { 'X-Lock-Token': token } })
  }
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

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

/** 捕获 POST /api/terminals（创建会话）请求体：断言 launchArgs 即 prompt 内容 */
function watchAgentCreate(page: Page) {
  const payloads: { kind?: string; dir?: string; launchArgs?: string }[] = []
  page.on('request', (req) => {
    if (req.method() !== 'POST') return
    try {
      if (new URL(req.url()).pathname.endsWith('/api/terminals')) {
        payloads.push(req.postDataJSON() as { kind?: string; dir?: string; launchArgs?: string })
      }
    } catch { /* URL 解析失败非创建请求，忽略 */ }
  })
  return payloads
}

async function switchProject(page: Page, name: string) {
  await page.locator('.header-project-select').click()
  await page.locator('.n-base-select-option').filter({ hasText: name }).first().click()
}

async function openFreshTerminal(page: Page) {
  // 用 rail 按钮精确定位：底部面板展开时 DOM 里还有面板切换钮/新建终端钮，
  // getByRole('终端') 会命中多个元素（strict violation）
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
  // 先前用例可能把底部面板留在其他分区且经 uiState 持久化：归一化到终端分区
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('[data-testid="bottom-tab-terminal"]').click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows 默认 PowerShell；Linux bash 以 $/# 收尾
  await expect(xterm).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  return xterm
}

test('失败命令 → 红标 → 右键交给 agent 修 → launchArgs 含命令与输出', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  const payloads = watchAgentCreate(page)

  // 失败命令：原生 exe 失败设 LASTEXITCODE（cmdlet 失败语义不同，见 shellint ps1）；
  // Linux 以 sh -c 退出 7 等价构造。输出唯一标记行供 prompt 断言
  const marker = `SC-FIX-OUT-${Date.now()}`
  const FAIL_CMD = serverIsLinux
    ? `sh -c "echo ${marker}; exit 7"`
    : `cmd /c "echo ${marker} & exit 7"`
  await xterm.click()
  await page.keyboard.type(FAIL_CMD + '\r')
  await expect(xterm).toContainText(marker, { timeout: 10000 })

  // 红色装饰行（D 帧退出码 × C/D 行号记账区间的 DOM 覆盖层）出现
  const failMark = page.locator('.xterm:visible').last().locator('.xterm-decoration.sc-cmd-fail')
  await expect(failMark.first()).toBeVisible({ timeout: 10000 })

  // 右键 → 「交给 agent 修」可用（失败记录在账）→ 点击发起
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const fixItem = ctxMenu.locator('[data-testid="term-fix-with-agent"]')
  await expect(fixItem).toBeVisible()
  await expect(fixItem).toContainText('交给 agent 修')
  await expect(fixItem, '有失败记录 → 菜单项可用').toBeEnabled()
  await fixItem.click()
  await expect(ctxMenu).toHaveCount(0)

  // create 请求体：kind=agent、dir=项目根、launchArgs = 失败询问头（命令 + exit）
  // + 输出标记行，且 ≤500 字节（服务端按字节计上限）
  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind, '全局 agent 会话').toBe('agent')
  expect(body.dir, '会话工作目录 = 项目根').toBe(serverPath(REPO_DIR))
  const prompt = body.launchArgs || ''
  expect(prompt, 'prompt 以失败询问头开头').toContain(FIX_HEADER_PREFIX)
  expect(prompt, '命令文本注入 prompt').toContain(FAIL_CMD)
  expect(prompt, '退出码注入 prompt').toContain('exit 7')
  expect(prompt, '失败输出尾部注入 prompt').toContain(marker)
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(500)

  // docked 管理页出现且创建的会话处于激活态（ask 链既有语义）
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  await expect(view.locator('.ats-item.active')).toHaveCount(1, { timeout: 15000 })
})

test('成功命令 → 绿色装饰行出现', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  const marker = `SC-FIX-OK-${Date.now()}`
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
  await expect(xterm).toContainText(marker, { timeout: 10000 })

  const okMark = page.locator('.xterm:visible').last().locator('.xterm-decoration.sc-cmd-ok')
  await expect(okMark.first()).toBeVisible({ timeout: 10000 })
})

test('新终端无失败记录：菜单项置灰，点击不发起 create', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  const payloads = watchAgentCreate(page)

  await xterm.click()
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const fixItem = ctxMenu.locator('[data-testid="term-fix-with-agent"]')
  await expect(fixItem, '菜单项在位（对照：非隐藏而是置灰）').toBeVisible()
  await expect(fixItem, '无失败记录 → 菜单项置灰').toBeDisabled()
  await page.mouse.click(5, 5)
  await expect(ctxMenu).toHaveCount(0)
  await page.waitForTimeout(800)
  expect(payloads, '置灰路径不发起 create').toHaveLength(0)
})

test('重挂恢复：整页重载后重放段重建红标，「交给 agent 修」仍可发起', async ({ page }) => {
  // P-20261006-37：pane 卸载只清装饰引用，失败记录留至会话真死；重挂 attach
  // 服务端重放 scrollback，重放段 D 事件只收集 exitCode/command（ConPTY 重放
  // 是重绘流、光标记账不可信），R 哨兵后在稳定 buffer 上按命令文本重锚注册
  // 红标+失败记录——多会话切换重度使用下装饰与修复入口不再断崖。
  // 整页重载 = 全部 pane 卸载重挂（比切 tab 的 v-show 保活更彻底）
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)
  const payloads = watchAgentCreate(page)

  const marker = `SC-FIX-REMOUNT-${Date.now()}`
  const FAIL_CMD = serverIsLinux
    ? `sh -c "echo ${marker}; exit 7"`
    : `cmd /c "echo ${marker} & exit 7"`
  await xterm.click()
  await page.keyboard.type(FAIL_CMD + '\r')
  await expect(xterm).toContainText(marker, { timeout: 10000 })
  const failMark = page.locator('.xterm:visible').last().locator('.xterm-decoration.sc-cmd-fail')
  await expect(failMark.first()).toBeVisible({ timeout: 10000 })

  await page.reload()
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  // 面板开合随 uiState 恢复，收敛到可见基线（toggle 语义，勿盲点）
  const panel = page.locator('.bottom-panel')
  if (!(await panel.isVisible().catch(() => false))) {
    await page.locator('.rail-btn[title="终端"]').click()
  }
  await expect(panel).toBeVisible({ timeout: 5000 })
  // 本项目唯一会话（beforeEach 清场 + 本用例只建这一个）随 tab 列表恢复
  const remounted = page.locator('.xterm:visible').last()
  await expect(remounted).toBeVisible({ timeout: 20000 })
  await expect(remounted).toContainText(serverIsLinux ? /[#$] / : 'PS ', { timeout: 20000 })
  await expect(remounted, '重放段内容在新 buffer 上屏').toContainText(marker, { timeout: 20000 })

  const restoredMark = remounted.locator('.xterm-decoration.sc-cmd-fail')
  await expect(restoredMark.first(), '红标随重放段 D 帧重建').toBeVisible({ timeout: 20000 })

  await remounted.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  const fixItem = ctxMenu.locator('[data-testid="term-fix-with-agent"]')
  await expect(fixItem, '失败记录在账 → 菜单项可用').toBeEnabled()
  await fixItem.click()
  await expect(ctxMenu).toHaveCount(0)

  await expect.poll(() => payloads.length, { timeout: 15000 }).toBe(1)
  const body = payloads[0]!
  expect(body.kind).toBe('agent')
  expect(body.launchArgs || '', '失败输出尾部按重放记录的新 buffer 行号读出').toContain(marker)
})
