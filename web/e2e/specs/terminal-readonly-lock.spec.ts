import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Locator, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { serverPath, serverIsLinux } from '../../tests/dualpath'

/**
 * 会话窗格只读观察锁（P-20261003-91）E2E：
 *   1. 未锁定基线：键入 echo → 输出到达（输入链路活，排除假阴性判据）
 *   2. 锁定：角标/描边视觉在位 → 再键入 → 输出无新字符（不写 WS、不达 PTY）；
 *      复制仍可用（右键复制全部 → 成功 toast）
 *   3. 解锁：键入恢复到达
 *   4. transient：页面刷新后锁定态复位（会话内态，不持久化）
 * 纯终端运行时真实 shell：echo 唯一标记做「到达/未到达」判据（PTY 无回滚，
 * 锁定语义即键盘输入不写 WS——shell 不回显即未到达）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
// 提示符按服务端 shell 分支：Windows 默认 PowerShell（PS ...）；
// Linux bash 提示符以 $（普通用户）或 #（root）收尾（同 terminal-copy-last-output）
const PROMPT_RE = serverIsLinux ? /[#$] / : /PS /i

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，跨 spec 残留会混入侧栏计数） */
async function cleanupAgentTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 进项目页 → 管理页新建纯终端会话（临时目录）→ 返回就绪（提示符已渲染）的可见 xterm */
async function openAgentShellPane(page: Page): Promise<Locator> {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')
  const projectCard = projectCardByName(page, 'simple-coding').first()
  await projectCard.click()
  await page.waitForURL('**/project')

  await page.locator('.rail-btn[title="终端会话管理"]').click()
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 10000 })

  const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-rolock-e2e-'))
  await view.getByRole('button', { name: '新建会话' }).first().click()
  const dlg = page.locator('.n-modal')
  await expect(dlg).toBeVisible({ timeout: 5000 })
  await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
  await dlg.locator('input').nth(1).fill(serverPath(tmpDir))
  await dlg.getByRole('button', { name: '创建' }).click()
  await expect(dlg).toBeHidden({ timeout: 15000 })

  const xterm = page.locator('.xterm:visible').last()
  await expect(xterm).toBeVisible({ timeout: 20000 })
  await expect(xterm).toContainText(PROMPT_RE, { timeout: 20000 })
  return xterm
}

/** 键入 echo <marker>（点击终端取得焦点后走真实键盘事件 → xterm onData → WS） */
async function typeEchoMarker(page: Page, xterm: Locator, marker: string): Promise<void> {
  await xterm.click()
  await page.keyboard.type(`echo ${marker}\r`)
}

test.beforeEach(async ({ request }) => {
  await cleanupAgentTerminals(request)
})

test('只读锁定：键入不达 PTY → 复制仍可用 → 解锁恢复输入', async ({ page }) => {
  test.setTimeout(180000)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  const xterm = await openAgentShellPane(page)

  // 未锁定基线：echo 到达（证明输入链路活——锁定期的「无输出」才是有效判据）
  const m1 = `SC-RO-BASE-${Date.now()}`
  await typeEchoMarker(page, xterm, m1)
  await expect(xterm).toContainText(m1, { timeout: 10000 })

  // 锁定：按钮角标进入锁定态 + 容器描边提示（is-input-locked）
  await page.locator('[data-testid="term-pane-input-lock"]:visible').click()
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(1)
  await expect(page.locator('[data-testid="term-pane-input-lock"]')).toHaveClass(/is-locked/)

  // 锁定期键入：等 2s 给可能的泄漏回显留时间窗，断言无新字符（不写 WS → 无回显无输出）
  const m2 = `SC-RO-LOCKED-${Date.now()}`
  await typeEchoMarker(page, xterm, m2)
  await page.waitForTimeout(2000)
  await expect(xterm).not.toContainText(m2)

  // 复制仍可用（只锁输入不锁选择）：右键 → 复制全部 → 成功 toast
  await xterm.click({ button: 'right' })
  const ctxMenu = page.locator('.term-context-menu')
  await expect(ctxMenu).toBeVisible()
  await ctxMenu.getByText('复制全部', { exact: true }).click()
  await expect(page.locator('.n-message').filter({ hasText: '已复制到剪贴板' })).toBeVisible({ timeout: 5000 })

  // 解锁：描边撤销，键入恢复到达
  await page.locator('[data-testid="term-pane-input-lock"]:visible').click()
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(0)
  const m3 = `SC-RO-UNLOCK-${Date.now()}`
  await typeEchoMarker(page, xterm, m3)
  await expect(xterm).toContainText(m3, { timeout: 10000 })
})

test('只读锁为会话内 transient：页面刷新后复位默认关', async ({ page }) => {
  test.setTimeout(120000)
  const xterm = await openAgentShellPane(page)

  // 锁定生效
  await page.locator('[data-testid="term-pane-input-lock"]:visible').click()
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(1)

  // 重新引导（等价刷新：SPA 重挂载 → inputLocked 会话内态复位）→ 回管理页。
  // 管理页常以首页 overlay 形态（agt-home-overlay）随 uiState 恢复打开、盖在
  // 首页上——已恢复直接用（此时项目卡点击会被它拦截）；未恢复走项目页 rail 入口。
  // waitFor 竞速而非固定睡等，避免 boot 时序脆弱
  await gotoAndUnlock(page, '/')
  const view = page.locator('.atv-root')
  const restored = await view.waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true).catch(() => false)
  if (!restored) {
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    await expect(view).toBeVisible({ timeout: 10000 })
  }
  await view.locator('.ats-item').first().click()
  const xterm2 = page.locator('.xterm:visible').last()
  await expect(xterm2).toBeVisible({ timeout: 20000 })
  await expect(page.locator('.term-container.is-input-locked')).toHaveCount(0)
  // 锁按钮回到未锁定态（tooltip 为「锁定」引导文案而非「恢复」）
  await expect(page.locator('[data-testid="term-pane-input-lock"]:visible')).toHaveCount(1)
  await expect(page.locator('[data-testid="term-pane-input-lock"]:visible'))
    .not.toHaveClass(/is-locked/)
})
