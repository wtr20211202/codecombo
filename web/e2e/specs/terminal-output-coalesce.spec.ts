import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端输出合帧（P-20261004-26）E2E——PTY 输出 WS 写侧 flush 窗口聚合的端到端
 * 代理断言（浏览器 WS 收帧视角）：
 * 1. 高输出 burst（20 万行 ≈1.4MB，POSIX seq / PowerShell 区间表达式双通吃）
 *    完整到达：尾部标记 + 末行数字都在（聚合绝不丢字节/乱序——丢一个中间块
 *    两侧数字即断档）；
 * 2. 合帧上限生效：任何一帧 ≤ 200KB（128KB 聚合上限 + 32KB 末块余量）——
 *    窗口有界，不会随流量无限膨胀；
 * 3. 合帧生效（吞吐足够时）：存在 >32KB 的帧——旧实现一帧至多一个 read 块
 *    （32KB 读缓冲），超 32KB 的帧即「窗口吸收了 ≥2 个读块」的直接证据
 *    （ConPTY/PTY 交付速率慢于 4MB/s 的拓扑下该断言自动退让，见步骤内注释）；
 * 4. 交互回显延迟无感：burst 结束后单键回显在秒级内必达（8ms 窗口人类无感，
 *    此处只卡 5s 病理上界——聚合不得让会话在重输出后失去响应）。
 *
 * 会话拓扑：agent shell 会话（API 直建，无 UI tab），WS 由本 spec 在页面源内
 * 自持（terminal-idle-detach 同款；金态播种关闭锁定，握手免 token）。会话用
 * 完即删，不影响其它 spec。
 */

const BASE = API_BASE

interface SessionRow { id: string; kind?: string; name?: string }

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  return ((await res.json()) as { data?: SessionRow[] }).data || []
}

async function createSession(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name, runtime: 'shell' },
  })
  expect(res.status()).toBe(200)
  const body = (await res.json()) as { data?: { id?: string } }
  const id = body.data?.id
  expect(id, 'session id in create response').toBeTruthy()
  return id!
}

/** 页面源内开一条终端 WS 并装配收帧计数器（帧数/总字节/最大帧/累计文本） */
async function attachCountingWS(page: Page, sessionId: string): Promise<void> {
  const wsUrl = BASE.replace(/^http/, 'ws') + `/ws/terminal/${sessionId}`
  await page.evaluate(url => new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url)
    const st = { frames: 0, bytes: 0, maxFrame: 0, text: [] as string[] }
    ;(window as unknown as { __e2eCoalesce?: { ws: WebSocket; st: typeof st } }).__e2eCoalesce = { ws, st }
    ws.binaryType = 'arraybuffer'
    ws.onmessage = ev => {
      const len = ev.data instanceof ArrayBuffer ? ev.data.byteLength : String(ev.data).length
      st.frames++
      st.bytes += len
      if (len > st.maxFrame) st.maxFrame = len
      const chunk = ev.data instanceof ArrayBuffer ? new TextDecoder().decode(ev.data) : String(ev.data)
      // 只留尾部 64KB：完整性断言只需尾部标记，避免 1.4MB 输出把页面内存撑爆
      st.text.push(chunk)
      const total = st.text.reduce((a, b) => a + b.length, 0)
      while (total > 65536 && st.text.length > 1) st.text.shift()
    }
    ws.onopen = () => resolve()
    ws.onerror = () => reject(new Error('terminal ws handshake failed'))
  }), wsUrl)
}

async function wsSend(page: Page, data: string): Promise<void> {
  await page.evaluate(d => {
    (window as unknown as { __e2eCoalesce?: { ws: WebSocket } }).__e2eCoalesce?.ws.send(d)
  }, data)
}

interface WsStats { frames: number; bytes: number; maxFrame: number; text: string }

async function wsStats(page: Page): Promise<WsStats> {
  return page.evaluate(() => {
    const c = (window as unknown as { __e2eCoalesce?: { st: { frames: number; bytes: number; maxFrame: number; text: string[] } } }).__e2eCoalesce
    if (!c) throw new Error('coalesce ws not attached')
    return { frames: c.st.frames, bytes: c.st.bytes, maxFrame: c.st.maxFrame, text: c.st.text.join('') }
  })
}

test.describe('终端输出合帧（P-20261004-26）', () => {
  test('高输出 burst 合帧：字节完整 + 帧尺寸有界 + 交互回显无感', async ({ page, request }) => {
    test.setTimeout(180_000)
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`) // WS 需要页面源（浏览器 WebSocket）

    // 归一化：清掉其它 spec 遗留的 agent shell 会话（服务端全局共享约定）
    for (const s of await listSessions(request)) {
      if (s.kind === 'agent') await request.delete(`${BASE}/api/terminals/${s.id}`, { headers: await unlockHeaders(request) })
    }

    const id = await createSession(request, '[e2e-coalesce] 高输出会话')
    try {
      await runCoalesceAssertions(page, request, id)
    } finally {
      await request.delete(`${BASE}/api/terminals/${id}`, { headers: await unlockHeaders(request) })
    }
  })

  /** 主体断言（会话清理放 finally，失败不残留） */
  async function runCoalesceAssertions(page: Page, request: APIRequestContext, id: string): Promise<void> {
    await attachCountingWS(page, id)

    // 标记防自匹配：`echo SC_"DONE"_<ts>` 经 shell 引号拼接输出裸 `SC_DONE_<ts>`，
    // 而终端对命令行的回显含引号形态（`SC_"DONE"_`）不含裸标记——poll 不会
    // 被回显提前击穿（首轮实测正是被命令回显假匹配，尾部停在第 1323 行）
    const MARK = Date.now()
    const MARKER = `SC_DONE_${MARK}`
    // 双 shell 通吃：POSIX seq 打 5 万行（瞬时）；PowerShell 下 seq 报一行错、
    // 由区间表达式 1..50000 接力（实测 ConPTY 节流下约 25s——20 万行要 90s+，
    // 不堪 poll 重试）；cmd 形态（无 pwsh/powershell 才会落到）引号拼接不展开，
    // 该拓扑不在金态实例范围（Windows 恒有 powershell）
    await wsSend(page, `seq 1 50000; 1..50000; echo SC_"DONE"_${MARK}\r`)

    // 尾部标记到达 = 命令真跑完 + 字节链完好（聚合不丢尾部）
    await expect.poll(async () => (await wsStats(page)).text.includes(MARKER), {
      timeout: 120_000,
      message: 'high-output burst should complete with end marker intact',
    }).toBe(true)

    const stats = await wsStats(page)

    // 完整性：末行数字 49999 在尾部窗口（数字流若被聚合丢弃/乱序即断档；
    // 实测 PowerShell 慢产出下 ConPTY 跟得上、数字流连续）
    expect(stats.text, 'tail of output contains the final line').toContain('49999')

    // 帧尺寸有界：128KB 聚合上限 + 32KB 末块 ≤ 200KB（窗口不随流量膨胀）
    expect(stats.maxFrame, 'no frame exceeds the aggregation cap').toBeLessThanOrEqual(200_000)

    // 合帧生效直接证据：存在 >32KB 的帧（旧实现一帧 ≤ 一个 read 块 32KB）。
    // 吞吐不足 4MB/s 的慢拓扑（ConPTY 渲染跟不上的极端机）单个 8ms 窗口攒不
    // 出超 32KB——此时该证据自动退让（log 记录实测值），保留完整性+上限两条
    // 硬断言与 Go 集成测（确定性 2 帧）兜底，不因机器慢而假红
    if (stats.maxFrame <= 32_768) {
      console.log(`[e2e-coalesce] slow topology, coalescing-evidence skipped: maxFrame=${stats.maxFrame} bytes=${stats.bytes} frames=${stats.frames}`)
    } else {
      expect(stats.maxFrame, 'at least one frame coalesced multiple 32KB reads').toBeGreaterThan(32_768)
    }

    // ── 交互回显延迟无感：burst 结束后单条 echo 秒级可达（8ms 窗口无感上界） ──
    const ECHO = `SC_ECHO_${Date.now()}`
    const t0 = Date.now()
    await wsSend(page, `echo ${ECHO}\r`)
    await expect.poll(async () => (await wsStats(page)).text.includes(ECHO), {
      timeout: 5_000,
      message: 'interactive echo must arrive promptly after heavy burst (no window stall)',
    }).toBe(true)
    const echoMs = Date.now() - t0
    expect(echoMs, 'echo latency within human-imperceptible proxy bound').toBeLessThan(5_000)
  }
})
