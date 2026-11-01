import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 任务运行器一键重跑 E2E（P-20261002-120）：
 *   1. 跑一任务 → 重开面板 → 运行历史行（时间戳 + 命令可见）点「重跑」→
 *      新同名任务终端出现（新运行记录）且首个终端保留（旧记录保留）→
 *      历史区按次新增（两行同任务，时间戳区分，不复用旧行）
 *   2. 原定义重触发不依赖清单：uiState 播种清单外幽灵任务快照 → 历史行
 *      「重跑」照常建终端执行快照命令（快照即原任务定义）
 * 共享实例 uiState 播种/清理，任务终端收尾关闭，重试幂等（开局先清残留）
 */

const RERUN_TASK = 'type-check' // npm scripts（键盘导航 spec 同款真实运行先例）
const GHOST_TASK = 'e2e-ghost-rerun'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 清空/播种运行历史（共享实例 uiState 持久化，逐实例键写入，同键盘导航 spec 口径）
async function writeRecent(request: APIRequestContext, recent: unknown[]) {
  const headers = await unlockHeaders()
  const uiGet = await request.get(`${API_BASE}/api/ui-state`)
  const uiMap = ((await uiGet.json()) as { data?: Record<string, Record<string, unknown>> }).data || {}
  for (const k of Object.keys(uiMap)) {
    await request.put(`${API_BASE}/api/ui-state`, { data: { [k]: { taskRunner: { recent } } }, headers })
  }
}

// 确保底部面板收在终端 tab（重开时遮罩/其他 tab 会藏住 tab 栏，键盘导航 spec 同款归一化）
async function showTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(500)
  }
}

// 关闭名称匹配的任务终端（运行中终端关闭弹确认；循环至清空保证重试幂等）
async function closeTaskTerminals(page: Page, names: string[]) {
  await showTerminalPanel(page)
  for (const name of names) {
    for (;;) {
      const tab = page.locator('.term-tab').filter({ hasText: name }).first()
      if (!(await tab.isVisible().catch(() => false))) break
      await tab.locator('.term-close-btn').click()
      if (await page.locator('.n-modal').isVisible().catch(() => false)) {
        await page.getByRole('button', { name: '确认' }).click()
      }
      await page.waitForTimeout(400)
    }
  }
}

async function openTaskPanel(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  // 重试/前序用例残留的任务终端先关掉，保证 tab 计数断言确定
  await closeTaskTerminals(page, [RERUN_TASK, GHOST_TASK])
  await page.locator('button[title="任务"], .topbar button:has-text("任务")').first().click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
  // 后端首扫 manifest（npm/go 等 11 种）可能慢于 3s
  await expect(page.locator('.tr-item').first()).toBeVisible({ timeout: 10000 })
}

test('历史行重跑：新同名终端出现、旧终端保留、历史按次新增', async ({ page, request }) => {
  await writeRecent(request, [])
  await openTaskPanel(page)

  // 真实用户路径运行任务（点击即建终端并在后台执行，对断言无影响）
  await page.locator('.tr-item').filter({ hasText: RERUN_TASK }).first().click()
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })

  await showTerminalPanel(page)
  const tabs = page.locator('.term-tab').filter({ hasText: RERUN_TASK })
  await expect(tabs).toHaveCount(1, { timeout: 5000 })

  // 重开面板：运行历史行含时间戳与命令（原任务定义/参数可见），点「重跑」
  await page.locator('button[title="任务"], .topbar button:has-text("任务")').first().click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
  const historySection = page.locator('.tr-card .tr-section').first()
  const historyRow = historySection.locator('.tr-item-row').filter({ hasText: RERUN_TASK })
  await expect(historyRow).toHaveCount(1)
  await expect(historyRow.locator('.tr-item-time')).toHaveText(/\d/)
  await expect(historyRow.locator('.tr-item-cmd')).toHaveText('npm run type-check')
  await historyRow.locator('[data-testid="task-rerun-btn"]').click()
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })

  // 新运行出现且同参数：同名 tab 恰 +1（新建非复用），首个终端保留（旧记录保留）
  await expect(tabs).toHaveCount(2, { timeout: 5000 })
  await expect(tabs.first()).toBeVisible()

  // 重跑产生新历史行：按次记录不复用旧记录，历史区两行同任务（时间戳区分）
  await page.locator('button[title="任务"], .topbar button:has-text("任务")').first().click()
  await expect(page.locator('.tr-card')).toBeVisible({ timeout: 3000 })
  await expect(historySection.locator('.tr-item-row').filter({ hasText: RERUN_TASK })).toHaveCount(2)

  await page.keyboard.press('Escape')
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })
  await closeTaskTerminals(page, [RERUN_TASK])
  await writeRecent(request, [])
})

test('原定义重触发不依赖清单：幽灵快照任务经历史行重跑照常执行', async ({ page, request }) => {
  await writeRecent(request, [
    { task: { source: 'npm', name: GHOST_TASK, command: 'echo SCSEED-GHOST-RERUN', cwd: '' }, at: Date.now() },
  ])
  await openTaskPanel(page)

  // 清单中无该任务：全列表仅运行历史行一处出现（快照直渲，不回查清单）
  const historyRow = page.locator('.tr-item-row').filter({ hasText: GHOST_TASK })
  await expect(historyRow).toHaveCount(1)
  await expect(page.locator('.tr-item').filter({ hasText: GHOST_TASK })).toHaveCount(1)
  await expect(historyRow.locator('.tr-item-cmd')).toContainText('SCSEED-GHOST-RERUN')

  await historyRow.locator('[data-testid="task-rerun-btn"]').click()
  await expect(page.locator('.tr-card')).toBeHidden({ timeout: 3000 })

  // 幽灵任务终端出现（echo 瞬时完成，终端保留）——重跑以快照为原任务定义
  await showTerminalPanel(page)
  await expect(page.locator('.term-tab').filter({ hasText: GHOST_TASK })).toHaveCount(1, { timeout: 5000 })

  await closeTaskTerminals(page, [GHOST_TASK])
  await writeRecent(request, [])
})
