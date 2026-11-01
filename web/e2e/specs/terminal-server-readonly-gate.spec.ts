import { test, expect, type APIRequestContext } from '@playwright/test'
import { execFile } from 'node:child_process'
import { DEFAULT_PASSWORD, gotoAndUnlock } from '../../tests/helpers'
import { serverIsLinux } from '../../tests/dualpath'
import { API_BASE } from '../../tests/api-base'

/**
 * 接管会话的服务端只读闸（P-20261008-17）E2E——tmux 后端 Windows 不可用，本
 * spec 仅 Linux 服务端形态可跑（WSL 形态 / wsl-e2e 全量；Windows 形态自动跳过，
 * 自建会话 pane 锁回归由 terminal-readonly-lock.spec 覆盖）：
 *   1. 服务端闸全链：接管（默认 serverReadOnly）→ 页面 WS 直写输入帧被拒
 *      （TextMessage {type:input_rejected, code:readonly_external} 稳定码，
 *      连接不关）→ 用户 tmux 会话 capture-pane 无标记（写入确实没达 PTY，
 *      服务端证据非仅 UI）→ input-lock 解锁 → 同形态 WS 写通 → capture-pane
 *      收到标记（写到的是用户的会话）
 *   2. AgentGuard 分层：agent 令牌解锁（放开对用户会话的写入）→ 428 审批
 *      （op 以「接管会话只读闸解锁」为前缀）→ 裁决允许重试 200；agent 上锁
 *      （locked=true 加固方向）→ body 感知直放行 200
 * 豁免面（广播/队列不读本标记）由 Go 单测 TestServerReadOnly_BroadcastExempt
 * 结构性钉死（闸只在 WS 层不在 WriteInput），e2e 不重复建广播链
 */

const BASE = API_BASE

/** 服务端 tmux 驱动（terminal-external-tmux 同款：跨 WSL 边界经 wsl.exe） */
const isWin = process.platform === 'win32'
function runTmux(args: string[]): Promise<{ code: number; out: string }> {
  const file = isWin ? 'wsl.exe' : 'tmux'
  const argv = isWin ? ['-e', 'tmux', ...args] : args
  return new Promise((resolve) => {
    execFile(file, argv, { timeout: 15000 }, (err, stdout) => {
      const code = err && typeof (err as { code?: number }).code === 'number' ? (err as { code: number }).code : err ? 1 : 0
      resolve({ code, out: stdout })
    })
  })
}

async function getUnlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  return ((await res.json()) as { token?: string }).token || ''
}

function userHeaders(token: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

let serverTmuxUp = false
const fixtureNames: string[] = []
const sessionIds: string[] = []

test.beforeAll(async ({ request }) => {
  test.skip(!serverIsLinux, 'tmux 域 spec 仅 Linux 服务端形态可跑（Windows 金态跳过）')
  const uh = userHeaders(await getUnlockToken(request))
  const res = await request.get(`${BASE}/api/terminals/tmux-info`, { headers: uh })
  const info = (await res.json()) as { data?: { available?: boolean } }
  serverTmuxUp = !!info.data?.available
  test.skip(!serverTmuxUp, '服务端 tmux 不可用（未安装/版本过低），跳过')
})

test.afterAll(async ({ request }) => {
  const uh = userHeaders(await getUnlockToken(request))
  // 外部会话缺省 DELETE = 解除接管（tmux 会话体随后显式 kill，external spec 同款）
  for (const sid of sessionIds) {
    await request.delete(`${BASE}/api/terminals/${sid}`, { headers: uh })
  }
  for (const name of fixtureNames) {
    await runTmux(['kill-session', '-t', name])
  }
})

/** 建外部 tmux 会话夹具（默认 socket）并接管，返回就绪的外部会话 */
async function takeOverExternalFixture(request: APIRequestContext): Promise<void> {
  const name = `sc-e2e-gate-${Date.now()}-${sessionIds.length}`
  fixtureNames.push(name)
  const created = await runTmux(['new-session', '-d', '-s', name, '-x', '100', '-y', '30'])
  expect(created.code, `tmux new-session failed: ${name}`).toBe(0)
  const taken = await request.post(`${BASE}/api/terminals`, {
    data: { attachTmux: name },
    headers: userHeaders(await getUnlockToken(request)),
  })
  expect(taken.status()).toBe(200)
  const body = (await taken.json()) as { data?: { id?: string; origin?: string } }
  sessionId = body.data?.id || ''
  sessionIds.push(sessionId)
  expect(sessionId).toBe(name)
  expect(body.data?.origin).toBe('external')
}

/** 页面上下文 WS 写探针：开 /ws/terminal/:id（token 子协议）发一帧输入，
 * 等服务端控制帧/收集回显。page.evaluate 内 Promise 化，结果整体回传 */
interface WsProbeResult {
  rejected: boolean
  code?: string
  echoed: string
  closed: boolean
}
async function wsWriteProbe(page: import('@playwright/test').Page, payload: string, resolveOn: 'reject' | 'echo', echoMarker: string): Promise<WsProbeResult> {
  const token = await getUnlockTokenFromStorage(page)
  return page.evaluate(({ sid, token, payload, resolveOn, echoMarker }) => {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return new Promise<WsProbeResult>((resolve) => {
      const ws = new WebSocket(`${proto}//${location.host}/ws/terminal/${sid}`, [token])
      const result: WsProbeResult = { rejected: false, echoed: '', closed: false }
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try { ws.close() } catch { /* ignore */ }
        resolve(result)
      }
      const timer = setTimeout(done, 12000)
      ws.onopen = () => ws.send(payload)
      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') {
          try {
            const frame = JSON.parse(ev.data) as { type?: string; code?: string }
            if (frame.type === 'input_rejected') {
              result.rejected = true
              result.code = frame.code
              if (resolveOn === 'reject') done()
            }
          } catch { /* 非 JSON 控制帧：忽略 */ }
          return
        }
        // 二进制 = 终端字节（Blob）
        void (ev.data as Blob).arrayBuffer().then((buf) => {
          result.echoed += new TextDecoder().decode(buf)
          if (resolveOn === 'echo' && result.echoed.includes(echoMarker)) done()
        })
      }
      ws.onclose = () => {
        result.closed = true
        done()
      }
    })
  }, { sid: sessionId, token, payload, resolveOn, echoMarker })
}

/** WS 子协议 token：与页面同源的 localStorage（gotoAndUnlock 已落）——
 * 失败回空（连接会被 4001 拒，用例明确失败可诊断） */
async function getUnlockTokenFromStorage(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('sc.unlockToken') || '')
}

test('服务端只读闸全链：接管默认闸开 → WS 写被拒含稳定码 → 解锁 → 写通用户会话', async ({ page, request }) => {
  test.setTimeout(180000)
  await takeOverExternalFixture(request)
  // 页面加载拿 unlock token（WS 子协议用）——不需要打开 pane，闸面在服务端
  await gotoAndUnlock(page, '/')

  // 闸开：WS 直写输入帧 → 收到 readonly_external 拒绝帧（agent 可编程感知面）
  const lockedMarker = `SC-GATE-LOCKED-${Date.now()}`
  const probe1 = await wsWriteProbe(page, `echo ${lockedMarker}\r`, 'reject', lockedMarker)
  expect(probe1.rejected, 'gated write must be rejected by the server').toBe(true)
  expect(probe1.code).toBe('readonly_external')
  expect(probe1.closed, 'rejection must not close the connection (output stream keeps flowing)').toBe(false)
  // 服务端证据：拒绝帧之外写入未达 PTY——用户 tmux 会话内容无标记
  await page.waitForTimeout(1500)
  const capture1 = await runTmux(['capture-pane', '-p', '-t', fixtureNames[0]])
  expect(capture1.out).not.toContain(lockedMarker)

  // 解锁（用户动作的服务端镜像面）→ 同形态 WS 写 → capture-pane 收到标记
  const unlocked = await request.put(`${BASE}/api/terminals/${sessionId}/input-lock`, {
    data: { locked: false }, headers: userHeaders(await getUnlockToken(request)),
  })
  expect(unlocked.status()).toBe(200)
  const marker = `SC-GATE-PASS-${Date.now()}`
  const probe2 = await wsWriteProbe(page, `echo ${marker}\r`, 'echo', marker)
  expect(probe2.echoed, 'unlocked write must echo back over the same WS shape').toContain(marker)
  let reached = false
  for (let i = 0; i < 15 && !reached; i++) {
    await new Promise(r => setTimeout(r, 600))
    const capture = await runTmux(['capture-pane', '-p', '-t', fixtureNames[0]])
    reached = capture.out.includes(marker)
  }
  expect(reached, 'unlocked write must reach the user tmux session').toBe(true)
})

test('AgentGuard 分层：agent 解锁 428 审批放行，agent 上锁直放行', async ({ request }) => {
  test.setTimeout(120000)
  await takeOverExternalFixture(request)

  const uh = userHeaders(await getUnlockToken(request))
  const revealed = await request.post(`${BASE}/api/agent-token/reveal`, { headers: uh })
  const agentToken = ((await revealed.json()) as { data?: { token?: string } }).data?.token || ''
  expect(agentToken.startsWith('sca_'), 'agent token should be sca_ prefixed').toBeTruthy()
  const agentHeaders = () => ({ 'Content-Type': 'application/json', 'X-Lock-Token': agentToken })

  // agent 解锁（放开对用户会话的写入）→ 428 审批
  const first = await request.put(`${BASE}/api/terminals/${sessionId}/input-lock`, {
    headers: agentHeaders(), data: { locked: false },
  })
  expect(first.status()).toBe(428)
  const guard = (await first.json()) as { approvalId?: string; code?: string; op?: string }
  expect(guard.approvalId, '428 body should carry approvalId').toBeTruthy()
  expect(guard.code).toBe('ops.approval_required')

  // 审批卡 op 以「接管会话只读闸解锁」为前缀（规则前缀匹配契约）
  const detail = await (await request.get(`${BASE}/api/ops-confirm/${guard.approvalId}`, { headers: uh })).json() as { data?: { op?: string; status?: string } }
  expect(detail.data?.status).toBe('pending')
  expect(detail.data?.op?.startsWith('接管会话只读闸解锁')).toBeTruthy()

  // 裁决允许 → 携 X-Approval-ID 重试 → 200 解锁生效
  const resolved = await request.post(`${BASE}/api/ops-confirm/${guard.approvalId}/resolve`, {
    headers: uh, data: { allow: true },
  })
  expect(resolved.ok()).toBeTruthy()
  const retry = await request.put(`${BASE}/api/terminals/${sessionId}/input-lock`, {
    headers: { ...agentHeaders(), 'X-Approval-ID': guard.approvalId! }, data: { locked: false },
  })
  expect(retry.status()).toBe(200)
  const retryBody = (await retry.json()) as { data?: { locked?: boolean } }
  expect(retryBody.data?.locked).toBe(false)

  // agent 上锁（加固方向）→ body 感知直放行 200（不开审批）
  const relock = await request.put(`${BASE}/api/terminals/${sessionId}/input-lock`, {
    headers: agentHeaders(), data: { locked: true },
  })
  expect(relock.status()).toBe(200)
})
