import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端后台 tab 未读活动点（P-20261003-310）E2E：
 * 1. 后台会话输出 → 活跃 tab 之外出现未读点 → 切换激活 → 点消失；
 *    活跃会话自身输出不点亮（可见抑制）。
 * 2. task.progress 终态（done/failed）到达且属后台 agent 会话 → 管理页侧栏
 *    会话行未读点亮 → 点选会话 → 点消失；可见会话终态不点亮。
 *
 * 输出驱动走 broadcast-write（用户令牌，写入 PTY 输入由 shell echo 产生真实
 * 输出，全链路经 WS → xterm 写入路径）；终态驱动走 ops-notify（解锁令牌，
 * compare-experiment 同款先例）。
 */

const MARKER = `sc-unread-${Date.now()}`

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

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const headers = await unlockHeaders()
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const body = await res.json() as { data?: SessionRow[] }
  return body.data || []
}

/** 向指定会话写入一段 PTY 输入（尾部 \r 执行） */
async function writeInput(request: APIRequestContext, id: string, data: string): Promise<void> {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/terminals/broadcast-write`, {
    headers,
    data: { ids: [id], data },
  })
  expect(res.ok()).toBeTruthy()
}

/** 上报 task.progress 终态（解锁令牌可调，ops-channel 广播前端消费） */
async function reportProgress(request: APIRequestContext, terminalId: string, status: string): Promise<void> {
  const headers = await unlockHeaders()
  const res = await request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'task.progress', payload: { task: 'e2e-unread', status, terminalId } },
  })
  expect(res.ok()).toBeTruthy()
}

async function openProject(page: import('@playwright/test').Page, request: APIRequestContext): Promise<string> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  const headers = await unlockHeaders()
  const plist = await (await request.get(`${API_BASE}/api/projects`, { headers })).json()
  const proj = ((plist?.data || []) as { id: string; name: string }[]).find(x => x.name === 'simple-coding')
  if (!proj) throw new Error('simple-coding project not seeded')
  return proj.id
}

test('后台会话输出点亮 tab 未读点，激活即清；活跃会话不点亮', async ({ page, request }) => {
  const projId = await openProject(page, request)
  const headers = await unlockHeaders()

  // 归一化前置：清掉字母序相邻 spec 遗留的本项目 shell 会话
  for (const s of await listSessions(request)) {
    if (s.kind === 'shell' && s.projectId === projId) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }

  // 归一化：底部终端面板可见
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
    await page.locator('[data-testid="rail-terminal"]').click()
    await page.waitForTimeout(600)
  }

  // 预置两个 shell 会话（terminals.changed 对账自动追加 tab 并自行连接）
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: projId, name: 'unread-shell-a' } })
  await request.post(`${API_BASE}/api/terminals`, { headers, data: { projectId: projId, name: 'unread-shell-b' } })
  const tabA = page.locator('.term-tab').filter({ hasText: 'unread-shell-a' })
  const tabB = page.locator('.term-tab').filter({ hasText: 'unread-shell-b' })
  await expect(tabA).toBeVisible({ timeout: 10000 })
  await expect(tabB).toBeVisible({ timeout: 10000 })
  await expect(page.locator('.term-tab')).toHaveCount(2)
  const sessions = (await listSessions(request)).filter(s => s.projectId === projId && s.kind === 'shell')
  const idA = sessions.find(s => s.name === 'unread-shell-a')?.id
  if (!idA) throw new Error('unread-shell-a not found')

  // 等两会话 WS 建立完毕：xterm 已挂载（两 pane 均有 .xterm-screen）且连接中
  // loading 全部退场——loading 只在 WS onopen 隐藏。之后须越过未读点亮闸的
  // 附着稳定窗（R 哨兵 +1.2s，盖过 tmux/conpty 的 attach 自发重绘字节），
  // 此后写入的输出才参与点亮
  await expect.poll(async () => {
    const screens = await page.locator('.xterm-screen').count()
    const loading = await page.locator('.term-pane-loading').count()
    return screens >= 2 && loading === 0
  }, { timeout: 20000 }).toBe(true)
  await page.waitForTimeout(1700)

  // 激活 b：a 成为后台 tab
  await tabB.click()
  await expect(tabB).toHaveClass(/is-active/)

  // 初始无未读点（新会话初始输出发生在创建时，附着时经重放落在 R 哨兵之前）
  await expect(page.locator('[data-testid="term-tab-unread"]')).toHaveCount(0)

  // 向后台会话 a 写入 echo：活跃 tab 之外出现未读点
  await writeInput(request, idA, `echo ${MARKER}\r`)
  await expect(tabA.locator('[data-testid="term-tab-unread"]')).toBeVisible({ timeout: 10000 })

  // 切换激活 a：未读点清除
  await tabA.click()
  await expect(tabA).toHaveClass(/is-active/)
  await expect(tabA.locator('[data-testid="term-tab-unread"]')).toHaveCount(0)

  // 活跃会话自身输出不点亮（可见抑制）：等足一轮 WS 往返仍无点
  await writeInput(request, idA, `echo ${MARKER}-active\r`)
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-testid="term-tab-unread"]')).toHaveCount(0)
})

test('task.progress 终态点亮后台 agent 会话未读点，点选即清', async ({ page, request }) => {
  await openProject(page, request)
  const headers = await unlockHeaders()

  // 两个 agent 会话（runtime=shell 纯终端，不与 TUI 交互）；同名遗留先清
  for (const s of await listSessions(request)) {
    if (s.kind === 'agent' && (s.name === 'unread-agent-a' || s.name === 'unread-agent-b')) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  }
  const ra = await (await request.post(`${API_BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'unread-agent-a', runtime: 'shell' },
  })).json() as { data?: { id?: string } }
  const rb = await (await request.post(`${API_BASE}/api/terminals`, {
    headers, data: { kind: 'agent', name: 'unread-agent-b', runtime: 'shell' },
  })).json() as { data?: { id?: string } }
  const idA = ra?.data?.id
  const idB = rb?.data?.id
  if (!idA || !idB) throw new Error('agent session create failed')
  try {
    // 打开 agent 管理页（docked）：恢复的持久化状态可能已开着，关闭基线归一
    if (!(await page.locator('.atv-root').isVisible().catch(() => false))) {
      await page.locator('[data-testid="rail-agent-terminal"]').click()
    }
    await expect(page.locator('.atv-root')).toBeVisible({ timeout: 10000 })
    // 侧栏可能被 uiState 持久化为折叠：展开归一
    if (!(await page.locator('.atv-sidebar').isVisible().catch(() => false))) {
      await page.locator('button[title="展开侧栏"]').click()
    }
    const rowA = page.locator('.ats-item').filter({ hasText: 'unread-agent-a' })
    const rowB = page.locator('.ats-item').filter({ hasText: 'unread-agent-b' })
    await expect(rowA).toBeVisible({ timeout: 10000 })
    await expect(rowB).toBeVisible({ timeout: 10000 })

    // 选中 a（b 为后台：无 pane 挂载，终态点亮走 ops-channel 链而非输出钩子）
    await rowA.click()
    await expect(page.locator('[data-testid="term-tab-unread"], .ats-item-unread')).toHaveCount(0)

    // done 终态到达后台会话 b：侧栏行未读点亮
    await reportProgress(request, idB, 'done')
    await expect(rowB.locator('.ats-item-unread')).toBeVisible({ timeout: 10000 })

    // 点选 b：未读点清除
    await rowB.click()
    await expect(rowB.locator('.ats-item-unread')).toHaveCount(0)

    // 可见会话终态不点亮：对当前选中的 b 上报 failed，无点
    await reportProgress(request, idB, 'failed')
    await page.waitForTimeout(1500)
    await expect(page.locator('.ats-item-unread')).toHaveCount(0)
  } finally {
    await request.delete(`${API_BASE}/api/terminals/${idA}`, { headers }).catch(() => {})
    await request.delete(`${API_BASE}/api/terminals/${idB}`, { headers }).catch(() => {})
  }
})
