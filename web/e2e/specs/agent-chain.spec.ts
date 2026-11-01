import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 会话接续链 E2E（P-20261004-38）：
 * 触发档位/冷却/深度上限/死链/占位符渲染由 Go 单测锁定（server/api/agentchain），
 * 本用例锁真实服务端全链路——建会话（shell）→ 建链 → 经 ops-notify 上报
 * task.progress 终态（模拟智能体回执，观察者直驱非巡检，事件返回即已触发）：
 *   1. done → 新会话自动拉起且 prompt 占位符已渲染（会话摘要名含渲染后文案）
 *      + 通知中心入账（「A 已完成，B 已接续」）
 *   2. failed → onFailure=false 不触发（零新会话）；冷却窗口内抖动重入只拉起一次
 *   3. 深度上限：A→B→C 三棒合法，C 的完成不再接续第 4 棒
 *
 * 摘要名口径注记：会话名 = prompt 首行截 24 rune（terminal.promptSessionNameMax），
 * 模板 marker 全部用 6 位短戳（渲染结果落在截断窗口内，断言片段可被名字包含）。
 * 会话与链经共享实例 API 清理，不残留。
 */

const PREFIX = 'e2e-ac'

interface SessionInfo { id?: string; name?: string; kind?: string }
interface ChainItem { id?: string; sourceTerminalId?: string; promptTemplate?: string; lastSessionId?: string; lastStatus?: string; triggerCount?: number }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(headers: Record<string, string>): Promise<SessionInfo[]> {
  const res = await fetch(`${API_BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: SessionInfo[] }).data || []
}

async function listChains(headers: Record<string, string>): Promise<ChainItem[]> {
  const res = await fetch(`${API_BASE}/api/agent-chains`, { headers })
  return ((await res.json()) as { data?: ChainItem[] }).data || []
}

async function cleanup() {
  const headers = await unlockHeaders()
  // 按模板前缀圈定（本 spec 的链模板必含 PREFIX），不误删同实例其他用例的数据
  for (const c of await listChains(headers)) {
    if (c.id && c.promptTemplate?.includes(PREFIX)) {
      await fetch(`${API_BASE}/api/agent-chains/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  for (const s of await listSessions(headers)) {
    if (s.name?.includes(PREFIX) && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

/** 建 shell 会话（prompt 即命令，会话摘要名 = prompt 首行，供断言定位） */
async function createSession(headers: Record<string, string>, prompt: string): Promise<SessionInfo> {
  const res = await fetch(`${API_BASE}/api/terminals`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ kind: 'agent', runtime: 'shell', launchArgs: prompt }),
  })
  expect(res.ok).toBeTruthy()
  return ((await res.json()) as { data?: SessionInfo }).data || {}
}

async function createChain(
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; data?: ChainItem; error?: string }> {
  const res = await fetch(`${API_BASE}/api/agent-chains`, { method: 'POST', headers, body: JSON.stringify(body) })
  const json = (await res.json()) as { data?: ChainItem; error?: string }
  return { ok: res.ok, data: json.data, error: json.error }
}

/** 模拟智能体回执：task.progress 终态（观察者直驱，事件返回时触发已发生） */
async function reportProgress(headers: Record<string, string>, terminalId: string, status: string, task: string, step: string) {
  const res = await fetch(`${API_BASE}/api/ops-notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'task.progress', payload: { task, status, step, terminalId } }),
  })
  expect(res.ok).toBeTruthy()
}

/** 等名称含片段的 agent 会话出现（触发是事件直驱，仍留轮询吸收 PTY 创建时延） */
async function waitSessionByName(headers: Record<string, string>, fragment: string, timeoutMs = 15_000): Promise<SessionInfo | undefined> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const hit = (await listSessions(headers)).find(s => s.kind === 'agent' && s.name?.includes(fragment))
    if (hit?.id) return hit
    await new Promise(r => setTimeout(r, 500))
  }
  return undefined
}

test.describe('agent session chain', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('done 触发：占位符渲染拉起下一棒 + 通知入账 + 列表触发事实', async () => {
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const src = await createSession(headers, `echo ${PREFIX}1-${stamp}`)
    expect(src.id).toBeTruthy()

    // 模板占位符渲染结果进入会话摘要名（首行 ≤24 rune——marker+done+task 合计 14 rune）
    const template = `${PREFIX}1-${stamp}-{prevStatus}-{prevTask}`
    const created = await createChain(headers, {
      sourceTerminalId: src.id,
      promptTemplate: template,
      runtime: 'shell',
    })
    expect(created.ok, `create chain failed: ${created.error}`).toBeTruthy()
    expect(created.data?.id).toBeTruthy()

    // 创建时点源会话不在册：400（死链不进库）
    const ghost = await createChain(headers, { sourceTerminalId: 'agent-ghost-id', promptTemplate: 'x' })
    expect(ghost.ok).toBeFalsy()
    expect(ghost.error).toContain('source session not found')

    // 源会话上报 done → 下一棒自动拉起，占位符已渲染（摘要名含 status 与 task 值）
    reportProgress(headers, src.id!, 'done', '跑测试', '3 个用例失败')
    const next = await waitSessionByName(headers, `${PREFIX}1-${stamp}-done-跑测试`)
    expect(next, 'chain should launch the next session on done').toBeTruthy()

    // 通知入账：chain 通知 + Action 直达下一棒 + 链源终态进 msgParams
    await expect.poll(async () => {
      const res = await fetch(`${API_BASE}/api/notifications`, { headers })
      const items = ((await res.json()) as { data?: Array<{ titleKey?: string; actionPayload?: string; msgParams?: Record<string, string> }> }).data || []
      const hit = items.find(n => n.titleKey === 'agentchain.notify.triggered.title' && n.actionPayload === next!.id)
      return hit ? (hit.msgParams?.status ?? '') : ''
    }).toBe('done')

    // 链列表触发事实：lastSessionId 指向下一棒、lastStatus=launched、计数 1
    const chain = (await listChains(headers)).find(c => c.id === created.data!.id)
    expect(chain?.lastSessionId).toBe(next!.id)
    expect(chain?.lastStatus).toBe('launched')
    expect(chain?.triggerCount).toBe(1)
  })

  test('failed 不触发（onFailure 默认关）+ 冷却窗口内抖动重入只拉起一次', async () => {
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const src = await createSession(headers, `echo ${PREFIX}2-${stamp}`)
    const created = await createChain(headers, {
      sourceTerminalId: src.id,
      promptTemplate: `${PREFIX}2-${stamp}-{prevStatus}`,
      runtime: 'shell',
    })
    expect(created.ok).toBeTruthy()

    // failed：默认档不触发（排除源会话自身——其名字本就含 marker）
    reportProgress(headers, src.id!, 'failed', '构建', '编译错误')
    await new Promise(r => setTimeout(r, 2000))
    const nextsAfterFailed = (await listSessions(headers))
      .filter(s => s.name?.includes(`${PREFIX}2-${stamp}`) && s.id !== src.id)
    expect(nextsAfterFailed, 'failed must not trigger (default gate)').toHaveLength(0)

    // done 触发一次后，冷却窗口内的同源 done（收尾抖动重入）不重复拉起
    reportProgress(headers, src.id!, 'done', '构建', '完成')
    const first = await waitSessionByName(headers, `${PREFIX}2-${stamp}-done`)
    expect(first).toBeTruthy()
    reportProgress(headers, src.id!, 'done', '构建', '完成（抖动重报）')
    await new Promise(r => setTimeout(r, 2000))
    const hits = (await listSessions(headers))
      .filter(s => s.name?.includes(`${PREFIX}2-${stamp}`) && s.id !== src.id)
    expect(hits.length, 'cooldown must dedupe jittered re-entry').toBe(1)
  })

  test('深度上限：A→B→C 三棒合法，C 的完成不再接续', async () => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const mk = (n: string) => `${PREFIX}3${n}-${stamp}`

    // 第 1 棒：用户会话 A + 链 A
    const a = await createSession(headers, `echo ${mk('a')}`)
    const chainA = await createChain(headers, {
      sourceTerminalId: a.id,
      promptTemplate: `${mk('b')}-{prevStatus}`,
      runtime: 'shell',
    })
    expect(chainA.ok).toBeTruthy()

    // A done → B 拉起；在 B 上建链（接力棒续给第 3 棒）
    reportProgress(headers, a.id!, 'done', 'A', '')
    const b = await waitSessionByName(headers, `${mk('b')}-done`)
    expect(b, 'hop 1: B should launch').toBeTruthy()
    const chainB = await createChain(headers, {
      sourceTerminalId: b!.id,
      promptTemplate: `${mk('c')}-{prevStatus}`,
      runtime: 'shell',
    })
    expect(chainB.ok).toBeTruthy()

    // B done → C 拉起；在 C 上建链（第 4 棒——必须被深度上限拒绝）
    reportProgress(headers, b!.id!, 'done', 'B', '')
    const c = await waitSessionByName(headers, `${mk('c')}-done`)
    expect(c, 'hop 2: C should launch').toBeTruthy()
    const chainC = await createChain(headers, {
      sourceTerminalId: c!.id,
      promptTemplate: `${mk('d')}-{prevStatus}`,
      runtime: 'shell',
    })
    expect(chainC.ok).toBeTruthy()
    reportProgress(headers, c!.id!, 'done', 'C', '')
    await new Promise(r => setTimeout(r, 3000))
    expect(
      (await listSessions(headers)).find(s => s.name?.includes(mk('d'))),
      'depth cap 3 must stop the relay at hop 3',
    ).toBeUndefined()
  })

  test('UI：会话行右键「完成后接续…」建链 + 头部「接续链」面板管理', async ({ page }) => {
    test.setTimeout(120_000)
    const headers = await unlockHeaders()
    const stamp = String(Date.now()).slice(-6)
    const src = await createSession(headers, `echo ${PREFIX}4-${stamp}`)
    expect(src.id).toBeTruthy()

    await fixedLocale(page)
    await page.addInitScript(() => {
      localStorage.removeItem('sc.agentTerminal.openState')
    })
    await gotoAndUnlock(page, `${API_BASE}/`)
    await page.locator('.project-card').filter({ hasText: 'simple-coding' }).first().click()
    await page.waitForURL('**/project')
    await page.locator('.rail-btn[title="终端会话管理"]').click()
    const view = page.locator('.atv-root')
    await expect(view).toBeVisible({ timeout: 10_000 })

    // 头部「接续链」入口开面板（空态可见即冒烟；数据行断言在下方建链后回看）
    await view.locator('[data-testid="agent-chain-entry"]').click()
    const panel = page.locator('[data-testid="agentchain-panel"]')
    await expect(panel).toBeVisible({ timeout: 5000 })
    await page.keyboard.press('Escape')

    // 会话行右键 → 「完成后接续…」→ 弹层填模板创建
    const row = view.locator('.ats-item', { hasText: `${PREFIX}4-${stamp}` }).first()
    await expect(row).toBeVisible({ timeout: 10_000 })
    await row.click({ button: 'right' })
    await page.locator('.n-dropdown-menu').getByText('完成后接续…', { exact: true }).click()
    const dlg = page.locator('[data-testid="agentchain-dialog"]')
    await expect(dlg).toBeVisible({ timeout: 5000 })
    await dlg.locator('[data-testid="agentchain-template"] textarea').fill(`${PREFIX}4-${stamp}-ui-{prevStatus}`)
    await dlg.locator('[data-testid="agentchain-confirm"]').click()
    await expect(dlg).toBeHidden({ timeout: 5000 })

    // 链真实落库（UI → API 集成）：源会话指向 + 模板原文
    await expect.poll(async () =>
      (await listChains(headers)).find(c => c.sourceTerminalId === src.id)?.promptTemplate ?? '',
    ).toBe(`${PREFIX}4-${stamp}-ui-{prevStatus}`)

    // 重开面板：新链以源会话名入列（死亡置灰/删除钮在 DOM 层由 dead 类承载）
    await view.locator('[data-testid="agent-chain-entry"]').click()
    await expect(panel).toBeVisible({ timeout: 5000 })
    await expect(panel.locator('.acp-item').filter({ hasText: `${PREFIX}4-${stamp}` })).toBeVisible({ timeout: 5000 })
  })
})
