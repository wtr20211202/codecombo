import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 运行书命令占位符参数（P-20261004-17，对齐 P-123 片段语义）E2E：
 *   1. 全书去重参数表单：两步同含 {branch} →「运行」先弹一次参数表单（去重后
 *      只问一个 branch）→ 填值「填参运行」→ 两步均以替换后命令真执行（终端两处
 *      输出、{branch} 零残留）、状态至「运行完成」
 *   2. 逐步发送链回归（P-24 内联展开）：带 {branch} 步骤「发送」→ 内联填值区
 *      →「填好发送」→ 替换后插入不执行（echo 标记仅输入行 1 处）
 * 前置（spec 内自备）：临时空项目；用例开头 API 幂等播种运行书（Playwright
 * 重试会重跑 beforeAll 清理，重试路径必须自愈）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-runbook-params'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-runbook-params')
const BOOK_TITLE = 'e2e 全书去重参数运行书'
// 两步同含同名 {branch}（echo 误执行无副作用；值含 / 验证非标识符字符原样替换）
const BOOK_CMDS = ['echo sc-rbp-a-{branch}', 'echo sc-rbp-b-{branch}']
const SINGLE_TITLE = 'e2e 单步带参运行书'
const SINGLE_CMDS = ['echo sc-rbp-single-{branch}']
const SEEDED_TITLES = [BOOK_TITLE, SINGLE_TITLE]
const PARAM_VALUE = 'feature/rbp'

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
    if (SEEDED_TITLES.includes(b.title)) await api('DELETE', `/api/runbooks/${b.id}`)
  }
}

/** 幂等播种：同名运行书在位即复用，缺失（含重试路径 beforeAll 清理后）经 API 补建 */
async function ensureBook(title: string, commands: string[]): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { id: string; title: string }[]).find(b => b.title === title)
  if (mine) return
  const res = await api('POST', '/api/runbooks', {
    title,
    steps: commands.map(command => ({ command })),
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

/** 打开运行书面板（幂等：uiState 可能已恢复展开态，toggle 语义再点会关上） */
async function openRunbookPanel(page: Page) {
  if (await page.locator('.runbook-panel').isVisible().catch(() => false)) return
  await page.locator('.term-toolbar button[title="运行书"]').click()
  await expect(page.locator('.runbook-panel')).toBeVisible()
}

/** 打开目标运行书进入步骤视图 */
async function openTargetBook(page: Page, title: string, stepCount: number) {
  await page.locator('.runbook-item').filter({ hasText: title }).first().click()
  await expect(page.locator('.runbook-panel .runbook-step')).toHaveCount(stepCount)
}

/** 屏上包含 marker 文本的 xterm 行数（.xterm-rows 直接子行；限最后可见屏） */
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

test('两步同含 {branch}：运行弹一次表单，两步均替换后执行', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook(BOOK_TITLE, BOOK_CMDS)
  const xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page, BOOK_TITLE, 2)

  // 运行 → 先弹全书参数表单（尚未发车：屏上无命令输出）
  await page.locator('.runbook-steps-actions').getByRole('button', { name: '运行', exact: true }).click()
  const form = page.locator('.runbook-runparams')
  await expect(form).toBeVisible()
  // 全书去重：两步同名 {branch} 只问一次（一行）
  await expect(form.locator('.runbook-param-row')).toHaveCount(1)
  await expect(form.locator('.runbook-param-label')).toHaveText('branch')
  expect(await markerRowCount(page, 'sc-rbp-a-')).toBe(0)

  // 填一次值 → 填参运行：两步均以替换后命令真执行，{branch} 零残留
  await form.locator('input').fill(PARAM_VALUE)
  await form.getByRole('button', { name: '填参运行' }).click()
  await expect(page.locator('.runbook-run-status')).toContainText('运行完成', { timeout: 90000 })
  await expect(xterm).toContainText(`sc-rbp-a-${PARAM_VALUE}`, { timeout: 5000 })
  await expect(xterm).toContainText(`sc-rbp-b-${PARAM_VALUE}`, { timeout: 5000 })
  expect(await markerRowCount(page, '{branch}')).toBe(0)

  // 面板内已展开的步骤命令仍显示原始模板（存储不改写——替换只发生在发送链）
  await expect(page.locator('.runbook-panel .runbook-step-cmd').first()).toContainText('{branch}')
})

test('带参步骤逐步发送：内联填值后插入不执行（P-24 链回归）', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook(SINGLE_TITLE, SINGLE_CMDS)
  const xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page, SINGLE_TITLE, 1)
  const steps = page.locator('.runbook-panel .runbook-step')

  await steps.nth(0).getByRole('button', { name: '发送', exact: true }).click()
  const inline = page.locator('.runbook-params')
  await expect(inline).toBeVisible()
  await expect(inline.locator('.runbook-param-row')).toHaveCount(1)

  await inline.locator('input').fill(PARAM_VALUE)
  await steps.nth(0).getByRole('button', { name: '填好发送', exact: true }).click()
  // 插入不执行：替换后命令独占输入行（1 行）；被自动回车执行会出现输出行（2 行）
  await expect(xterm).toContainText(`sc-rbp-single-${PARAM_VALUE}`, { timeout: 5000 })
  expect(await markerRowCount(page, `sc-rbp-single-${PARAM_VALUE}`)).toBe(1)
})
