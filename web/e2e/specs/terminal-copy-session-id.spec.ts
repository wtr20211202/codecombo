import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 复制会话 ID（P-20261004-123）：terminalId 是协作协议的地址（agent 收件箱/
 * 接续链/ui.snapshot 归属/任务进度跳转全用它），UI 补复制出口——
 *   1. 终端 tab 右键「复制会话 ID」→ toast 确认 + 剪贴板含会话 ID
 *      （服务端权威：/api/terminals 按名定位本用例新建的会话，id 全等断言；
 *      copyText 在 secure context（localhost）走 async clipboard API，授权后
 *      可经 navigator.clipboard.readText() 断言落盘内容）
 *   2. 会话管理页行 tooltip 含会话 ID（悬停可见的核对出口，title 属性断言
 *      无需真实 hover）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE

interface SessionRow {
  id: string
  name: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(request: APIRequestContext, headers: Record<string, string>): Promise<SessionRow[]> {
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  return (((await res.json()) as { data?: SessionRow[] }).data) || []
}

/** 打开项目并归一化底部终端面板可见（面板开合是 uiState 持久态，随跑序而异） */
async function openProjectTerminal(page: Page) {
  await fixedLocale(page)
  // 剪贴板读写权限：copyText 在 secure context（localhost）走 async clipboard
  // API，授权后 e2e 可经 navigator.clipboard.readText() 断言落盘内容
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) return
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await expect(page.locator('.term-toolbar')).toBeVisible({ timeout: 5000 })
}

test('tab 右键复制会话 ID → toast 确认且剪贴板为该会话 ID（服务端权威）', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场基线：记录创建前会话 id，按名定位只认本用例新建的（不碰存量）
  const beforeIds = new Set((await listSessions(page.request as unknown as APIRequestContext, headers)).map(s => s.id))

  await openProjectTerminal(page)
  // 新建 tab（创建即激活，队尾）——目标会话名由此确定
  const before = await page.locator('.term-tab').count()
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 15_000 })
  const tabName = (await page.locator('.term-tab').last().locator('.term-tab-name').innerText()).trim()

  try {
    // 右键目标 tab → 「复制会话 ID」
    await page.locator('.term-tab').last().click({ button: 'right' })
    const copyItem = page.locator('[data-testid="terminal-copy-session-id"]')
    await expect(copyItem).toBeVisible({ timeout: 5000 })
    await expect(copyItem).toHaveText('复制会话 ID')
    await copyItem.click()

    // toast 确认（操作有反馈）
    await expect(page.locator('.n-message').filter({ hasText: '会话 ID 已复制' })).toBeVisible({ timeout: 5000 })

    // 剪贴板内容 = 服务端权威的该会话 ID（本用例新建会话按名定位，id 全等）
    const mine = (await listSessions(page.request as unknown as APIRequestContext, headers))
      .filter(s => !beforeIds.has(s.id))
    const created = mine.find(s => s.name === tabName)
    expect(created, `新建会话「${tabName}」应在服务端清单中`).toBeTruthy()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()), { timeout: 5000 })
      .toBe(created!.id)
  } finally {
    const after = await listSessions(page.request as unknown as APIRequestContext, headers)
    for (const s of after) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

test('会话管理页行 tooltip 含会话 ID（悬停核对出口）', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  const NAME = `sc-copy-id-tip-${Date.now()}`
  // API 直建一个命名会话（agent-runtime-version 同款载荷，侧栏会话树可见），
  // 行定位按名找
  const created = await page.request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', runtime: 'shell', name: NAME },
  })
  expect(created.ok()).toBeTruthy()
  const session = (await listSessions(page.request as unknown as APIRequestContext, headers))
    .find(s => s.name === NAME)
  expect(session, '创建的会话应出现在服务端清单中').toBeTruthy()

  try {
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    // 进项目页 → 打开终端会话管理（侧栏会话树宿主）
    await page.locator('.project-card').first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })

    // 行 tooltip（title 属性）恒显 ID 行：会话 ID 与服务端权威 id 全等
    // （id 逐字转义防正则元字符误吞——tmux 形 id 混有任意哈希段）
    const row = page.locator('.ats-item', { hasText: NAME }).first()
    await expect(row).toBeVisible({ timeout: 15000 })
    const escapedId = session!.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    await expect(row).toHaveAttribute('title', new RegExp(`会话 ID: ${escapedId}`))
  } finally {
    if (session) await page.request.delete(`${BASE}/api/terminals/${session.id}`, { headers })
  }
})
