import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsLinux } from '../../tests/dualpath'

/**
 * 运行书服务端执行 API（P-20261004-108）E2E——运行书从 UI-only 变协议公民，
 * 全程无终端 pane（agent 面验证：页面只承担 ops-channel WS 探针）：
 *   1. agent 令牌带 params 跑两步参数化运行书（缺省新建独立执行会话）→
 *      响应逐步结果（插值后命令占位符零残留 + exitCode 0）+ scrollback 真执行
 *      + ops-channel WS 收到 task.progress 逐步进度（terminalId 归属 + runId
 *      扩展字段 + done 终态）+ agent-tasks 落库流可查
 *   2. onFailure=stop：失败步退出码如实上报（7）→ 停在失败项，第 3 步 skipped
 *   3. 缺参 → 400 runbook.params_missing，missing 清单按步骤出现序给出
 * 必败命令按服务端 shell 语义选（runbook-onfailure 同款对：win cmd / linux sh -c）。
 * 前置自备：运行书经 API 幂等播种（重试路径自愈）；无需项目（缺省执行会话不绑项目）。
 */

const BASE = API_BASE
const BOOK_TITLE = 'e2e 服务端执行参数化运行书'
const STOP_TITLE = 'e2e 服务端执行失败即停运行书'
const MISSING_TITLE = 'e2e 服务端执行缺参运行书-临时'
const SEEDED_TITLES = [BOOK_TITLE, STOP_TITLE, MISSING_TITLE]
const FAIL_CMD = serverIsLinux ? 'sh -c "exit 7"' : 'cmd /c exit 7'
const WORD = `w${Date.now()}`
const PLACE = 'prod-1'

let unlockToken = ''
let agentToken = ''

interface ApiResp { status: number; json: any }

async function api(method: string, url: string, body?: unknown, token = unlockToken): Promise<ApiResp> {
  // agent 令牌（sca_）与解锁令牌（scl_）同走 X-Lock-Token 头（LockMiddleware
  // 校验面；Authorization Bearer 是 sc_ access token 专用，携 sca_ 会被 401）
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Lock-Token': token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: res.status, json: await res.json().catch(() => null) }
}

async function cleanupRunbooks(): Promise<void> {
  const list = await api('GET', '/api/runbooks')
  for (const b of ((list.json?.data || []) as { id: string; title: string }[])) {
    if (SEEDED_TITLES.includes(b.title)) await api('DELETE', `/api/runbooks/${b.id}`)
  }
}

/** 幂等播种：同名运行书在位即复用（Playwright 重试路径自愈） */
async function ensureBook(title: string, commands: string[], onFailure?: string): Promise<string> {
  const list = await api('GET', '/api/runbooks')
  const mine = ((list.json?.data || []) as { id: string; title: string }[]).find(b => b.title === title)
  if (mine) return mine.id
  const res = await api('POST', '/api/runbooks', {
    title,
    ...(onFailure ? { onFailure } : {}),
    steps: commands.map(command => ({ command })),
  })
  expect([200, 201]).toContain(res.status)
  return res.json?.data?.id as string
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

/** 轮询会话 scrollback 直到出现标记（命令已执行的确定通道；git-activity 同款） */
async function waitForScrollback(sessionId: string, marker: string, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers: { 'X-Lock-Token': unlockToken } })
    if (res.ok) text = await res.text()
    if (stripAnsi(text).includes(marker)) return stripAnsi(text)
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`scrollback 未出现 ${marker}，末尾内容：${stripAnsi(text).slice(-400)}`)
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''
  await cleanupRunbooks()

  // agent 令牌明文（管理面 reveal，agent-ui-snapshot 同款）
  const revealed = await api('POST', '/api/agent-token/reveal')
  agentToken = revealed.json?.data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
})

test.afterAll(async () => {
  await cleanupRunbooks()
})

test('agent 令牌带 params 跑两步参数化运行书：占位符零残留 + 逐步执行 + 进度事件到达', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)

  const bookId = await ensureBook(BOOK_TITLE, [
    'echo sc-rra-{word}',
    'echo sc-rrb-{word}-{place}',
  ])

  // ops-channel 探针先注册（onopen ≈ 服务端 101 完成）再触发执行——
  // agent 令牌子协议可订阅（手册 ops-channel 节约定形态）。
  // 帧形态 {type, payload, source, ts}——与项目 WS busbridge 的 {type,data}
  // 包装不同源（git-activity 探针读 data，这里读 payload）
  await page.evaluate(({ token }) => {
    return new Promise<void>((resolve, reject) => {
      const w = window as unknown as { __rbProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }
      w.__rbProgress = []
      const ws = new WebSocket(`ws://${location.host}/ws/ops-channel`, [token])
      ws.onmessage = (ev) => {
        try {
          w.__rbProgress!.push(JSON.parse(ev.data as string))
        } catch { /* 忽略非 JSON 帧 */ }
      }
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('probe ws handshake failed'))
      setTimeout(() => reject(new Error('probe ws open timeout')), 10000)
    })
  }, { token: agentToken })

  // agent 令牌发起（X-Session-ID 照手册惯例携带，缺省目标 = 服务端新建执行现场）
  const run = await api('POST', `/api/runbooks/${bookId}/run`,
    { params: { word: WORD, place: PLACE } }, agentToken)
  expect(run.status).toBe(200)
  const data = run.json?.data ?? {}
  expect(data.status).toBe('completed')
  expect(data.degraded ?? false).toBeFalsy()
  const sessionId = data.sessionId as string
  expect(sessionId).toBeTruthy()
  expect(data.onFailure).toBe('continue')

  // 逐步结果：插值后命令占位符零残留 + 退出码判据在位
  const steps = data.steps as Array<{ index: number; command: string; status: string; exitCode?: number }>
  expect(steps).toHaveLength(2)
  expect(steps[0].command).toBe(`echo sc-rra-${WORD}`)
  expect(steps[1].command).toBe(`echo sc-rrb-${WORD}-${PLACE}`)
  for (const s of steps) {
    expect(s.command).not.toContain('{')
    expect(s.command).not.toContain('}')
    expect(s.status).toBe('done')
    expect(s.exitCode).toBe(0)
  }

  // 逐步真执行：独立执行会话 scrollback 两个标记都在
  await waitForScrollback(sessionId, `sc-rra-${WORD}`)
  await waitForScrollback(sessionId, `sc-rrb-${WORD}-${PLACE}`)

  // 进度事件到达（WS 广播面）：terminalId 归属 + runId 扩展字段 + done 终态
  await page.waitForFunction(
    (sid) => (window as unknown as { __rbProgress?: Array<{ type?: string; data?: Record<string, unknown> }> })
      .__rbProgress?.some(m => m?.type === 'task.progress' && (m.payload as any)?.terminalId === sid),
    sessionId,
    { timeout: 15000 },
  )
  const msgs = await page.evaluate(
    () => (window as unknown as { __rbProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }).__rbProgress ?? [],
  )
  const mine = msgs.filter(m => m.type === 'task.progress' && (m.payload as any)?.terminalId === sessionId)
  expect(mine.length).toBeGreaterThanOrEqual(2)
  for (const m of mine) {
    expect((m.payload as any).runId).toBe(data.runId)
    expect((m.payload as any).bookId).toBe(bookId)
    expect((m.payload as any).task).toContain(BOOK_TITLE.slice(0, 4))
  }
  const last = mine[mine.length - 1].payload as any
  expect(last.status).toBe('done')
  expect(Array.isArray(last.steps)).toBe(true)
  expect(last.steps).toHaveLength(2)
  expect(last.steps.every((s: { done: boolean }) => s.done === true)).toBe(true)

  // 进度落库面（agent-tasks 历史流可查——agentcron 式组合的消费通道）
  const tasks = await api('GET', `/api/agent-tasks?sessionId=${encodeURIComponent(sessionId)}&limit=50`)
  expect(tasks.status).toBe(200)
  const flow = (tasks.json?.data || []) as Array<{ type: string; status?: string }>
  expect(flow.some(t => t.type === 'task.progress' && t.status === 'done')).toBe(true)

  // 现场清理：独立执行会话不留给其他 spec
  await api('DELETE', `/api/terminals/${sessionId}`)
})

test('onFailure=stop：失败步退出码如实上报，停在失败项后续步骤 skipped', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)

  const bookId = await ensureBook(STOP_TITLE, [
    'echo sc-stop-ok',
    FAIL_CMD,
    'echo sc-stop-after',
  ], 'stop')

  const run = await api('POST', `/api/runbooks/${bookId}/run`, {}, agentToken)
  expect(run.status).toBe(200)
  const data = run.json?.data ?? {}
  expect(data.status).toBe('failed')
  expect(data.onFailure).toBe('stop')
  const steps = data.steps as Array<{ status: string; exitCode?: number; command?: string }>
  expect(steps).toHaveLength(3)
  expect(steps[0]).toMatchObject({ status: 'done', exitCode: 0 })
  expect(steps[1].status).toBe('failed')
  expect(steps[1].exitCode).toBe(7)
  expect(steps[2]).toMatchObject({ status: 'skipped' })
  expect(steps[2].command).toBe('') // 未发送即无插值命令（json 无 omitempty，空串形态）

  // 失败步之前的步骤真执行了；失败步之后的没发（屏上无其输出）
  const text = await waitForScrollback(data.sessionId, 'sc-stop-ok')
  expect(text).not.toContain('sc-stop-after')

  await api('DELETE', `/api/terminals/${data.sessionId}`)
})

test('缺参 → 400 runbook.params_missing，missing 清单按步骤出现序', async () => {
  const bookId = await ensureBook(MISSING_TITLE, ['echo {alpha} then {beta}'])
  // 本用例不产生会话；书清单即刻回收 + afterAll 兜底
  try {
    const run = await api('POST', `/api/runbooks/${bookId}/run`, { params: { beta: 'b' } }, agentToken)
    expect(run.status).toBe(400)
    expect(run.json?.code).toBe('runbook.params_missing')
    expect(run.json?.missing).toEqual(['alpha'])
  } finally {
    await api('DELETE', `/api/runbooks/${bookId}`)
  }
})
