import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 多终端广播（P-20261003-288 舰队式批量输入）E2E：
 * 1. 两个 shell 会话 → 广播模式点选 → 广播输入条发同一条 echo → 两会话
 *    scrollback 都收到（服务端逐会话写入的端到端证明）。
 * 2. agent 会话默认不列：tab 栏不出现 agent tab；广播条 agent 勾选列表里
 *    它默认未勾选（显式勾选才参与），目标计数不因它的存在而变化。
 * 3. 远程主机分组（P-20261005-11）：popover 增「远程主机」组（主机别名徽标），
 *    显式勾选计入目标；发送请求混合本地+远程 id；failedHosts 回告映射为
 *    「失败主机」toast 段（远程断连哪台失败一目了然）。远程会话取数经
 *    page.route 打桩（真 SSH 拨号的实流归 Go 单测与 remote-console 实流域，
 *    remote-diag-compare 同款打桩惯例）。
 */

const MARKER = `sc-broadcast-${Date.now()}`
const REMOTE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90' // 32 hex，远程会话 id 形态

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

async function scrollbackContains(request: import('@playwright/test').APIRequestContext, id: string, marker: string): Promise<boolean> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals/${id}/scrollback`, { headers })
  if (!res.ok()) return false
  const text = (await res.body()).toString('utf8')
  return text.includes(marker)
}

test('广播输入：两个 shell 会话都收到；agent 会话默认不列', async ({ page, request }) => {
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

  // 预置两个 shell 会话（API 直建；terminals.changed 对账自动追加 tab 并自行连接）
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bc-shell-a' } })
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: proj.id, name: 'bc-shell-b' } })
  await expect(page.locator('.term-tab').filter({ hasText: 'bc-shell-a' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.term-tab').filter({ hasText: 'bc-shell-b' })).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.term-tab')).toHaveCount(2)

  // ── 广播模式：开关 → 点选两个 tab → 选中态出现 ──
  await page.locator('[data-testid="terminal-broadcast-toggle"]').click()
  await expect(page.locator('[data-testid="terminal-broadcast-bar"]')).toBeVisible()
  await page.locator('.term-tab').filter({ hasText: 'bc-shell-a' }).click()
  await page.locator('.term-tab').filter({ hasText: 'bc-shell-b' }).click()
  await expect(page.locator('.term-tab.is-broadcast-selected')).toHaveCount(2)

  // 目标计数 = 2（不足 2 时输入条为禁用态，此处应可发送）
  const bar = page.locator('[data-testid="terminal-broadcast-bar"]')
  await expect(bar).toContainText('广播到 2 个会话')

  // ── 广播发送：两会话 scrollback 都收到同一标记 ──
  await bar.locator('input').fill(`echo ${MARKER}`)
  await bar.locator('input').press('Enter')
  const sessions = (await listSessions(request)).filter(s => s.projectId === proj.id)
  expect(sessions).toHaveLength(2)
  for (const s of sessions) {
    let got = false
    for (let i = 0; i < 10 && !got; i++) {
      await page.waitForTimeout(600)
      got = await scrollbackContains(request, s.id, MARKER)
    }
    expect(got, `session ${s.name} scrollback should contain marker`).toBe(true)
  }

  // ── 结果聚合面板随发送自动展开一次（P-20261005-12）：先 Esc 收起再继续
  //    agent 勾选阶段——弹层遮住广播条，不收起点不到 agent 按钮 ──
  await page.keyboard.press('Escape')
  await expect(page.locator('[data-testid="terminal-broadcast-result-panel"]')).toHaveCount(0)

  // ── agent 会话默认不列：tab 栏不增（只列 kind=shell）；勾选列表默认未勾选 ──
  const agent = await (await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name: 'bc-agent-e2e', runtime: 'shell' },
  })).json() as { data?: { id?: string } }
  const agentId = agent?.data?.id
  if (!agentId) throw new Error('agent session create failed')
  try {
    await page.waitForTimeout(800) // terminals.changed 对账到齐后再断言 tab 数
    await expect(page.locator('.term-tab')).toHaveCount(2) // agent 不进底部 tab

    await bar.locator('.term-broadcast-agent-btn').click()
    const agentItem = page.locator('.term-broadcast-agent-item').filter({ hasText: 'bc-agent-e2e' })
    await expect(agentItem).toBeVisible({ timeout: 5000 })
    // 默认未勾选：checkbox 无 --checked 类；目标计数不变化（agent 不计入）
    await expect(agentItem.locator('.n-checkbox--checked')).toHaveCount(0)
    await expect(bar).toContainText('广播到 2 个会话')
    // 显式勾选后计入目标
    await agentItem.locator('.n-checkbox').click()
    await expect(bar).toContainText('广播到 3 个会话')
  } finally {
    await request.delete(`${API_BASE}/api/terminals/${agentId}`, { headers })
  }

  // ── 退出广播模式：输入条收起，点选态清空 ──
  await bar.locator('.term-broadcast-exit').click()
  await expect(page.locator('[data-testid="terminal-broadcast-bar"]')).toHaveCount(0)
  await expect(page.locator('.term-tab.is-broadcast-selected')).toHaveCount(0)
})

test('广播远程主机分组：popover 显式勾选计入目标，failedHosts 回告映射失败主机 toast', async ({ page }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')

  const REMOTE_B = 'b2c3d4e5f60718293a4b5c6d7e8f90a1'
  // 远程候选与广播写入双打桩（自足用例不依赖本地 tab：两台主机各一会话）：
  // 候选喂「远程主机」分组；写入捕获 ids 并回告 failedHosts（远程断连形态）
  let capturedIds: string[] = []
  await page.route('**/api/remotehosts/terminals', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ data: [
      { id: REMOTE_ID, hostId: 'sc_rh_e2e', host: '舰队-A', createdAt: '' },
      { id: REMOTE_B, hostId: 'sc_rh_e2b', host: '舰队-B', createdAt: '' },
    ] }),
  }))
  await page.route('**/api/terminals/broadcast-write', async route => {
    const req = route.request().postDataJSON() as { ids: string[] }
    capturedIds = req.ids
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          written: 0,
          missing: [],
          failed: [REMOTE_ID],
          failedHosts: [{ id: REMOTE_ID, hostId: 'sc_rh_e2e', host: '舰队-A' }],
        },
      }),
    })
  })

  // 底部终端面板可见 + 广播模式
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }
  await page.locator('[data-testid="terminal-broadcast-toggle"]').click()
  const bar = page.locator('[data-testid="terminal-broadcast-bar"]')
  await expect(bar).toBeVisible()

  // popover 出现「远程主机」分组：主机别名徽标 + 会话短 id，默认未勾选
  await bar.locator('.term-broadcast-agent-btn').click()
  const itemA = page.locator('.term-broadcast-agent-item').filter({ hasText: '舰队-A' })
  const itemB = page.locator('.term-broadcast-agent-item').filter({ hasText: '舰队-B' })
  await expect(page.locator('.term-broadcast-group-head').filter({ hasText: '远程主机' })).toBeVisible()
  await expect(itemA.locator('.term-broadcast-host-badge')).toHaveText('舰队-A')
  await expect(itemA.locator('.n-checkbox--checked')).toHaveCount(0)

  // 勾选两台远程会话 → 目标计数 = 2（可发送门槛）
  await itemA.locator('.n-checkbox').click()
  await itemB.locator('.n-checkbox').click()
  await expect(bar).toContainText('广播到 2 个会话')

  // 发送：请求携带两个远程 id；回告 failedHosts → toast 附「失败主机：舰队-A」
  await bar.locator('input').fill('uptime')
  await bar.locator('input').press('Enter')
  await expect(page.locator('.n-message')).toContainText('失败主机：舰队-A', { timeout: 5000 })
  expect(capturedIds).toEqual([REMOTE_ID, REMOTE_B])
})
