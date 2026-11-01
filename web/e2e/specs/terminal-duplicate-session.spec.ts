import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端「复制会话」E2E（P-20261004-1）：tab 右键复制 → 同配置新会话并激活。
 * 对照试验「原会话保持现场、新会话跑试验命令」的一步化（原路径 = 记住源会话
 * 配置手动新建）。复制的是创建配置而非运行现场：
 *   1. UI 链路：tab 右键「复制会话」→ 新 tab 出现（名字 = 源名 + 「副本」后缀）
 *      且创建即激活
 *   2. 配置一致（服务端权威）：新会话 kind/path 与源会话一致——shell 副本 dir
 *      由服务端按项目解析，与源同目录（非 shell 内 cd 后目录，本用例未 cd 同语义）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || API_BASE

interface SessionRow {
  id: string
  name: string
  kind: string
  path: string
}

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 打开项目并归一化底部终端面板可见（面板开合是 uiState 持久态，随跑序而异） */
async function openProjectTerminal(page: Page) {
  await fixedLocale(page)
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

async function listSessions(request: APIRequestContext, headers: Record<string, string>): Promise<SessionRow[]> {
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  return (((await res.json()) as { data?: SessionRow[] }).data) || []
}

test('tab 右键复制会话 → 新会话出现（副本名）且 kind/path 与源一致并激活', async ({ page }) => {
  test.setTimeout(120_000)
  const headers = await unlockHeaders(page.request as unknown as APIRequestContext)
  // 清场基线：记录创建前会话 id，finally 只删本用例新建的（不碰存量）
  const beforeIds = new Set((await listSessions(page.request as unknown as APIRequestContext, headers)).map(s => s.id))

  await openProjectTerminal(page)
  // 新建源 tab（创建即激活，队尾）
  const before = await page.locator('.term-tab').count()
  await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
  await expect(page.locator('.term-tab')).toHaveCount(before + 1, { timeout: 15_000 })
  const sourceName = (await page.locator('.term-tab').last().locator('.term-tab-name').innerText()).trim()

  try {
    // 右键源 tab → 「复制会话」
    await page.locator('.term-tab').last().click({ button: 'right' })
    const dupItem = page.locator('[data-testid="terminal-duplicate-tab"]')
    await expect(dupItem).toBeVisible({ timeout: 5000 })
    await expect(dupItem).toHaveText('复制会话')
    await dupItem.click()

    // 新 tab 出现（+1）且创建即激活：is-active 落在副本名上
    await expect(page.locator('.term-tab')).toHaveCount(before + 2, { timeout: 15_000 })
    const copyName = `${sourceName} 副本`
    await expect(page.locator('.term-tab.is-active .term-tab-name')).toHaveText(copyName, { timeout: 5000 })

    // 配置一致（服务端权威）：本用例新建的会话里，副本与源 kind/path 全等
    const mine = (await listSessions(page.request as unknown as APIRequestContext, headers)).filter(s => !beforeIds.has(s.id))
    const src = mine.find(s => s.name === sourceName)
    const copy = mine.find(s => s.name === copyName)
    expect(src, '源会话应在服务端清单中').toBeTruthy()
    expect(copy, '副本会话应在服务端清单中').toBeTruthy()
    expect(copy!.kind).toBe('shell')
    expect(copy!.kind).toBe(src!.kind)
    expect(copy!.path).toBe(src!.path)
  } finally {
    const after = await listSessions(page.request as unknown as APIRequestContext, headers)
    for (const s of after) {
      if (!beforeIds.has(s.id)) await page.request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
    }
  }
})
