import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 广播条输入历史（P-20261005-13）E2E：巡检命令组重复形态的 ↑ 一步回填。
 * 写入链打桩（真写入的端到端证明归 terminal-broadcast.spec）：聚焦出历史
 * 下拉（最新在顶）→ ↑/↓ 巡历（草稿可恢复）→ 再发去重置顶。
 * Ctrl+Alt+V 剪贴板历史正交属结构性事实（本提案零键位注册，且该键本就被
 * useLayoutKeyboard 的 vetoNonEditor 在 INPUT 焦点让位——两历史互不掺和），
 * 不在本 spec 断言别的子系统行为。
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

interface SessionRow { id: string; kind?: string; projectId?: string; name?: string }

test('广播输入历史：聚焦下拉两条 → ↑回填草稿恢复 → 再发清空入史 → 重发去重置顶 → 点选回填不直发', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) throw new Error('simple-coding project not seeded')

  // 归一化前置：清掉字母序相邻 spec 遗留的本项目会话（tab 干扰点选）
  for (const s of (await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()).data as SessionRow[]) {
    if (s.kind === 'shell' && s.projectId === proj.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }

  // 底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 两个 shell 会话 + 广播写入打桩（成功回告即入史，不依赖真 PTY 写入时序）
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bh-shell-a' } })
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bh-shell-b' } })
  await expect(page.locator('.term-tab').filter({ hasText: 'bh-shell-a' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.term-tab').filter({ hasText: 'bh-shell-b' })).toBeVisible({ timeout: 10000 })
  await page.route('**/api/terminals/broadcast-write', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: { written: 2, missing: [], failed: [], failedHosts: [] } }),
  }))

  // 广播模式 + 点选两 tab
  await page.locator('[data-testid="terminal-broadcast-toggle"]').click()
  const bar = page.locator('[data-testid="terminal-broadcast-bar"]')
  await expect(bar).toBeVisible()
  await page.locator('.term-tab').filter({ hasText: 'bh-shell-a' }).click()
  await page.locator('.term-tab').filter({ hasText: 'bh-shell-b' }).click()
  await expect(page.locator('.term-tab.is-broadcast-selected')).toHaveCount(2)

  const input = bar.locator('input')
  const historyPane = bar.locator('[data-testid="terminal-broadcast-history"]')

  /** 发送→同步→收面板：输入框清空 = doSend 成功块（入史+置面板）已跑完；再等
   *  结果面板挂载可见后 Esc 才有关可收（早 Esc 打在挂载前会空放，面板稍后
   *  展开会盖住广播条拦截点击——stale toast 同步不可靠，故弃）。结果面板自动
   *  展开会盖住广播条且带焦点陷阱，收起后再碰输入框（terminal-broadcast 同惯例） */
  async function sendAndSettle(text: string): Promise<void> {
    const panel = page.locator('[data-testid="terminal-broadcast-result-panel"]')
    await input.fill(text)
    await input.press('Enter')
    await expect(input).toHaveValue('')
    await expect(panel).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await expect(panel).toHaveCount(0)
  }

  // ── 广播两条命令：提交后输入框清空（入史在 composable 成功链）──
  await sendAndSettle('echo fleet-one')
  await sendAndSettle('echo fleet-two')

  // ── 聚焦出历史下拉两条：最新在顶（fleet-two → fleet-one）──
  await input.click()
  await expect(historyPane).toBeVisible()
  await expect(bar.locator('[data-testid="terminal-broadcast-history-item-0"]')).toHaveText('echo fleet-two')
  await expect(bar.locator('[data-testid="terminal-broadcast-history-item-1"]')).toHaveText('echo fleet-one')

  // ── ↑ 回填：最新一条先进框，再 ↑ 到更旧；↓ 走过头恢复上翻前草稿 ──
  await input.press('ArrowUp')
  await expect(input).toHaveValue('echo fleet-two')
  await input.press('ArrowUp')
  await expect(input).toHaveValue('echo fleet-one')
  await input.press('ArrowDown')
  await expect(input).toHaveValue('echo fleet-two')
  await input.press('ArrowDown')
  await expect(input).toHaveValue('')

  // ── 第三条命令入史：下拉三条、新条置顶（清空入史去重置顶形态）──
  await sendAndSettle('echo fleet-three')
  await input.click()
  await expect(bar.locator('[data-testid="terminal-broadcast-history-item-0"]')).toHaveText('echo fleet-three')
  await expect(bar.locator('.term-broadcast-history-item')).toHaveCount(3)

  // ── 重发既有命令：去重置顶不重复入账（仍三条、次序不变）；收面顺序同上 ──
  await input.press('ArrowUp')
  await expect(input).toHaveValue('echo fleet-three')
  await input.press('Enter')
  await expect(input).toHaveValue('')
  const panel = page.locator('[data-testid="terminal-broadcast-result-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await input.click()
  await expect(bar.locator('.term-broadcast-history-item')).toHaveCount(3)
  await expect(bar.locator('[data-testid="terminal-broadcast-history-item-0"]')).toHaveText('echo fleet-three')

  // ── 下拉点选回填：入框待发不直发（误点不等于要发）──
  await bar.locator('[data-testid="terminal-broadcast-history-item-2"]').click()
  await expect(input).toHaveValue('echo fleet-one')
  await expect(historyPane).toHaveCount(0)

  // ── 退出广播模式 ──
  await bar.locator('.term-broadcast-exit').click()
  await expect(page.locator('[data-testid="terminal-broadcast-bar"]')).toHaveCount(0)
})
