import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 终端会话实时对账 E2E（P1：terminals.changed 广播 → 底部终端 tab 同步）
 *
 * 前置：simple-coding 已运行（含 P1 后端广播）。
 *
 * 覆盖点（用 API 直接操作会话，模拟「他处」（终端会话管理页/其他宿主）的变更）：
 *   1. 他处新建项目会话 → 底部面板自动出现对应 tab（不激活当前 tab）
 *   2. 他处关闭会话 → 底部对应 tab 自动消失
 *   3. 他处重命名会话 → 底部 tab 名跟随
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 查 simple-coding 项目的 projectId */
async function getSimpleCodingProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

/** 打开底部终端面板（click-until-visible） */
async function openTerminalPanel(page: Page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
}

/** 清理：删除全部项目终端会话（跨 run 状态归一） */
async function cleanupProjectTerminals(request: APIRequestContext, projectId: string) {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
  for (const s of list) {
    if (s.projectId === projectId) {
      await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
}

/** 关闭全部 UI 终端 tab（容忍确认弹窗）：清掉页面挂载时恢复的遗留 tab */
async function closeAllTerminalTabs(page: Page) {
  for (let i = 0; i < 20; i++) {
    const lastTab = page.locator('.term-tab').last()
    if ((await lastTab.count()) === 0) return
    await lastTab.locator('.term-close-btn').click()
    if (await page.locator('.n-modal').isVisible().catch(() => false)) {
      await page.getByRole('button', { name: '确认' }).click()
    }
    await page.waitForTimeout(400)
  }
}

test.describe('终端会话实时对账（P1）', () => {
  let projectId = ''

  test.beforeEach(async ({ page, request }) => {
    projectId = await getSimpleCodingProjectId(request)
    // 服务端清场（含上一轮失败遗留），随后页面挂载恢复也拿不到遗留会话
    await cleanupProjectTerminals(request, projectId)

    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    const projectCard = projectCardByName(page, 'simple-coding').first()
    await projectCard.click()
    await page.waitForURL('**/project')
    await openTerminalPanel(page)
    // UI 层清场：恢复流程可能在服务端清场前已在途，逐个关闭（UI close 会调 API）
    await closeAllTerminalTabs(page)
    await expect(page.locator('.term-tab')).toHaveCount(0, { timeout: 5000 })
  })

  test.afterEach(async ({ request }) => {
    // 失败也要清场：遗留会话会污染后续 spec（恢复竞态 + tab 计数）
    await cleanupProjectTerminals(request, projectId)
  })

  test('他处新建/关闭/重命名项目会话，底部 tab 实时跟随', async ({ page, request }) => {
    // 临时诊断：捕获页面 console/error（定位 reconcile/WS 链路问题后移除）
    page.on('console', (msg) => {
      if (msg.type() === 'error' || msg.text().includes('terminal')) console.log('[BROWSER]', msg.type(), msg.text())
    })
    page.on('pageerror', (err) => console.log('[PAGEERROR]', err.message))

    const headers = await unlockHeaders(request)

    // ---- 本地新建 tab A（UI 路径）----
    await page.getByRole('button', { name: '新建终端' }).first().click()
    await page.locator('.term-container .xterm').locator('visible=true').first()
      .waitFor({ state: 'visible', timeout: 10000 })
    await expect(page.locator('.term-tab')).toHaveCount(1)

    // ---- 他处新建会话 B（API 路径）→ tab 自动出现且不抢激活 ----
    const created = await request.post(`${BASE}/api/terminals`, {
      headers,
      data: { projectId, name: 'SyncB' },
    })
    expect(created.ok()).toBeTruthy()
    const createdId = ((await created.json()) as { data?: { id?: string } }).data?.id || ''
    expect(createdId).not.toBe('')
    await expect(page.locator('.term-tab')).toHaveCount(2, { timeout: 10000 })
    const activeName = await page.locator('.term-tab.primary .term-tab-name, .term-tab.active .term-tab-name')
      .first().textContent().catch(() => '')
    // 激活 tab 仍是本地建的（可能是 A 或恢复的旧会话，但绝不是刚由他处新建的 B 抢焦点）
    expect(activeName).not.toBe('SyncB')

    // ---- 他处重命名 B → tab 名跟随 ----
    await request.put(`${BASE}/api/terminals/${createdId}/rename`, {
      headers,
      data: { name: 'SyncB-改名' },
    })
    await expect(page.locator('.term-tab-name', { hasText: 'SyncB-改名' })).toBeVisible({ timeout: 10000 })

    // ---- 他处关闭 B → tab 自动消失 ----
    await request.delete(`${BASE}/api/terminals/${createdId}`, { headers })
    await expect(page.locator('.term-tab')).toHaveCount(1, { timeout: 10000 })
  })
})
