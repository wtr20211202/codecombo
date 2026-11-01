import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { serverPath } from '../../tests/dualpath'

/**
 * 运行书参数历史值建议（P-20261004-112）E2E：
 *   1. 跑一次带参 → 提交记 per-book per-param 环形史（safeStorage 键
 *      runbook-params-history，落本机 localStorage）
 *   2. 再跑同书 → 参数框聚焦弹历史下拉 → 前缀过滤/全滤掉空态 → 点选回填
 *      （不自动发车）→ 填参运行提交成功
 *   3. 刷新页面（跨会话）历史仍在；下拉尾部「清空该参数历史」后聚焦不再弹
 * 交互语沿 useSearchHistory（ProjectSearch 查询历史下拉同款）。
 * 前置（spec 内自备）：临时空项目；用例开头 API 幂等播种运行书（Playwright
 * 重试会重跑 beforeAll 清理，重试路径必须自愈）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-runbook-param-history'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-runbook-param-history')
const BOOK_TITLE = 'e2e 参数历史运行书'
const BOOK_CMDS = ['echo sc-rbph-{branch}']
const PARAM_VALUE = 'main'
const RELOAD_VALUE = 'feat/rbph'

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
async function ensureBook(): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { id: string; title: string }[]).find(b => b.title === BOOK_TITLE)
  if (mine) return
  const res = await api('POST', '/api/runbooks', {
    title: BOOK_TITLE,
    steps: BOOK_CMDS.map(command => ({ command })),
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
  const panel = page.locator('.bottom-panel')
  const ensureOpen = async () => {
    if (!(await panel.isVisible().catch(() => false))) {
      await page.locator('.rail-btn[title="终端"]').click()
    }
    await expect(panel).toBeVisible({ timeout: 5000 })
  }
  await ensureOpen()
  const closeButtons = page.locator('.term-tab .term-close-btn')
  while (await closeButtons.count() > 0) {
    await closeButtons.first().click()
    await expect(closeButtons).toHaveCount(await closeButtons.count() - 1, { timeout: 5000 }).catch(async () => {
      await page.keyboard.press('Enter')
    })
  }
  await ensureOpen()
  const newBtn = page.getByRole('button', { name: '新建终端' }).first()
  if (!(await newBtn.isVisible().catch(() => false))) {
    await page.locator('.bottom-tabs button').filter({ hasText: '终端' }).click()
    await page.waitForTimeout(300)
  }
  await newBtn.click()
  // xterm 取 last（CLAUDE.md「测试」节）：新建 tab 追加在 DOM 尾部，多 tab 时 first 会选中旧屏
  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
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
async function openTargetBook(page: Page) {
  await page.locator('.runbook-item').filter({ hasText: BOOK_TITLE }).first().click()
  await expect(page.locator('.runbook-panel .runbook-step')).toHaveCount(1)
}

/** 发起一次运行并等全书参数表单出现（重跑按钮文案随运行态变化：运行/重新运行） */
async function startRunOpenForm(page: Page) {
  await page.locator('.runbook-steps-actions').getByRole('button', { name: /^(重新)?运行$/ }).click()
  const form = page.locator('.runbook-runparams')
  await expect(form).toBeVisible()
  return form
}

test('跑一次带参→再跑同书：聚焦显历史→前缀过滤→点选回填提交', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook()
  const xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page)

  // ── 第一次运行：手工填值提交（记史来源）──
  const form1 = await startRunOpenForm(page)
  await expect(form1.locator('.runbook-param-row')).toHaveCount(1)
  await form1.locator('input').first().fill(PARAM_VALUE)
  await form1.getByRole('button', { name: '填参运行' }).click()
  await expect(page.locator('.runbook-run-status')).toContainText('运行完成', { timeout: 90000 })
  await expect(xterm).toContainText(`sc-rbph-${PARAM_VALUE}`, { timeout: 5000 })
  // 提交记史：safeStorage 键 runbook-params-history 落本机（含该书该参环形）
  const stored = await page.evaluate(() => localStorage.getItem('runbook-params-history'))
  expect(stored).toContain(PARAM_VALUE)

  // ── 第二次运行：参数框聚焦弹历史下拉 ──
  await startRunOpenForm(page)
  const input2 = page.locator('.runbook-runparams input').first()
  // P-17 既有语义：全书表单预填共享 paramValues（上次提交值已在框内）
  await expect(input2).toHaveValue(PARAM_VALUE)
  await input2.click()
  const dropdown = page.locator('[data-testid="rb-history"]')
  await expect(dropdown).toBeVisible()
  // 历史置顶=上次提交值；点选回填不自动发车（发车仍走显式确认钮）
  await expect(dropdown.locator('[data-testid="rb-history-item-0"]')).toHaveText(PARAM_VALUE)

  // 前缀过滤补全（useSearchHistory 同口径：大小写不敏感）
  await input2.fill('MA')
  await expect(dropdown.locator('[data-testid="rb-history-item-0"]')).toHaveText(PARAM_VALUE)
  // 全滤掉给空态提示（静默消失像坏了）
  await input2.fill('zz-nope')
  await expect(dropdown.locator('[data-testid="rb-history-empty"]')).toBeVisible()
  // 手动编辑恢复可见后 Esc 收起：本轮聚焦内不再自动弹出（点击可重新唤出）
  await input2.fill('')
  await expect(dropdown.locator('[data-testid="rb-history-item-0"]')).toBeVisible()
  await input2.press('Escape')
  await expect(dropdown).toBeHidden()
  await input2.click()
  await expect(dropdown).toBeVisible()

  // 点选回填 → 提交：命令以历史值真执行（第二次输出落屏）
  await dropdown.locator('[data-testid="rb-history-item-0"]').click()
  await expect(dropdown).toBeHidden()
  await expect(input2).toHaveValue(PARAM_VALUE)
  await page.locator('.runbook-runparams').getByRole('button', { name: '填参运行' }).click()
  // 第二轮断言用屏上行数（运行完成文案不刷新——上轮终态同文案，等待会假绿）；
  // 每轮回显+输出 ≥2 行、两轮 ≥4 行（≥ 容忍窄屏折行）
  await expect(xterm).toContainText(`sc-rbph-${PARAM_VALUE}`, { timeout: 90000 })
  await expect.poll(() => markerRowCount(page, `sc-rbph-${PARAM_VALUE}`), { timeout: 30000 }).toBeGreaterThanOrEqual(4)
})

test('刷新跨会话历史仍在→点选回填提交→清空该参数历史后不再弹', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook()
  let xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page)

  // 先跑一次带参（记史）
  const form1 = await startRunOpenForm(page)
  await form1.locator('input').first().fill(RELOAD_VALUE)
  await form1.getByRole('button', { name: '填参运行' }).click()
  await expect(page.locator('.runbook-run-status')).toContainText('运行完成', { timeout: 90000 })
  await expect(xterm).toContainText(`sc-rbph-${RELOAD_VALUE}`, { timeout: 5000 })

  // 刷新（同 context 内 localStorage 存活=跨会话持久化语义）：历史仍在并可直接回填提交
  await page.reload()
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  xterm = await openFreshTerminal(page)
  await openRunbookPanel(page)
  await openTargetBook(page)

  const form2 = await startRunOpenForm(page)
  const input2 = form2.locator('input').first()
  await input2.click()
  const dropdown = page.locator('[data-testid="rb-history"]')
  await expect(dropdown).toBeVisible()
  await expect(dropdown.locator('[data-testid="rb-history-item-0"]')).toHaveText(RELOAD_VALUE)
  await dropdown.locator('[data-testid="rb-history-item-0"]').click()
  await expect(input2).toHaveValue(RELOAD_VALUE)
  await form2.getByRole('button', { name: '填参运行' }).click()
  await expect(xterm).toContainText(`sc-rbph-${RELOAD_VALUE}`, { timeout: 90000 })

  // 下拉尾部「清空该参数历史」：提交后表单已收，重开表单再聚焦唤出下拉
  await startRunOpenForm(page)
  const input3 = page.locator('.runbook-runparams input').first()
  await input3.click()
  await expect(dropdown).toBeVisible()
  await dropdown.locator('[data-testid="rb-history-clear"]').click()
  await expect(dropdown).toBeHidden()
  await input3.click()
  await expect(dropdown).toBeHidden()
  const stored = await page.evaluate(() => localStorage.getItem('runbook-params-history'))
  expect(stored || '').not.toContain(RELOAD_VALUE)
})

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
