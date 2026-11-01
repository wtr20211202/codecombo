import { mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { serverPath } from '../../tests/dualpath'

/**
 * 会话停滞分诊（P-20261004-37）E2E：task.progress 声称 running 而 shell 侧
 * 无动静（命令早已结束无下一条）——agent 已死或卡在隐形 prompt 的真异常态。
 *   1. 停滞强标：反组合两侧（OSC 133 活动 + 任务上报）都静默 ≥5 分钟才升级
 *      「疑似停滞 N 分钟」警示档；只在弱标档（4 分钟）不升级；任一侧近期有
 *      动静（任务刚上报）不误标——活 agent 思考/规划不是停滞
 *   2. 分诊卡：点击停滞标弹出，任务进度摘要 + 终端现场 + 最近命令/退出码；
 *      「催一下」经真实 broadcast-write 写回车（纯 shell 会话空提示符无副作用）
 *   3. 终止动作：二次确认后结束会话，会话卡随对账消失
 *   4. 管理页侧栏会话行：同判据同款强标，点击标（非行）开分诊卡且不触发行选中
 * 判据数据（runningMap/activityMap/lastCmdMap/bySession）是前端 store 状态
 * （OSC 133 与 ops-notify 双链驱动），经 #app.__vue_app__ 的 Pinia 注册表注入
 * 过期样本；会话本体走 API 播种（runtime=shell 纯终端不拉起 TUI），afterEach
 * 清理全部终端会话。上报链路（ops-notify → WS → bySession）已有
 * monitor-task-stale.spec 覆盖，本文件直注 store 专测前端判据组合
 */

const STALL_MIN = 6 // 注入的两侧静默时长：6 分钟前（越过 5 分钟停滞阈值）
const WEAK_MIN = 4 // 弱标档内：4 分钟（≥3 分钟弱标阈值、<5 分钟停滞阈值）

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

/** 本用例集创建的临时工作目录（会话关闭后删除） */
const tempDirs: string[] = []

/** API 造纯终端系统会话（runtime=shell 不拉起 claude TUI），按名返回会话 id */
async function createAgentSession(request: APIRequestContext, name: string): Promise<string> {
  const headers = await unlockHeaders(request)
  const dir = path.join(tmpdir(), `sc-stall-${name}`)
  mkdirSync(dir, { recursive: true }) // shell 会话 cwd 须真实存在
  tempDirs.push(dir)
  const created = await request.post(`${API_BASE}/api/terminals`, {
    headers,
    data: { kind: 'agent', name, runtime: 'shell', dir: serverPath(dir) },
  })
  expect(created.ok()).toBeTruthy()
  const tlist = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  const session = ((tlist?.data || []) as { id: string; name: string }[]).find(s => s.name === name)
  expect(session, `会话 ${name} 应出现在列表`).toBeTruthy()
  return session!.id
}

interface StallSample {
  id: string
  /** runningMap 注入值：true=命令在跑 / false=已回提示符 */
  running: boolean
  /** activityMap 年龄（分钟） */
  staleMin: number
  /** bySession.updatedAt 年龄（分钟）；缺省 = 不注入任务归属（无 bySession 条目） */
  reportAgeMin?: number
  task?: string
  step?: string
  command?: string
  exitCode?: number
}

/** 注入停滞判据样本（前端 store 状态，服务端无此数据）：整包替换触发响应式，
 *  与 store.reportOsc/progressFor 内部同款展开写法 */
async function injectStallState(page: Page, samples: StallSample[]) {
  await page.evaluate((items) => {
    const container = document.getElementById('app') as Element & {
      __vue_app__?: {
        config: { globalProperties: { $pinia?: { _s: Map<string, Record<string, unknown>> } } }
      }
    }
    const pinia = container.__vue_app__?.config.globalProperties.$pinia?._s
    const sessions = pinia?.get('terminal-sessions') as Record<string, any> | undefined
    const task = pinia?.get('assistantTask') as Record<string, any> | undefined
    if (!sessions || !task) throw new Error('store 未注册（页面未完成引导）')
    const runningMap = { ...(sessions.runningMap as Record<string, boolean>) }
    const activityMap = { ...(sessions.activityMap as Record<string, number>) }
    const lastCmdMap = { ...(sessions.lastCmdMap as Record<string, unknown>) }
    const bySession = { ...(task.bySession as Record<string, unknown>) }
    for (const it of items) {
      runningMap[it.id] = it.running
      activityMap[it.id] = Date.now() - it.staleMin * 60_000
      if (it.command !== undefined) {
        lastCmdMap[it.id] = { command: it.command, exitCode: it.exitCode, at: Date.now() - it.staleMin * 60_000 }
      }
      if (it.reportAgeMin !== undefined) {
        bySession[it.id] = {
          task: it.task ?? '',
          step: it.step ?? '',
          status: 'running',
          updatedAt: Date.now() - it.reportAgeMin * 60_000,
          steps: [],
        }
      }
    }
    sessions.runningMap = runningMap
    sessions.activityMap = activityMap
    sessions.lastCmdMap = lastCmdMap
    task.bySession = bySession
  }, samples)
}

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterAll(async () => {
  for (const d of tempDirs) {
    try { await rm(d, { recursive: true, force: true }) } catch { /* 占用忽略 */ }
  }
})

test('值班大屏会话卡：反组合双静默升级停滞强标；弱标档与活上报不误标', async ({ page, request }) => {
  const stallId = await createAgentSession(request, 'stall-triage-stall')
  const weakId = await createAgentSession(request, 'stall-triage-weak')
  const aliveId = await createAgentSession(request, 'stall-triage-alive')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const cardOf = (name: string) => page.locator('.mon-card.is-session').filter({ hasText: name })
  await expect(cardOf('stall-triage-stall')).toBeVisible({ timeout: 10000 })

  // 注入：stall = 任务 running + 命令已结束（runningMap false）+ 两侧静默 6 分钟 /
  // weak = 命令在跑但静默 4 分钟（弱标档内，P-53 形态）/ alive = shell 侧静默
  // 6 分钟但任务 1 分钟前刚上报（活 agent：思考/规划中，不误标）
  await injectStallState(page, [
    { id: stallId, running: false, staleMin: STALL_MIN, reportAgeMin: STALL_MIN, task: '季度报告', step: '汇总数据', command: 'claude --resume abc', exitCode: 0 },
    { id: weakId, running: true, staleMin: WEAK_MIN, reportAgeMin: WEAK_MIN, task: '弱标任务' },
    { id: aliveId, running: false, staleMin: STALL_MIN, reportAgeMin: 1, task: '活着任务' },
  ])

  // 停滞强标：警示档「疑似停滞 N 分钟」（强于弱标一档）
  const stallBadge = cardOf('stall-triage-stall').locator('.mon-sess-idle.is-stall')
  await expect(stallBadge).toHaveText('疑似停滞 6 分钟')
  await expect(cardOf('stall-triage-stall')).toHaveAttribute('title', /可能已停滞，点击分诊/)

  // 弱标档内：灰调弱标原样（不升级、不带停滞样式）
  const weakBadge = cardOf('stall-triage-weak').locator('.mon-sess-idle')
  await expect(weakBadge).toHaveText('无输出 4 分钟')
  await expect(weakBadge).not.toHaveClass(/is-stall/)

  // 活上报不误标：连弱标都不亮（runningMap false 非 running 命令态）
  await expect(cardOf('stall-triage-alive').locator('.mon-sess-idle')).toHaveCount(0)
})

test('点击停滞标开分诊卡：任务摘要 + 终端现场 + 最近命令/退出码；催一下经真实写入面', async ({ page, request }) => {
  const sid = await createAgentSession(request, 'stall-triage-card')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('.mon-card.is-session').filter({ hasText: 'stall-triage-card' })
  await expect(card).toBeVisible({ timeout: 10000 })
  await injectStallState(page, [{
    id: sid, running: false, staleMin: STALL_MIN, reportAgeMin: STALL_MIN,
    task: '季度报告', step: '汇总数据', command: 'claude --resume abc', exitCode: 0,
  }])

  // 点击停滞标（非整卡）：整卡点击是跳会话，标点击必须截停开分诊
  await card.locator('.mon-sess-idle.is-stall').click()
  const dialog = page.locator('[data-testid="stall-triage-dialog"]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('季度报告')
  await expect(dialog).toContainText('汇总数据')
  // 终端现场：命令已结束（主异常形态）；最近命令 + 退出码
  await expect(dialog).toContainText('命令已结束')
  await expect(dialog).toContainText('claude --resume abc')
  await expect(dialog).toContainText('退出码 0')

  // 催一下：broadcast-write 真实写入面（纯 shell 会话停在空提示符，写回车
  // 无副作用），written=1 → 成功反馈
  await dialog.locator('[data-testid="stall-triage-nudge"]').click()
  await expect(page.locator('.n-message').filter({ hasText: '已催' })).toBeVisible({ timeout: 10000 })

  // 关闭分诊卡（点遮罩），整卡点击仍是既有跳转语义（基线不回归）
  await page.mouse.click(10, 10)
  await expect(dialog).not.toBeVisible()
  await card.click()
  await page.waitForURL(`${API_BASE}/`)
})

test('终止动作：二次确认后结束会话，停滞卡随对账消失', async ({ page, request }) => {
  const sid = await createAgentSession(request, 'stall-triage-kill')

  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)
  const card = page.locator('.mon-card.is-session').filter({ hasText: 'stall-triage-kill' })
  await expect(card).toBeVisible({ timeout: 10000 })
  await injectStallState(page, [{
    id: sid, running: false, staleMin: STALL_MIN, reportAgeMin: STALL_MIN,
    task: '将死任务', command: 'sleep 1000', exitCode: 137,
  }])

  await card.locator('.mon-sess-idle.is-stall').click()
  const dialog = page.locator('[data-testid="stall-triage-dialog"]')
  await expect(dialog).toBeVisible()
  // 非零退出码如实呈现（红色档断言样式类）
  await expect(dialog.locator('.stc-exit.is-fail')).toContainText('退出码 137')

  // 终止 → 确认弹层（confirmDialog 非原生 dialog）→ 确认 → 会话关闭
  await dialog.locator('[data-testid="stall-triage-terminate"]').click()
  const confirmBtn = page.locator('.n-dialog').getByRole('button').filter({ hasText: '终止会话' })
  await expect(confirmBtn).toBeVisible()
  await confirmBtn.click()
  await expect(dialog).not.toBeVisible()
  // 会话真被关闭：服务端列表不再有它；大屏卡随快照对账消失
  const headers = await unlockHeaders(request)
  const tlist = await (await request.get(`${API_BASE}/api/terminals`, { headers })).json()
  expect(((tlist?.data || []) as { id: string }[]).some(s => s.id === sid)).toBeFalsy()
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('管理页侧栏会话行：同判据停滞强标，点击标开分诊卡且不触发行选中', async ({ page, request }) => {
  // 两个会话：管理页对第一个系统会话自动 active（useAgentTerminal.refresh 修正
  // 活动会话），「点击标不触发行选中」须在第二个会话行上才可判别
  const firstId = await createAgentSession(request, 'stall-triage-row-auto')
  const sid = await createAgentSession(request, 'stall-triage-row')
  expect(firstId).toBeTruthy()

  await fixedLocale(page)
  // docked 管理页开合状态持久化在 localStorage：预置打开意图，首页引导即恢复
  await page.addInitScript(() => {
    localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'docked' }))
  })
  await gotoAndUnlock(page, `${API_BASE}/`)
  const view = page.locator('.atv-root')
  await expect(view).toBeVisible({ timeout: 15000 })
  const row = view.locator('.ats-item').filter({ hasText: 'stall-triage-row' }).filter({ hasNotText: 'stall-triage-row-auto' })
  await expect(row).toBeVisible({ timeout: 15000 })

  await injectStallState(page, [{
    id: sid, running: false, staleMin: STALL_MIN, reportAgeMin: STALL_MIN,
    task: '侧栏停滞', command: 'npm run build', exitCode: 1,
  }])
  const badge = row.locator('.ats-item-idle.is-stall')
  await expect(badge).toHaveText('疑似停滞 6 分钟')
  await expect(row).toHaveAttribute('title', /可能已停滞，点击分诊/)

  // 点击停滞标：开分诊卡且截停（若冒泡泄漏，行选中会让本行 active——自动选中
  // 只落在第一个会话，本行初始必非 active）
  await badge.click()
  const dialog = page.locator('[data-testid="stall-triage-dialog"]')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText('npm run build')
  await expect(dialog).toContainText('退出码 1')
  await expect(row).not.toHaveClass(/active/)
})
