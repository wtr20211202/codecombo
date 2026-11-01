import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 广播结果聚合面板（P-20261005-12）E2E：发 N 台看 N 台尾输出并排。
 * 1. 广播发送成功 → 结果面板自动展开一次；两目标单元格并排且尾部输出含命令回显。
 * 2. 「全部刷新」重拉：API 直发第二条命令（面板打开时不存在的输出）→ 刷新后
 *    出现在单元格——只有真重拉才能看到，排除首拉缓存假绿。
 * 3. 关闭面板（遮罩）→ 广播条「查看结果」钮重开。
 *
 * 失败/missing 灰态不在本 spec：UI 侧存活对账（P-288 既有护栏）会在发送前把
 * 已删除会话清出选中集，纯 UI 流程无法确定性构造回告失败态——灰态映射与
 * 不发请求的护栏由 TerminalBroadcastResultPanel.test.ts 组件测试覆盖。
 */

const MARKER1 = `sc-bc-result-a-${Date.now()}`
const MARKER2 = `sc-bc-result-b-${Date.now()}`

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

async function listSessions(request: import('@playwright/test').APIRequestContext): Promise<SessionRow[]> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const body = await res.json() as { data?: SessionRow[] }
  return body.data || []
}

test('广播发送后结果面板自动展开：两目标尾输出并排 + 刷新重拉 + 查看结果重开', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) throw new Error('simple-coding project not seeded')

  // 归一化前置：清掉字母序相邻 spec 遗留的本项目会话（tab 干扰计数与点选）
  for (const s of await listSessions(request)) {
    if (s.kind === 'shell' && s.projectId === proj.id) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }

  // 归一化：底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 预置两个 shell 会话并进入广播模式选中
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bcr-shell-a' } })
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bcr-shell-b' } })
  await expect(page.locator('.term-tab').filter({ hasText: 'bcr-shell-a' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.term-tab').filter({ hasText: 'bcr-shell-b' })).toBeVisible({ timeout: 10000 })
  await page.locator('[data-testid="terminal-broadcast-toggle"]').click()
  await expect(page.locator('[data-testid="terminal-broadcast-bar"]')).toBeVisible()
  await page.locator('.term-tab').filter({ hasText: 'bcr-shell-a' }).click()
  await page.locator('.term-tab').filter({ hasText: 'bcr-shell-b' }).click()
  await expect(page.locator('.term-tab.is-broadcast-selected')).toHaveCount(2)

  // ── 发送 → 面板自动展开一次，两目标并排 ──
  const bar = page.locator('[data-testid="terminal-broadcast-bar"]')
  await bar.locator('input').fill(`echo ${MARKER1}`)
  await bar.locator('input').press('Enter')
  const panel = page.locator('[data-testid="terminal-broadcast-result-panel"]')
  await expect(panel).toBeVisible({ timeout: 5000 })
  const cells = panel.locator('[data-testid="terminal-broadcast-result-cell"]')
  await expect(cells).toHaveCount(2)
  await expect(cells.filter({ hasText: 'bcr-shell-a' })).toBeVisible()
  await expect(cells.filter({ hasText: 'bcr-shell-b' })).toBeVisible()
  await expect(panel).toContainText('2 个目标 · 各显示尾部 50 行')

  // ── 尾输出含命令回显（广播后延时拉取已给命令留执行时间）；
  //    首拉若早于回显落盘，点「全部刷新」重拉补看 ──
  const refresh = panel.locator('[data-testid="terminal-broadcast-result-refresh"]')
  let got1 = false
  for (let i = 0; i < 8 && !got1; i++) {
    await page.waitForTimeout(600)
    if (await cells.filter({ hasText: MARKER1 }).count() === 2) {
      got1 = true
      break
    }
    await refresh.click()
  }
  expect(got1, '两目标单元格都应出现首条命令回显').toBe(true)

  // ── 刷新重拉（长命令二次回看）：面板打开后 API 直发第二条命令，只有真
  //    重拉才能看到 MARKER2——排除「断言的是首拉内容」的假绿 ──
  const sessions = (await listSessions(request)).filter(s => s.projectId === proj.id)
  expect(sessions).toHaveLength(2)
  await request.post(`${API_BASE}/api/terminals/broadcast-write`, {
    headers,
    data: { ids: sessions.map(s => s.id), data: `echo ${MARKER2}\r` },
  })
  let got2 = false
  for (let i = 0; i < 8 && !got2; i++) {
    await page.waitForTimeout(600)
    if (await cells.filter({ hasText: MARKER2 }).count() === 2) {
      got2 = true
      break
    }
    await refresh.click()
  }
  expect(got2, '全部刷新后两目标都应出现第二条命令回显').toBe(true)

  // ── 关闭面板（Esc）→「查看结果」钮重开 ──
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(bar).toBeVisible() // 广播模式仍在，回告区「查看结果」入口可用
  await bar.locator('[data-testid="terminal-broadcast-view-result"]').click()
  await expect(panel).toBeVisible()
  await expect(panel.locator('[data-testid="terminal-broadcast-result-cell"]')).toHaveCount(2)

  // 收尾：退出广播模式
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await bar.locator('.term-broadcast-exit').click()
  await expect(page.locator('[data-testid="terminal-broadcast-bar"]')).toHaveCount(0)
})
