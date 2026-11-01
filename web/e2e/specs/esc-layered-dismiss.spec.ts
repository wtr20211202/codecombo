import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * Esc 逐层收起（P-20261004-12）：
 *   - 全局 Esc 退出链一次退一层不跨层：演示态（既有）→ 浮出层（终端浮动窗/
 *     智能体悬浮窗）→ 最大化（终端 > 编辑器区 > 底部全屏，既有）→ 底栏面板
 *   - naive 弹窗/抽屉在场时整体让位（hasBlockingOverlay）：弹窗内 Esc 只关弹窗，
 *     不得穿透退背后的布局层
 *   - 焦点让位（既有 INPUT/TEXTAREA veto）：终端聚焦 Esc 直通 PTY、编辑器自理
 *
 * 前置态自管（present-mode 同款）：uiState 面板开合/最大化是服务端跨用例全局
 * 状态，beforeAll 归零 + afterAll 再归一次防布局残留污染后续 spec；终端会话
 * beforeEach/afterEach 清理防残留进程。
 */

function unlockHeaders(): Promise<Record<string, string>> {
  return fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  }).then(async (res) => {
    const token = ((await res.json()) as { token?: string }).token || ''
    return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
  })
}

async function resetUiState(): Promise<void> {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/ui-state`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ local: null }),
  })
}

async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

/** 清空 simple-coding 项目的终端会话（服务端全局共享，防残留 tab/进程干扰） */
async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

/** 清空全部终端会话（agent 侧：管理页侧栏混入项目会话会干扰 .ats-item 计数） */
async function cleanupAllTerminals(request: APIRequestContext) {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

async function openProjectPage(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
}

/** 把侧栏/底栏归位到「都开」的已知前置态（present-mode 同款 bounded loop：
 *  Ctrl+B / Ctrl+` 是 toggle 键，盲按会反向关闭） */
async function ensurePanelsOpen(page: Page) {
  const sidePanel = page.locator('#side-panel')
  const bottomPanel = page.locator('[data-testid="bottom-panel"]')
  for (let i = 0; i < 3; i++) {
    const sideVisible = await sidePanel.isVisible().catch(() => false)
    const bottomVisible = await bottomPanel.isVisible().catch(() => false)
    if (sideVisible && bottomVisible) return
    if (!sideVisible) await page.keyboard.press('Control+b')
    if (!bottomVisible) await page.keyboard.press('Control+`')
    await page.waitForTimeout(600)
  }
  expect(await sidePanel.isVisible()).toBe(true)
  expect(await bottomPanel.isVisible()).toBe(true)
}

/** 把底栏归位到终端 tab 可见（.term-toolbar 出现即终端 tab 激活） */
async function ensureBottomTerminalOpen(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.keyboard.press('Control+`')
    await page.waitForTimeout(600)
  }
  expect(await page.locator('.term-toolbar').isVisible()).toBe(true)
}

/** 焦点归位 body：Esc 链只在焦点不在 INPUT/TEXTAREA 时工作（终端聚焦让位 PTY） */
async function blurActive(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.())
}

async function maximizeBottomPanel(page: Page) {
  const bottomPanel = page.locator('[data-testid="bottom-panel"]')
  await bottomPanel.locator('button[title="全屏最大化"]').click()
  await expect(bottomPanel).toHaveClass(/maximized/)
}

test.describe('Esc 逐层收起', () => {
  test.beforeAll(async () => {
    await resetUiState()
  })
  test.afterAll(async () => {
    await resetUiState()
  })
  test.afterEach(async ({ request }) => {
    // 会话清理兜底：防残留 tmux/PTY 进程影响同片后续 spec
    try {
      await cleanupAllTerminals(request)
    } catch { /* 清理失败不影响用例结论 */ }
  })

  test('最大化 + 底栏：连按两次 Esc 逐层恢复（一次退一层不跨层）', async ({ page }) => {
    await openProjectPage(page)
    const bottomPanel = page.locator('[data-testid="bottom-panel"]')
    const sidePanel = page.locator('#side-panel')
    await ensurePanelsOpen(page)
    await maximizeBottomPanel(page)

    // Esc #1：只退最大化层——面板回落停靠态仍可见，侧栏不动
    await page.keyboard.press('Escape')
    await expect(bottomPanel).not.toHaveClass(/maximized/)
    await expect(bottomPanel).toBeVisible()
    await expect(sidePanel).toBeVisible()

    // Esc #2：退底栏面板层
    await page.keyboard.press('Escape')
    await expect(bottomPanel).toBeHidden()
    // 侧栏未被跨层误收
    await expect(sidePanel).toBeVisible()
  })

  test('naive 弹窗在场时整体让位：Esc 只关弹窗，最大化原样', async ({ page }) => {
    await openProjectPage(page)
    const bottomPanel = page.locator('[data-testid="bottom-panel"]')
    await ensurePanelsOpen(page)
    await maximizeBottomPanel(page)

    // 快捷键备忘单（n-modal）压在最大化之上：? 键呼出
    await page.keyboard.press('?')
    const help = page.locator('.n-modal')
    await expect(help).toBeVisible({ timeout: 5000 })

    // Esc #1：只关备忘单（naive 自理），最大化不受穿透
    await page.keyboard.press('Escape')
    await expect(help).toBeHidden({ timeout: 5000 })
    await expect(bottomPanel).toHaveClass(/maximized/)

    // Esc #2：弹窗已收场，链恢复工作——退最大化
    await page.keyboard.press('Escape')
    await expect(bottomPanel).not.toHaveClass(/maximized/)
  })

  test('终端浮动窗：Esc 收回一层，再 Esc 关底栏', async ({ page, request }) => {
    const projectId = await getSimpleCodingProjectId(request)
    await cleanupProjectTerminals(request, projectId)
    await openProjectPage(page)
    await ensureBottomTerminalOpen(page)

    // 归一到单一终端 tab（复用 terminal-float-window 的清理/新建配方）
    for (let i = 0; i < 20; i++) {
      const lastTab = page.locator('.term-tab').last()
      if ((await lastTab.count()) === 0) break
      await lastTab.locator('.term-close-btn').click()
      if (await page.locator('.n-modal').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '确认' }).click()
      }
      await page.waitForTimeout(400)
    }
    await page.locator('.term-toolbar button[title="新建终端"]').click()
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 8000 })

    // 右键菜单「拖出为浮动窗」→ 浮动窗出现
    await page.locator('.term-tab').first().click({ button: 'right' })
    await page.locator('.term-tab-context-menu').getByText('拖出为浮动窗').click()
    const floatContent = page.locator('.term-tab-content.is-floating')
    await expect(floatContent).toHaveCount(1, { timeout: 10000 })
    await blurActive(page)

    // Esc #1：只收回浮动窗（tab 回停靠、底栏仍开）——浮出层是 z 序最上层先退
    await page.keyboard.press('Escape')
    await expect(floatContent).toHaveCount(0, { timeout: 10000 })
    await expect(page.locator('[data-testid="bottom-panel"]')).toBeVisible()

    // Esc #2：关底栏面板（一次一层，不跨层）
    await page.keyboard.press('Escape')
    await expect(page.locator('[data-testid="bottom-panel"]')).toBeHidden()
  })

  test('智能体悬浮窗：Esc 收起为悬浮球条（球条是静息态不再消费）', async ({ page, request }) => {
    await cleanupAllTerminals(request)
    await openProjectPage(page)

    // docked 管理页 → 新建纯终端会话（agent-terminal.spec 同主路径）
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    const tmpDir = await mkdtemp(path.join(tmpdir(), 'sc-esc-agent-'))
    await view.getByRole('button', { name: '新建会话' }).first().click()
    const dlg = page.locator('.n-modal')
    await expect(dlg).toBeVisible({ timeout: 5000 })
    // 新建会话对话框 P-20261002-16 起有两枚 .n-base-selection（运行时+任务模板），
    // 裸 locator 会 strict violation——按「运行时」表单锚定（agent-runtime-guide 同款）
    await dlg.locator('.n-form-item').filter({ hasText: '运行时' }).locator('.n-base-selection').click()
    await page.locator('.n-base-select-option').filter({ hasText: '纯终端' }).click()
    await dlg.locator('input').nth(1).fill(serverPath(tmpDir))
    await dlg.getByRole('button', { name: '创建' }).click()
    await expect(dlg).toBeHidden({ timeout: 10000 })
    await expect(view.locator('.ats-item')).toHaveCount(1, { timeout: 10000 })

    // 切悬浮窗
    await view.locator('.atv-header-actions [title="在悬浮窗中打开"]').click()
    const floatBox = page.locator('.atv-root.is-float')
    await expect(floatBox).toBeVisible({ timeout: 10000 })
    await blurActive(page)

    // Esc：悬浮窗收起为悬浮球条（collapse 语义，非销毁）
    await page.keyboard.press('Escape')
    await expect(floatBox).toBeHidden({ timeout: 5000 })
    const mini = page.locator('body > .agm-root')
    await expect(mini).toBeVisible({ timeout: 5000 })

    // 球条是收起静息态非浮出层：Esc 不再消费（球条不消失）
    await page.keyboard.press('Escape')
    await expect(mini).toBeVisible()
  })
})
