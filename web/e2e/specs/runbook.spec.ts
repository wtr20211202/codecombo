import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 运行书（P-20261003-24）E2E：
 *   1. 面板内联新建 3 步运行书 → API 落库复核（步骤数组序即执行序）
 *   2. 逐步「发送」到当前终端：命令文本出现在输入行但不执行——echo 标记在
 *      xterm 行内仅出现 1 处（输入行）；若被自动回车执行会有输出行第 2 处。
 *      每步发送后 Ctrl+C 清掉输入行残留（PowerShell/bash 同义：废弃当前行
 *      不执行），保证下一步标记仍独占一行、断言不被换行截断。发送即自动
 *      勾选完成 + 重置勾选 + 手动勾选
 *   3. 命令面板「运行书」入口：打开底部终端分区并展开面板
 * 前置（spec 内自备）：临时空项目（终端对项目路径无 git 要求）。
 * 用例 2/3 开头经 API 幂等播种运行书——Playwright 重试会重跑 beforeAll
 * （其清理会删掉用例 1 建的运行书），重试路径必须自愈
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-runbook'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-runbook')
// 三步命令全部用 echo（误执行无副作用）；标记串在断言里做「未自动回车」计数
const BOOK_TITLE = 'e2e 运行书三连'
const STEP_CMDS = ['echo sc-rb-step1', 'echo sc-rb-step2', 'echo sc-rb-step3']
const STEP_DESCS = ['第一步说明', '', '第三步说明']

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

async function cleanupRunbooks(): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  for (const b of ((list.json?.data || []) as { id: string; title: string }[])) {
    if (b.title === BOOK_TITLE) await api('DELETE', `/api/runbooks/${b.id}`)
  }
}

/** 幂等播种：同名运行书在位即复用，缺失（含重试路径 beforeAll 清理后）经 API 补建 */
async function ensureRunbook(): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { id: string; title: string }[]).find(b => b.title === BOOK_TITLE)
  if (mine) return
  const res = await api('POST', '/api/runbooks', {
    title: BOOK_TITLE,
    description: 'e2e 夹具说明',
    steps: STEP_CMDS.map((command, i) => ({ command, description: STEP_DESCS[i] || undefined })),
  })
  expect([200, 201]).toContain(res.status)
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
  await cleanupRunbooks()
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }) } catch { /* 上轮残留 */ }
  fs.mkdirSync(REPO_DIR, { recursive: true })
  // 注册路径按服务端形态交接（linux 实例经 /mnt/d 同见仓库 .sc-tmp 夹具）
  const proj = await api('POST', '/api/projects', { name: PROJ_NAME, path: serverPath(REPO_DIR) })
  expect([200, 201]).toContain(proj.status)
})

test.afterAll(async () => {
  await cleanupRunbooks()
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
    // 项目切换的异步布局应用可能在点击后把面板收起（持久化布局 showBottomPanel=
    // false 迟到覆盖，分片负载下恢复请求常晚于单次点击，run9 实测）——rail 点击
    // 幂等重验（terminal-history-repeat 同款守卫）
    for (let i = 0; i < 3 && !(await panel.isVisible().catch(() => false)); i++) {
      await page.locator('.rail-btn[title="终端"]').click()
      await expect(panel).toBeVisible({ timeout: 5000 }).catch(() => { /* 收起竞态，重试 */ })
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
  // 项目切换的异步布局应用可能在上面的步骤之间把面板收起：点新建前重验一次
  await ensureOpen()
  // 先前用例可能把底部面板留在 Git/控制台分区且经 uiState 持久化：归一化到终端分区
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  // 提示符按服务端 shell 分支：Windows PowerShell（PS ...）/ Linux bash（$ 或 #）
  await expect(xterm).toContainText(/[$#] |PS /, { timeout: 20000 })
  return xterm
}

/** 打开运行书面板（终端工具条按钮） */
async function openRunbookPanel(page: Page) {
  await page.locator('.term-toolbar button[title="运行书"]').click()
  await expect(page.locator('.runbook-panel')).toBeVisible()
}

/** 打开目标运行书进入步骤视图 */
async function openTargetBook(page: Page) {
  await page.locator('.runbook-item').filter({ hasText: BOOK_TITLE }).first().click()
  await expect(page.locator('.runbook-panel .runbook-step')).toHaveCount(3)
}

/** 屏上包含 marker 文本的 xterm 行数（.xterm-rows 直接子行；限最后可见屏）。
 *  「插入不执行」断言的基底：文本只出现在输入行 = 1；被自动回车执行会多出
 *  一条输出行 = 2（标记串选短词，确保插入行内不发生终端宽度换行截断） */
function markerRowCount(page: Page, marker: string): Promise<number> {
  return page.evaluate((n) => {
    const screens = Array.from(document.querySelectorAll('.xterm')) as HTMLElement[]
    const visible = screens.filter(el => el.offsetParent !== null)
    const el = visible[visible.length - 1]
    if (!el) return -1
    const rows = Array.from(el.querySelectorAll('.xterm-rows > div')) as HTMLElement[]
    return rows.filter(r => (r.textContent || '').includes(n)).length
  }, marker)
}

test('面板内联新建 3 步运行书并落库（步骤有序）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await openFreshTerminal(page)

  await openRunbookPanel(page)
  await page.locator('.runbook-panel button[title="新建运行书"]').click()
  const form = page.locator('.runbook-form')
  await expect(form).toBeVisible()
  await form.locator('input').first().fill(BOOK_TITLE)
  await form.locator('input').nth(1).fill('e2e 夹具说明')
  // 3 个步骤：首行已有，再添两行，逐行填命令（说明只填第 1/3 步）
  await form.getByRole('button', { name: '添加步骤' }).click()
  await form.getByRole('button', { name: '添加步骤' }).click()
  const stepRows = form.locator('.runbook-form-step')
  await expect(stepRows).toHaveCount(3)
  for (let i = 0; i < 3; i++) {
    await stepRows.nth(i).locator('textarea').fill(STEP_CMDS[i]!)
    if (STEP_DESCS[i]) await stepRows.nth(i).locator('input').fill(STEP_DESCS[i]!)
  }
  await form.getByRole('button', { name: '保存' }).click()
  await expect(page.locator('.n-message').filter({ hasText: '运行书已保存' })).toBeVisible({ timeout: 5000 })

  // 列表出现该运行书（3 步徽标）
  const item = page.locator('.runbook-item').filter({ hasText: BOOK_TITLE })
  await expect(item).toBeVisible({ timeout: 5000 })
  await expect(item).toContainText('3 步')

  // API 落库复核：标题/说明/步骤数组序与说明可选字段一致
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as {
    title: string; description?: string
    steps: { command: string; description?: string }[]
  }[]).find(b => b.title === BOOK_TITLE)
  expect(mine, 'runbook persisted').toBeTruthy()
  expect(mine!.description).toBe('e2e 夹具说明')
  expect(mine!.steps.map(s => s.command)).toEqual(STEP_CMDS)
  expect(mine!.steps[0]!.description).toBe('第一步说明')
  expect(mine!.steps[1]!.description).toBeUndefined()
})

test('逐步发送到终端：插入不执行 + 完成勾选可重置', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  const xterm = await openFreshTerminal(page)

  // 重试路径自愈：beforeAll 重跑的清理可能已删掉用例 1 建的运行书
  await ensureRunbook()

  await openRunbookPanel(page)
  await openTargetBook(page)
  const steps = page.locator('.runbook-panel .runbook-step')

  // 步骤 1 发送：命令文本上屏；echo 标记仅 1 行（输入行）——出现输出行（2 行）
  // 即意味着被自动回车执行，直接失败
  await steps.nth(0).getByRole('button', { name: '发送', exact: true }).click()
  await expect(xterm).toContainText('sc-rb-step1', { timeout: 5000 })
  expect(await markerRowCount(page, 'sc-rb-step1')).toBe(1)
  // 发送即自动勾选（transient：面板内状态）
  await expect(steps.nth(0)).toHaveClass(/is-done/)
  // 清掉输入行残留（Ctrl+C 废弃当前行不执行），下一步标记独占一行
  await xterm.click()
  await page.keyboard.press('Control+c')

  // 步骤 2 发送：同断言（插入不执行，且不受步骤 1 残留影响）
  await steps.nth(1).getByRole('button', { name: '发送', exact: true }).click()
  await expect(xterm).toContainText('sc-rb-step2', { timeout: 5000 })
  expect(await markerRowCount(page, 'sc-rb-step2')).toBe(1)
  await xterm.click()
  await page.keyboard.press('Control+c')

  // 重置勾选：全部步骤回到未完成
  await page.locator('.runbook-panel').getByRole('button', { name: '重置勾选' }).click()
  await expect(steps.nth(0)).not.toHaveClass(/is-done/)
  await expect(steps.nth(1)).not.toHaveClass(/is-done/)

  // 手动勾选步骤 1（勾选不发送——勾选与发送相互独立）
  await steps.nth(0).locator('.n-checkbox').click()
  await expect(steps.nth(0)).toHaveClass(/is-done/)
  expect(await markerRowCount(page, 'sc-rb-step1')).toBe(1)

  // 步骤 3 发送收尾
  await steps.nth(2).getByRole('button', { name: '发送', exact: true }).click()
  await expect(xterm).toContainText('sc-rb-step3', { timeout: 5000 })
  expect(await markerRowCount(page, 'sc-rb-step3')).toBe(1)
})

test('命令面板「运行书」入口打开面板', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)

  // 重试路径自愈（同上）；列表断言需要该运行书在列
  await ensureRunbook()

  // 面板可能已由 uiState 恢复为展开态：先归一化到关闭基线（面板开关是 toggle 语义；
  // bottom-panel 为 v-show——元素常驻 DOM，断言可见性而非计数）
  const panel = page.locator('.bottom-panel')
  if (await panel.isVisible().catch(() => false)) {
    await page.locator('.bottom-actions button[title="关闭"]').click()
    await expect(panel).toBeHidden({ timeout: 5000 })
  }

  // 命令面板：Ctrl+K → '>' 进命令模式 → 输「运行书」→ 点命令
  await page.keyboard.press('Control+k')
  const input = page.locator('.palette-input input')
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('>运行书')
  const item = page.locator('.palette-item').filter({ hasText: '运行书' }).first()
  await expect(item).toBeVisible({ timeout: 5000 })
  await item.click()

  // 底部终端分区展开且运行书面板已打开
  await expect(panel).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.runbook-panel')).toBeVisible({ timeout: 5000 })
  await expect(page.locator('.runbook-item').filter({ hasText: BOOK_TITLE }).first()).toBeVisible({ timeout: 10000 })
})
