import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话敏感内容自动检测建议 E2E（P-20261003-207）：导出动作落地后前端异步扫
 * 会话输出尾窗（P-197 同款模式集），命中且未标记弹「检测到疑似密钥——标记
 * 敏感?」——建议非闸门：标记入口走 P-155 sensitive 行操作链，可跳过不标记。
 *   1. 含密钥会话服务端导出（tab 右键「导出输出」）→ 服务端内容敏感闸
 *      「敏感内容出域确认」→ 确认后下载 → 建议提示出现 → 「标记敏感」→ 落库 +
 *      再次导出弹 P-155「敏感会话出域确认」闸门（建议→闸门闭环）
 *   2. 无密钥会话导出 → 零提示直出
 *   3. 含密钥会话客户端导出（pane 右键「导出文本」）→ 提示出现 → 「跳过」
 *      → 未标记（快照无 sensitive 键）；同会话再次导出不再重复提示
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE
const SECRET_CMD = 'echo token=e2ehintsecret42'
const PLAIN_CMD = 'echo plain-e2e-hint-42'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 终端 id 全集（清理用：测试前后 diff，只删本测试新建的会话） */
async function listTerminalIds(request: APIRequestContext): Promise<Set<string>> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  return new Set(list.map(s => s.id))
}

/** 测试前置：进项目页 + 归一终端面板可见（面板开合是 uiState 持久态） */
async function openProjectTerminalPanel(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await page.waitForTimeout(2500)
  await page.locator('.xterm-screen:visible').last().click()
}

/** 在当前活跃终端执行命令并等回显落缓冲 */
async function runCommand(page: import('@playwright/test').Page, cmd: string): Promise<void> {
  await page.keyboard.type(cmd)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(1500)
}

test('含密钥导出：建议提示出现 → 标记敏感落库 → 再导出弹 P-155 出域闸门', async ({ page }) => {
  test.setTimeout(120_000)
  const before = await listTerminalIds(page.request as unknown as APIRequestContext)
  try {
    await openProjectTerminalPanel(page)
    await runCommand(page, SECRET_CMD)

    // tab 右键「导出输出」→ 服务端内容敏感闸（P-20261004-113）先弹「敏感内容
    // 出域确认」（导出文本命中 token= 赋值形态）→ 确认后才开始下载 → 下载落地
    // 后异步扫描再弹客户端「检测到疑似密钥」建议。两道闸语义独立：前者是单次
    // 出域知情确认，后者是「把这个会话标记敏感」的策展建议
    const tab = page.locator('.term-tab').last()
    await tab.click({ button: 'right' })
    const exportItem = page.locator('[data-testid="terminal-export-output"]')
    await expect(exportItem).toBeVisible({ timeout: 3000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      exportItem.click(),
      (async () => {
        const gate = page.locator('.n-dialog').filter({ hasText: '敏感内容出域确认' })
        await expect(gate).toBeVisible({ timeout: 8000 })
        await gate.locator('.n-dialog__action button').filter({ hasText: '确认出域' }).click()
      })(),
    ])
    const dlg = page.locator('.n-dialog').filter({ hasText: '检测到疑似密钥' })
    await expect(dlg).toBeVisible({ timeout: 8000 })
    await download.cancel()

    // 「标记敏感」→ 成功 toast（标记入口走 P-155 sensitive 行操作链）
    await dlg.locator('.n-dialog__action button').filter({ hasText: '标记敏感' }).click()
    await expect(page.locator('.n-message').filter({ hasText: '已标记为敏感会话' })).toBeVisible({ timeout: 5000 })

    // 标记落库：快照携 sensitive（新增会话 = 前后 diff 唯一新增项）
    const after = await listTerminalIds(page.request as unknown as APIRequestContext)
    const created = [...after].filter(id => !before.has(id))
    expect(created).toHaveLength(1)
    const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
    const list = await page.request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string; sensitive?: boolean }[] }).data || []
    expect(sessions.find(s => s.id === created[0])?.sensitive).toBe(true)

    // 建议→闸门闭环：再次导出弹 P-155「敏感会话出域确认」→ 确认后放行下载
    await tab.click({ button: 'right' })
    await expect(page.locator('[data-testid="terminal-export-output"]')).toBeVisible({ timeout: 3000 })
    const [download2] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.locator('[data-testid="terminal-export-output"]').click(),
      (async () => {
        const gate = page.locator('.n-dialog').filter({ hasText: '敏感会话出域确认' })
        await expect(gate).toBeVisible({ timeout: 8000 })
        await gate.locator('.n-dialog__action button').filter({ hasText: '确认出域' }).click()
      })(),
    ])
    const path = await download2.path()
    expect(path).toBeTruthy()
  } finally {
    const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
    const list = await page.request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string }[] }).data || []
    for (const s of sessions.filter(s => !before.has(s.id))) {
      await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

test('无密钥导出：直出零提示', async ({ page }) => {
  test.setTimeout(120_000)
  const before = await listTerminalIds(page.request as unknown as APIRequestContext)
  try {
    await openProjectTerminalPanel(page)
    await runCommand(page, PLAIN_CMD)

    const tab = page.locator('.term-tab').last()
    await tab.click({ button: 'right' })
    const exportItem = page.locator('[data-testid="terminal-export-output"]')
    await expect(exportItem).toBeVisible({ timeout: 3000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      exportItem.click(),
    ])
    await download.cancel()
    // 扫描窗内无建议弹窗（也无出域闸门弹窗）——无命中零打扰
    await page.waitForTimeout(2000)
    await expect(page.locator('.n-dialog').filter({ hasText: '检测到疑似密钥' })).toHaveCount(0)
    await expect(page.locator('.n-dialog').filter({ hasText: '敏感会话出域确认' })).toHaveCount(0)
  } finally {
    const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
    const list = await page.request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string }[] }).data || []
    for (const s of sessions.filter(s => !before.has(s.id))) {
      await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})

test('客户端导出：提示后「跳过」不标记；同会话再次导出不再提示', async ({ page }) => {
  test.setTimeout(120_000)
  const before = await listTerminalIds(page.request as unknown as APIRequestContext)
  try {
    await openProjectTerminalPanel(page)
    await runCommand(page, SECRET_CMD)

    // pane 右键「导出文本」（xterm 缓冲直下链）→ 建议提示 → 「跳过」
    await page.locator('.xterm:visible').last().click({ button: 'right' })
    const textItem = page.locator('.term-context-item').filter({ hasText: '导出为文本' })
    await expect(textItem).toBeVisible({ timeout: 3000 })
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      textItem.click(),
    ])
    const dlg = page.locator('.n-dialog').filter({ hasText: '检测到疑似密钥' })
    await expect(dlg).toBeVisible({ timeout: 8000 })
    await dlg.locator('.n-dialog__action button').filter({ hasText: '跳过' }).click()
    await download.cancel()
    // 跳过零反馈零标记：无成功 toast
    await expect(page.locator('.n-message').filter({ hasText: '已标记为敏感会话' })).toHaveCount(0, { timeout: 3000 })

    // 未标记落库：快照该会话无 sensitive 键
    const after = await listTerminalIds(page.request as unknown as APIRequestContext)
    const created = [...after].filter(id => !before.has(id))
    expect(created).toHaveLength(1)
    const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
    const list = await page.request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string; sensitive?: boolean }[] }).data || []
    expect(sessions.find(s => s.id === created[0])?.sensitive).not.toBe(true)

    // 同会话再次客户端导出：本运行内不再重复提示（防骚扰边界），下载照常
    await page.locator('.xterm:visible').last().click({ button: 'right' })
    await expect(page.locator('.term-context-item').filter({ hasText: '导出为文本' })).toBeVisible({ timeout: 3000 })
    const [download2] = await Promise.all([
      page.waitForEvent('download', { timeout: 15_000 }),
      page.locator('.term-context-item').filter({ hasText: '导出为文本' }).click(),
    ])
    await download2.cancel()
    await page.waitForTimeout(2000)
    await expect(page.locator('.n-dialog').filter({ hasText: '检测到疑似密钥' })).toHaveCount(0)
    await expect(page.locator('.n-dialog').filter({ hasText: '敏感会话出域确认' })).toHaveCount(0)
  } finally {
    const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
    const list = await page.request.get(`${BASE}/api/terminals`, { headers })
    const sessions = ((await list.json()) as { data?: { id: string }[] }).data || []
    for (const s of sessions.filter(s => !before.has(s.id))) {
      await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})
