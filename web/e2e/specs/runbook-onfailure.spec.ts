import { test, expect, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 运行书失败即停（P-20261004-13 onFailure 语义）E2E：
 *   1. stop 模式：3 步运行书（成功/必败/成功）→「运行」→ 第 2 步退出码 7 →
 *      停在失败项（失败高亮 + 状态行 + 第 3 步未发送）；关「失败即停」（走 update
 *      链）→「从失败项继续」→ 失败步重跑不再拦截 → 第 3 步执行至「运行完成」
 *   2. continue 模式（默认）：含失败步的运行书「运行」全跑完（失败标红但不拦截）
 *   3. 数据面 onFailure 持久化：stop 落库回读 → update 切 continue → 非法值 400 →
 *      缺省创建 = continue 语义（omitempty 不回显）
 * 必败命令按服务端 shell 语义选（退出码同为 7）：Windows 服务端 PowerShell 下借道
 * cmd，Linux bash 用 sh -c——D 帧退出码上报链路已在 terminal-history-snippet.spec.ts
 * 用同一对命令证实。前置（spec 内自备）：临时空项目；用例开头 API 幂等播种
 * （Playwright 重试会重跑 beforeAll 清理，重试路径必须自愈）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
const PROJ_NAME = 'e2e-runbook-onfail'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_DIR = path.resolve(HERE, '../../../.sc-tmp/e2e-runbook-onfail')
const FAIL_CMD = serverIsLinux ? 'sh -c "exit 7"' : 'cmd /c exit 7'

const STOP_TITLE = 'e2e 失败即停运行书'
const STOP_CMDS = ['echo sc-rb-onfail-1', FAIL_CMD, 'echo sc-rb-onfail-3']
const CONT_TITLE = 'e2e 连续运行运行书'
const CONT_CMDS = ['echo sc-rb-oncont-1', FAIL_CMD, 'echo sc-rb-oncont-3']
const SEEDED_TITLES = [STOP_TITLE, CONT_TITLE, 'e2e 持久化运行书', 'e2e 默认语义运行书']

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
async function ensureBook(title: string, commands: string[], onFailure: 'continue' | 'stop'): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { id: string; title: string }[]).find(b => b.title === title)
  if (mine) return
  const res = await api('POST', '/api/runbooks', {
    title,
    onFailure,
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
async function openTargetBook(page: Page, title: string) {
  await page.locator('.runbook-item').filter({ hasText: title }).first().click()
  await expect(page.locator('.runbook-panel .runbook-step')).toHaveCount(3)
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

test('stop 模式停在失败项：失败高亮 + 第 3 步未发送，从失败项继续跑完', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook(STOP_TITLE, STOP_CMDS, 'stop')
  const xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page, STOP_TITLE)

  // 种子 onFailure=stop 经数据链回显：失败即停开关呈开
  await expect(page.locator('.runbook-onfailure-toggle .n-switch.n-switch--active')).toHaveCount(1)

  // 运行 → 停在第 2 步（预算 90s：即使首条等待走到 30s 超时兜底慢路径也不超时）
  await page.locator('.runbook-steps-actions').getByRole('button', { name: '运行', exact: true }).click()
  const status = page.locator('.runbook-run-status')
  await expect(status).toContainText('第 2 步失败，已停止后续步骤', { timeout: 90000 })

  // 停止位高亮落在第 2 步；shell 集成在位（不出现降级诚实提示）
  await expect(page.locator('.runbook-panel .runbook-step').nth(1)).toHaveClass(/is-run-failed/)
  await expect(page.locator('.runbook-run-degraded')).toHaveCount(0)

  // 第 1 步已真执行；第 3 步未被发送（stop 拦截生效——屏上无其输出行）
  await expect(xterm).toContainText('sc-rb-onfail-1', { timeout: 5000 })
  expect(await markerRowCount(page, 'sc-rb-onfail-3')).toBe(0)

  // 关「失败即停」（打开书内开关走 update 既有链路）→ 从失败项继续：
  // 失败步重跑（退出码 7 但 continue 不拦截）→ 第 3 步执行至「运行完成」
  await page.locator('.runbook-onfailure-toggle .n-switch').click()
  await expect(page.locator('.runbook-onfailure-toggle .n-switch.n-switch--active')).toHaveCount(0)
  await page.locator('.runbook-steps-actions').getByRole('button', { name: '从失败项继续' }).click()
  await expect(status).toContainText('运行完成', { timeout: 90000 })
  await expect(xterm).toContainText('sc-rb-onfail-3', { timeout: 10000 })

  // update 链落库复核：onFailure 已切 continue
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { title: string; onFailure?: string }[]).find(b => b.title === STOP_TITLE)
  expect(mine?.onFailure).toBe('continue')
})

test('continue 模式全跑完：失败步标红但不拦截', async ({ page }) => {
  test.setTimeout(180000)
  await fixedLocale(page)
  await page.addInitScript(() => localStorage.setItem('sc.terminal.closeNoConfirm', '1'))
  await page.goto('/project')
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await switchProject(page, PROJ_NAME)
  await ensureBook(CONT_TITLE, CONT_CMDS, 'continue')
  const xterm = await openFreshTerminal(page)

  await openRunbookPanel(page)
  await openTargetBook(page, CONT_TITLE)

  // 默认 continue：开关呈关
  await expect(page.locator('.runbook-onfailure-toggle .n-switch.n-switch--active')).toHaveCount(0)

  await page.locator('.runbook-steps-actions').getByRole('button', { name: '运行', exact: true }).click()
  await expect(page.locator('.runbook-run-status')).toContainText('运行完成', { timeout: 90000 })

  // 三步全部真执行（含失败步之后的第 3 步）；失败步仍如实标红（不拦截 ≠ 掩饰失败）
  await expect(xterm).toContainText('sc-rb-oncont-1', { timeout: 5000 })
  await expect(xterm).toContainText('sc-rb-oncont-3', { timeout: 10000 })
  await expect(page.locator('.runbook-panel .runbook-step').nth(1)).toHaveClass(/is-run-failed/)
})

test('onFailure 持久化：stop 落库 / update 切换 / 非法值 400 / 缺省即 continue', async () => {
  // 创建带 stop → 回读一致
  const created = await api('POST', '/api/runbooks', {
    title: 'e2e 持久化运行书',
    onFailure: 'stop',
    steps: [{ command: 'echo p13' }],
  })
  expect([200, 201]).toContain(created.status)
  expect(created.json?.data?.onFailure).toBe('stop')
  const id = created.json?.data?.id as string
  let list = await api('GET', '/api/runbooks')
  let mine = ((list.json?.data || []) as { id: string; onFailure?: string }[]).find(b => b.id === id)
  expect(mine?.onFailure).toBe('stop')

  // update 切 continue（patch 语义：显式值生效）
  const updated = await api('PUT', `/api/runbooks/${id}`, { onFailure: 'continue' })
  expect(updated.status).toBe(200)
  expect(updated.json?.data?.onFailure).toBe('continue')

  // 非法枚举拒绝
  const bad = await api('PUT', `/api/runbooks/${id}`, { onFailure: 'explode' })
  expect(bad.status).toBe(400)

  // 缺省创建：不回显（omitempty）= continue 语义
  const def = await api('POST', '/api/runbooks', {
    title: 'e2e 默认语义运行书',
    steps: [{ command: 'echo p13-default' }],
  })
  expect([200, 201]).toContain(def.status)
  expect(def.json?.data?.onFailure).toBeUndefined()
  // 两本直建运行书由 afterAll cleanupRunbooks 按标题清单兜底清理
})
