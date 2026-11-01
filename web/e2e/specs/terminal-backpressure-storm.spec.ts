import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 终端写链路背压丢帧的计数与风暴落定自愈 E2E（P-20261004-47）：
 *   1. 风暴模拟：init 脚本给 Blob.arrayBuffer 注入 30ms/帧延迟——写链路的每条
 *      WS 消息（终端输出为二进制帧 → Blob 路径）处理成本人为抬高，服务端合帧
 *      窗口的产出速率稳定超过消费速率，pendingWrites 越过 256 闸门进入真实
 *      丢弃分支（无注入时写链吞吐远超 ConPTY 产出，丢分支在健康拓扑上不可达，
 *      这正是它长期静默无回归覆盖的原因）；
 *   2. 丢弃计数：风暴后打开设置·终端·写链路背压诊断，本会话行「累计丢弃」>0
 *      （丢弃不再静默）；
 *   3. 落定自愈：风暴结束写链排空、静默窗过后触发一次性重同步——诊断行
 *      「自愈次数」≥1 是落定链路在前端的直接证据（计数只在 onSettle 回调里自增）；
 *   4. 风暴后屏态一致：风暴结束后键入回显标记照常到达且提示符完好——写链
 *      自愈后终端继续可用、后续输出渲染一致。
 * 已知边界（金态实例为 Windows/ConPTY native 后端）：服务端权威重绘
 * （tmux refresh-client）在该拓扑为 no-op，被丢帧的内容客户端不可恢复——
 * 本 spec 断言的是「计数可见 + 落定自愈触发 + 风暴后终端可用」；tmux 拓扑的
 * 整屏重发链路由 redrawCall 与可见性自愈共用同一条注入（服务端单测覆盖）。
 * 会话用完即删，不影响其它 spec。
 */

const BASE = API_BASE
// Blob.arrayBuffer 人为延迟：抬高写链每帧服务时间使 backlog 越过 256 闸门
// （80ms/帧 ≈ 12.5 帧/s 消费，ConPTY 产出 30-60 帧/s——串行延迟链下净积压
// 数秒内越闸；值过小时产出侧可能追平消费侧永不越闸）
const BLOB_DELAY_MS = 80
const STORM_LINES = 50000

interface SessionRow { id: string; kind?: string; projectId?: string }

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function listSessions(request: APIRequestContext): Promise<SessionRow[]> {
  const res = await request.get(`${BASE}/api/terminals`, { headers: await unlockHeaders(request) })
  return ((await res.json()) as { data?: SessionRow[] }).data || []
}

/** 页面源内给 Blob 解码注入人为延迟（风暴模拟的单一杠杆，见文件头注）。
 *  延迟必须串行化（全局 promise 链）而非每帧独立定时：独立 setTimeout 在
 *  backlog 积压期间并发到点，写链 await 时早已 resolved——服务速率退化回
 *  解析速度，pending 永远积不过闸门（首轮实测 dropped 恒 0 的根因）。串行链
 *  后每帧真实占用 30ms 服务时间，产出>消费积压即可越过 256 */
async function installBlobDelay(page: Page): Promise<void> {
  await page.addInitScript((delayMs: number) => {
    const orig = Blob.prototype.arrayBuffer
    let last: Promise<unknown> = Promise.resolve()
    Blob.prototype.arrayBuffer = function (): Promise<ArrayBuffer> {
      const p = last
        .then(() => new Promise<void>(r => setTimeout(r, delayMs)))
        .then(() => orig.call(this))
      last = p.catch(() => {})
      return p
    }
  }, BLOB_DELAY_MS)
}

test.describe('终端写链路背压（P-20261004-47）', () => {
  test('输出风暴：丢弃计数可见 + 落定自愈触发 + 风暴后屏态一致', async ({ page, request }) => {
    test.setTimeout(300_000)
    await installBlobDelay(page)

    // 归一化：清掉遗留的项目终端会话（旧 tab 的 xterm-screen 拦截点击，串行套件互扰根因）
    await fixedLocale(page)
    await gotoAndUnlock(page, `${BASE}/`)
    const projRes = await request.get(`${BASE}/api/projects`, { headers: await unlockHeaders(request) })
    const proj = ((await projRes.json()) as { data?: Array<{ id: string; name: string }> }).data
      ?.find(x => x.name === 'simple-coding')
    expect(proj, 'simple-coding 项目应已播种').toBeTruthy()
    for (const s of await listSessions(request)) {
      if (s.projectId === proj!.id) {
        await request.delete(`${BASE}/api/terminals/${s.id}`, { headers: await unlockHeaders(request) })
      }
    }

    // 打开项目 → 终端面板 → 新建会话（真实 UI 写链路，非页面源裸 WS）
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    for (let i = 0; i < 3; i++) {
      if (await page.locator('.term-toolbar').isVisible().catch(() => false)) break
      await page.locator('[data-testid="rail-terminal"]').click()
      await page.waitForTimeout(600)
    }
    await page.locator('.term-toolbar').getByRole('button', { name: '新建终端' }).click()
    await page.waitForTimeout(3500)
    await page.locator('.term-tab').last().click()
    await page.waitForTimeout(600)

    // 锁定本 spec 的会话 id（诊断行按 data-session-id 定位，不依赖会话名）
    const sessions = await listSessions(request)
    const session = sessions.find(s => s.projectId === proj!.id)
    expect(session, '新建终端会话应在册').toBeTruthy()
    const sessionId = session!.id

    // 会话用完即删（断言失败也清理，防跨 spec 残留 tab 拦截点击）
    try {
      await runStormAssertions(page, sessionId)
    } finally {
      await request.delete(`${BASE}/api/terminals/${sessionId}`, { headers: await unlockHeaders(request) })
    }
  })

  /** 主体断言（风暴→计数→自愈→屏态一致；会话清理放宿主 finally） */
  async function runStormAssertions(page: Page, sessionId: string): Promise<void> {
    // 双 shell 通吃的风暴命令（terminal-output-coalesce 同款形态）：POSIX 走 seq、
    // PowerShell 走区间表达式，尾部标记证明命令真跑完且字节链完好
    const DONE = `SC_BP_DONE_${Date.now()}`
    const screen = page.locator('.xterm-screen:visible').last()
    await expect(screen).toBeVisible({ timeout: 30000 })
    await screen.click()
    await page.keyboard.type(`seq 1 ${STORM_LINES}; 1..${STORM_LINES}; echo ${DONE}`)
    await page.keyboard.press('Enter')

    // 尾部标记到达 = 风暴结束且写链已把尾帧送达（闸门只在 pending>256 时丢帧，
    // 风暴尾段随 backlog 排空放行）
    await expect
      .poll(async () => page.locator('.xterm-rows:visible').last().textContent(), {
        timeout: 180_000,
        intervals: [2000],
        message: 'storm should complete with the end marker delivered',
      })
      .toContain(DONE)

    // 诊断面：丢弃计数 > 0 且自愈次数 ≥ 1（「自愈次数」只在风暴落定回调里自增，
    // 行内同时满足 = 计数与落定自愈全链路的前端证据）
    await page.locator('[data-testid="rail-settings"]').click()
    await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 5000 })
    await page.locator('[data-testid="settings-nav-terminal"]').click()
    await expect(page.locator('[data-testid="settings-pane-terminal"]')).toBeVisible({ timeout: 5000 })
    const bpBlock = page.locator('[data-testid="settings-terminal-backpressure"]')
    await expect(bpBlock).toBeVisible()
    const row = bpBlock.locator(`[data-testid="settings-terminal-bp-row"][data-session-id="${sessionId}"]`)
    // 「累计丢弃」为非零（读数随 2s 轮询刷新，toHaveText 自动重试到超时）
    await expect(row.locator('[data-testid="settings-terminal-bp-dropped"]')).toHaveText(/\d*[1-9]\d*/, { timeout: 30_000 })
    const heals = row.locator('[data-testid="settings-terminal-bp-heals"]')
    await expect
      .poll(async () => Number(await heals.textContent().catch(() => '0')), {
        timeout: 30_000,
        intervals: [1000],
        message: 'storm-settle heal should have fired exactly per episode',
      })
      .toBeGreaterThanOrEqual(1)

    // 风暴后屏态一致：关设置回终端，键入回显照常到达、提示符完好（写链自愈后
    // 终端继续可用；后续输出渲染一致）
    await page.keyboard.press('Escape')
    await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
    const OK = `SC_BP_OK_${Date.now()}`
    const screenAfter = page.locator('.xterm-screen:visible').last()
    await expect(screenAfter).toBeVisible({ timeout: 10000 })
    await screenAfter.click()
    await page.keyboard.type(`echo ${OK}`)
    await page.keyboard.press('Enter')
    await expect
      .poll(async () => page.locator('.xterm-rows:visible').last().textContent(), {
        timeout: 20_000,
        intervals: [1000],
        message: 'post-storm echo must render (write chain alive after heal)',
      })
      .toContain(OK)
  }
})
