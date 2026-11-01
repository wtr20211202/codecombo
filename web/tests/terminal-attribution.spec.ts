import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from './helpers'

/**
 * 进度归属 E2E（P7）：CC_TERMINAL_ID 注入 + task.progress 会话归属 + 悬浮条直达。
 *
 *   1. env 注入实测：项目终端里 echo $env:CC_TERMINAL_ID → 输出 = 会话 id
 *      （P-20261025-1 标识切换：注入变量名 SC_TERMINAL_ID → CC_TERMINAL_ID，
 *      server/terminal/manager.go）
 *   2. 归属跳转：POST /api/ops-notify task.progress（带 terminalId）→
 *      悬浮条任务文本跟随 → 点击悬浮条 → 跳到该项目并激活对应 tab
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function getProjectId(request: APIRequestContext): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/projects`, { headers })
  const list = ((await res.json()) as { data?: { id: string; name: string }[] }).data || []
  const p = list.find(x => x.name === 'simple-coding')
  if (!p) throw new Error('simple-coding project not found')
  return p.id
}

/** 打开底部终端面板并新建一个 tab，返回会话 id（从 tab 的 DOM 关系不可得，走 API 反查） */
async function createBottomTerminal(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('.ide-rail .rail-btn[title="终端"]').click()
    await page.waitForTimeout(600)
  }
  await page.getByRole('button', { name: '新建终端' }).first().click()
  await page.locator('.term-container .xterm').locator('visible=true').first()
    .waitFor({ state: 'visible', timeout: 10000 })
}

/** 向可见 xterm 敲命令并等待其回显（PowerShell 回显含该行） */
async function typeIntoTerminal(page: Page, text: string) {
  await page.locator('.term-container .xterm').locator('visible=true').first().click()
  await page.keyboard.insertText(text)
}

test.describe('进度归属（P7）', () => {
  let projectId = ''
  let sessionId = ''

  test.beforeEach(async ({ page, request }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message.slice(0, 200)))
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('423')) console.log('[C-ERR]', m.text().slice(0, 160)) })
    page.on('framenavigated', f => { if (f === page.mainFrame()) console.log('[NAV]', page.url()) })
    projectId = await getProjectId(request)
    await fixedLocale(page)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await createBottomTerminal(page)
    // 反查刚创建的会话 id（server 列表里该项目的最新一条）
    const headers = await unlockHeaders(request)
    await page.waitForTimeout(500)
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; projectId?: string; createdAt: string }[] }).data || []
    const mine = list.filter(s => s.projectId === projectId).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    sessionId = mine[0]?.id || ''
    expect(sessionId).not.toBe('')
  })

  test.afterEach(async ({ request }) => {
    const headers = await unlockHeaders(request)
    const res = await request.get(`${BASE}/api/terminals`, { headers })
    const list = ((await res.json()) as { data?: { id: string; projectId?: string }[] }).data || []
    for (const s of list) {
      if (s.projectId === projectId) await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  })

  test('CC_TERMINAL_ID 注入实测：终端内 echo 输出会话 id', async ({ page }) => {
    page.on('pageerror', e => console.log('[PAGE-ERR]', e.message))
    page.on('console', m => { if (m.type() === 'error' && !m.text().includes('423')) console.log('[C-ERR]', m.text().slice(0, 200)) })
    // 注入变量名随 P-20261025-1 标识切换：SC_TERMINAL_ID → CC_TERMINAL_ID
    await typeIntoTerminal(page, 'echo $env:CC_TERMINAL_ID\r')
    // 会话 id 形如 agent-/term- 前缀 + 时间戳：等 PowerShell 回显（轮询 DOM 文本）
    const expected = sessionId
    await expect(async () => {
      const text = await page.evaluate(() =>
        [...document.querySelectorAll('.term-container .xterm-rows')].map(r => r.textContent || '').join(''),
      )
      expect(text).toContain(expected)
    }).toPass({ timeout: 20000 })
  })

  test('task.progress 带 terminalId → 悬浮条跟随 + 点击直达该会话', async ({ page, request }) => {
    // 打开管理页 → 收起为悬浮条（切形态）
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10000 })
    await view.locator('.atv-header-actions [title="收起为悬浮球"]').click()
    await expect(page.locator('.agm-root')).toBeVisible()
    await page.locator('.agm-root').click({ button: 'right' })
    await page.getByText('悬浮条', { exact: true }).click()
    await expect(page.locator('.agm-root.is-bar')).toBeVisible()

    // 归属上报：terminalId = 底部项目会话
    const headers = await unlockHeaders(request)
    await request.post(`${BASE}/api/ops-notify`, {
      headers,
      data: {
        type: 'task.progress',
        payload: { task: 'P7 归属测试', status: 'running', step: '验证中', terminalId: sessionId },
      },
    })

    // 悬浮条任务文本跟随归属会话的任务
    await expect(page.locator('.agm-root .agm-task')).toHaveText('P7 归属测试', { timeout: 10000 })

    // 点击悬浮条 → 直达该项目并激活对应 tab（悬浮组件收起）
    await page.locator('.agm-root.is-bar').click()
    await expect(page.locator('.agm-root')).toHaveCount(0, { timeout: 10000 })
    await expect(page).toHaveURL(/\/project/)
    await expect(page.locator('.term-container .xterm').locator('visible=true').first())
      .toBeVisible({ timeout: 15000 })
  })
})
