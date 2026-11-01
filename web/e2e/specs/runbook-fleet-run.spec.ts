import { test, expect } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverIsLinux } from '../../tests/dualpath'

/**
 * 舰队运行书执行（P-20261005-147）E2E——广播×步骤×完成聚合编排引擎全链：
 *   1. 两伪目标（纯 shell 会话，OSC 133 在位）× 三步含中途失败停：
 *      fleet-run 逐步逐目标矩阵（exitCode 聚合）+ onFailure=stop 停在失败步
 *      （哪台哪步在 failed 格）+ 第三步 skipped；
 *      无 OSC133 目标（会话级 shell 覆盖 sh/cmd.exe——shellint.Setup 不支持
 *      的 shell 无集成注入）降级：不等待即时完成 + noSignal 诚实标注；
 *      fleet 扩展 task.progress 批事件（start 建骨架/step 逐格/final 终态）
 *      经 ops-channel WS 可订阅 + agent-tasks 落库流可查
 *   2. 失败步单台重试：条件失败命令（标记文件存在即 0 否则 7）——首跑失败后
 *      广播建标记，单台重试该格 → 格 done exit 0，run 重算 completed（skipped
 *      行不参与重算面）
 *   3. 手动中止：sleep 类长命令在途时 fleet-abort → 未完成目标收 \x03、格
 *      aborted、终态快照同步返回
 * 前置自备：运行书经 API 幂等播种（重试路径自愈）；伪目标 = kind=agent
 * runtime=shell 会话（免 claude 二进制依赖），用毕清理。
 */

const BASE = API_BASE
const RUN_TITLE = 'e2e 舰队运行书-失败停'
const ABORT_TITLE = 'e2e 舰队运行书-中止'
const SEEDED_TITLES = [RUN_TITLE, ABORT_TITLE]
const WORD = `w${Date.now()}`
const MARKER = `sc-fleet-marker-${WORD}`
const FAIL_CMD = serverIsLinux
  ? `[ -f ${MARKER} ] && exit 0 || exit 7`
  : `cmd /c "if exist ${MARKER} (exit 0) else (exit 7)"`
const SLEEP_CMD = serverIsLinux ? 'sleep 30' : 'ping -n 30 127.0.0.1'
const MARKER_TOUCH = serverIsLinux ? `touch ${MARKER}` : `cmd /c "type nul > ${MARKER}"`
const MARKER_RM = serverIsLinux ? `rm -f ${MARKER}` : `cmd /c "del /q ${MARKER}"`

let unlockToken = ''
let agentToken = ''
const sessionIds: string[] = []

interface ApiResp { status: number; json: any }

async function api(method: string, url: string, body?: unknown, token = unlockToken): Promise<ApiResp> {
  // agent 令牌（sca_）与解锁令牌（scl_）同走 X-Lock-Token 头（LockMiddleware
  // 校验面）——fleet-runbook 非 AgentGuard 高危表（存稿执行同 runbook run 取态），
  // agent 令牌直调即达
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

/** 幂等播种（Playwright 重试路径自愈） */
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

/** 伪目标：kind=agent + runtime=shell 纯 shell 会话（OSC 133 在位，退出码可判）；
 *  bare=true 时经会话级 shell 覆盖换 shellint 不支持的 shell（sh/cmd.exe）——
 *  无 OSC 133 注入 = 无确认信号目标。会话创建/广播走用户令牌（broadcast-write
 *  是 AgentGuard 高危面，agent 令牌会被 428 审批闸挡下）；fleet 端点走 agent
 *  令牌（智能体操作面演练，非高危表直调即达） */
async function createTarget(name: string, bare = false): Promise<string> {
  const res = await api('POST', '/api/terminals', {
    kind: 'agent',
    runtime: 'shell',
    name,
    ...(bare ? { shell: serverIsLinux ? 'sh' : 'cmd.exe' } : {}),
  })
  expect(res.status).toBe(200)
  const id = res.json?.data?.id as string
  expect(id).toBeTruthy()
  sessionIds.push(id)
  return id
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
}

async function scrollback(sessionId: string): Promise<string> {
  const res = await fetch(`${BASE}/api/terminals/${sessionId}/scrollback`, { headers: { 'X-Lock-Token': unlockToken } })
  return stripAnsi(await res.text())
}

test.beforeAll(async () => {
  const unlockRes = await fetch(BASE + '/api/lock/unlock', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  unlockToken = (await unlockRes.json()).token || ''
  await cleanupRunbooks()
  const revealed = await api('POST', '/api/agent-token/reveal')
  agentToken = revealed.json?.data?.token || ''
  expect(agentToken.startsWith('sca_')).toBeTruthy()
})

test.afterAll(async () => {
  await cleanupRunbooks()
  for (const id of sessionIds) await api('DELETE', `/api/terminals/${id}`)
})

test('两伪目标+无信号目标×三步：矩阵聚合 / 中途失败停 / noSignal 降级 / fleet 进度事件', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)

  const t1 = await createTarget(`fleet-e2e-1-${WORD}`)
  const t2 = await createTarget(`fleet-e2e-2-${WORD}`)
  const bare = await createTarget(`fleet-e2e-bare-${WORD}`, true)
  const bookId = await ensureBook(RUN_TITLE, [
    `echo sc-fleet-a-${WORD}`,
    FAIL_CMD,
    `echo sc-fleet-c-${WORD}`,
  ], 'stop')

  // ops-channel 探针先注册再触发（runbook-run-api 同款形态）
  await page.evaluate(({ token }) => {
    return new Promise<void>((resolve, reject) => {
      const w = window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }
      w.__fleetProgress = []
      const ws = new WebSocket(`ws://${location.host}/ws/ops-channel`, [token])
      ws.onmessage = (ev) => {
        try {
          w.__fleetProgress!.push(JSON.parse(ev.data as string))
        } catch { /* 忽略非 JSON 帧 */ }
      }
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('probe ws handshake failed'))
      setTimeout(() => reject(new Error('probe ws open timeout')), 10000)
    })
  }, { token: agentToken })

  // 本地裸目标（sh/cmd.exe）无确认信号：每步等待烧满超时窗后才降级——
  // stepTimeoutMs 显式压到 5s（提案「步骤级可调」旋钮），3 步 ≈16s 全程留在
  // 60s 响应墙内；真目标（OSC133 在位）D 帧即时收敛不受该档影响
  const run = await api('POST', `/api/runbooks/${bookId}/fleet-run`,
    { targetIds: [t1, t2, bare], stepTimeoutMs: 5000 }, agentToken)
  expect(run.status).toBe(200)
  const data = run.json?.data ?? {}
  expect(data.status).toBe('failed')
  expect(data.onFailure).toBe('stop')
  expect(data.runId).toBeTruthy()
  expect(data.targetIds).toEqual([t1, t2, bare])

  // 步 0：真目标 exit 0；无信号目标超时后按帧判据降级 done + noSignal（无退出码判据）
  const s0 = data.steps[0]
  expect(s0.status).toBe('done')
  expect(s0.targets).toEqual([
    { id: t1, status: 'done', exitCode: 0 },
    { id: t2, status: 'done', exitCode: 0 },
    { id: bare, status: 'done', noSignal: true },
  ])
  // 步 1（条件命令无标记 → exit 7）：哪台哪步在 failed 格；无信号目标不参与判定
  const s1 = data.steps[1]
  expect(s1.status).toBe('failed')
  expect(s1.targets[0]).toMatchObject({ id: t1, status: 'failed', exitCode: 7 })
  expect(s1.targets[1]).toMatchObject({ id: t2, status: 'failed', exitCode: 7 })
  expect(s1.targets[2]).toMatchObject({ id: bare, status: 'done', noSignal: true })
  // 步 2：停=中止全书，整行 skipped
  expect(data.steps[2]).toMatchObject({
    index: 2, status: 'skipped',
    targets: [
      { id: t1, status: 'skipped' },
      { id: t2, status: 'skipped' },
      { id: bare, status: 'skipped' },
    ],
  })

  // 真执行对账：失败步之前的输出在屏上，失败步之后的没发
  const text = await pollScrollback(t1, `sc-fleet-a-${WORD}`)
  expect(text).not.toContain(`sc-fleet-c-${WORD}`)
  // 无信号目标同样真执行了（写前跳过会吞命令谎报 done——回归锚点）
  await pollScrollback(bare, `sc-fleet-a-${WORD}`)

  // fleet 扩展进度事件（WS 广播面）：start 骨架 / step 逐格 / final 终态
  await page.waitForFunction(
    () => (window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> })
      .__fleetProgress?.some(m => m?.type === 'task.progress' && !!(m.payload as any)?.fleet),
    undefined,
    { timeout: 15000 },
  )
  const msgs = await page.evaluate(
    () => (window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }).__fleetProgress ?? [],
  )
  const mine = msgs.filter(m => m.type === 'task.progress' && (m.payload as any)?.fleet
    && (m.payload as any)?.runId === data.runId)
  expect(mine.length).toBeGreaterThanOrEqual(3)
  const start = mine.find(m => (m.payload as any).fleet.phase === 'start')
  expect(start).toBeTruthy()
  expect((start!.payload as any).fleet.targetIds).toEqual([t1, t2, bare])
  expect(((start!.payload as any).fleet.stepNames as string[]).length).toBe(3)
  // 无 terminalId 归属（舰队不归属单会话）——任务词前缀可辨
  expect((start!.payload as any).task).toContain('舰队运行书')
  const stepEv = mine.filter(m => (m.payload as any).fleet.phase === 'step')
  expect(stepEv.length).toBeGreaterThanOrEqual(2)
  const failedStepEv = stepEv.find(m => (m.payload as any).fleet.stepIndex === 1)
  expect(((failedStepEv!.payload as any).fleet.results as any[]).some(
    c => c.id === t1 && c.status === 'failed' && c.exitCode === 7,
  )).toBe(true)
  const finalEv = mine.find(m => (m.payload as any).fleet.phase === 'final')
  expect(finalEv).toBeTruthy()
  expect((finalEv!.payload as any).status).toBe('failed')

  // 落库流（B6）可回查：fleet 载荷原样入 agent-tasks
  const tasks = await api('GET', '/api/agent-tasks?limit=100')
  expect(tasks.status).toBe(200)
  const flow = (tasks.json?.data || []) as Array<{ type: string; task?: string; status?: string }>
  expect(flow.some(t => t.type === 'task.progress' && (t.task || '').includes('舰队运行书') && t.status === 'failed')).toBe(true)

  // ── 失败步单台重试：广播建标记 → t1 该格重跑 → exit 0（重试循环自带轮询：
  // 标记落盘前的重试会再失败一次，格仍可重，收敛即停——免 locale 相关探测）──
  await api('POST', '/api/terminals/broadcast-write', { ids: [t1], data: MARKER_TOUCH + '\r' })
  let retried = false
  for (let i = 0; i < 10 && !retried; i++) {
    const r = await api('POST', `/api/runbooks/${bookId}/fleet-retry`,
      { runId: data.runId, stepIndex: 1, targetId: t1 }, agentToken)
    expect(r.status).toBe(200)
    const rd = r.json?.data
    const cell = rd.steps[1].targets.find((c: any) => c.id === t1)
    if (cell.status === 'done' && cell.exitCode === 0) {
      retried = true
      // 诚实对账：单台重试只收敛该格——t2 的失败格残留 → run 仍 failed，
      // 不虚构整轮成功（全收敛才 completed 由单测覆盖）
      expect(rd.steps[1].targets.find((c: any) => c.id === t2).status).toBe('failed')
      expect(rd.status).toBe('failed')
    } else {
      await new Promise(r2 => setTimeout(r2, 600))
    }
  }
  expect(retried, 'retry should converge t1 cell to done exit 0').toBe(true)

  // 标记清理（广播删文件，不留工作目录垃圾）
  await api('POST', '/api/terminals/broadcast-write', { ids: [t1], data: MARKER_RM + '\r' })
})

/** scrollback 轮询到出现标记（命令已执行的确定通道；runbook-run-api 同款） */
async function pollScrollback(sessionId: string, marker: string, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    text = await scrollback(sessionId)
    if (text.includes(marker)) return text
    await new Promise(r => setTimeout(r, 400))
  }
  throw new Error(`scrollback 未出现 ${marker}，末尾内容：${text.slice(-400)}`)
}

test('手动中止：长命令在途 → fleet-abort 广播 Ctrl+C，终态矩阵同步返回', async ({ page }) => {
  test.setTimeout(120000)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${BASE}/`)

  const t1 = await createTarget(`fleet-e2e-abort-1-${WORD}`)
  const t2 = await createTarget(`fleet-e2e-abort-2-${WORD}`)
  const bookId = await ensureBook(ABORT_TITLE, [
    `echo sc-fleet-abort-go-${WORD}`,
    SLEEP_CMD,
    `echo sc-fleet-abort-after-${WORD}`,
  ], 'continue')

  await page.evaluate(({ token }) => {
    return new Promise<void>((resolve, reject) => {
      const w = window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }
      w.__fleetProgress = []
      const ws = new WebSocket(`ws://${location.host}/ws/ops-channel`, [token])
      ws.onmessage = (ev) => {
        try {
          w.__fleetProgress!.push(JSON.parse(ev.data as string))
        } catch { /* 忽略非 JSON 帧 */ }
      }
      ws.onopen = () => resolve()
      ws.onerror = () => reject(new Error('probe ws handshake failed'))
      setTimeout(() => reject(new Error('probe ws open timeout')), 10000)
    })
  }, { token: agentToken })

  // 不等响应（长运行）；runId 从 start 事件取——事件先于响应的调用形态演练
  const runPromise = api('POST', `/api/runbooks/${bookId}/fleet-run`,
    { targetIds: [t1, t2], stepTimeoutMs: 60000 }, agentToken)
  const runId = await page.waitForFunction(
    (bid) => {
      const msgs = (window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }).__fleetProgress ?? []
      const m = msgs.find(x => x?.type === 'task.progress'
        && (x.payload as any)?.fleet?.phase === 'start'
        && (x.payload as any)?.bookId === bid)
      return m ? (m.payload as any).runId : null
    },
    bookId,
    { timeout: 20000 },
  ).then(h => h.jsonValue())

  // 等步 0 收敛（步 1 长命令在途）再中止——断言步 1 格 aborted 的确定性前提
  await page.waitForFunction(
    (rid) => {
      const msgs = (window as unknown as { __fleetProgress?: Array<{ type?: string; payload?: Record<string, unknown> }> }).__fleetProgress ?? []
      return msgs.some(x => x?.type === 'task.progress'
        && (x.payload as any)?.runId === rid
        && (x.payload as any)?.fleet?.phase === 'step'
        && (x.payload as any)?.fleet?.stepIndex === 0)
    },
    runId,
    { timeout: 20000 },
  )

  const abort = await api('POST', `/api/runbooks/${bookId}/fleet-abort`, { runId }, agentToken)
  expect(abort.status).toBe(200)
  const ad = abort.json?.data ?? {}
  expect(ad.runId).toBe(runId)
  expect(ad.status).toBe('aborted')
  expect(ad.steps[0].status).toBe('done')
  expect(ad.steps[1].status).toBe('aborted')
  expect(ad.steps[1].targets.every((c: any) => c.status === 'aborted')).toBe(true)
  expect(ad.steps[2].targets.every((c: any) => c.status === 'aborted')).toBe(true)

  // 幂等：重复中止回快照不报错、不改终态
  const again = await api('POST', `/api/runbooks/${bookId}/fleet-abort`, { runId }, agentToken)
  expect(again.status).toBe(200)
  expect(again.json?.data?.status).toBe('aborted')

  // 原始 run 请求同步收同一终态（返回即终态语义对中止路径同样成立）
  const runResp = await runPromise
  expect(runResp.status).toBe(200)
  expect(runResp.json?.data?.status).toBe('aborted')

  // 会话活着（中止不是杀会话）：scrollback 可读且中止前的输出在
  const text = await pollScrollback(t1, `sc-fleet-abort-go-${WORD}`)
  expect(text.length).toBeGreaterThan(0)
})
