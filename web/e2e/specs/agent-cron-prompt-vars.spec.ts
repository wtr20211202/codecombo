import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * cron prompt 运行时变量注入 E2E（P-20261003-167）：
 * prompt 模板含 {date}/{time}/{weekday} 时，发起链（ComposeLaunchArgs）在
 * 触发时展开为实际值、未知占位符原样透传。经「立即试跑」走与到期触发同一
 * 执行链（runner.trigger → ComposeLaunchArgs，cron-history.spec.ts 同先例，
 * 免分钟级调度等待），以 shell 会话 scrollback 回显的注入命令为证据；另锁
 * 设置分区 prompt 字段的占位符变量提示（前端只提示不预展开）。
 * 任务与会话经共享实例 API 清理，不残留测试数据
 */

const CRON_NAME = `e2e-cronvars-${Date.now()}`

/** 去 ANSI 转义（CSI/OSC/其余 C1）：PowerShell PSReadLine 的语法高亮会把
 *  命令回显按 token 分段插颜色码（{ } 片段必分段），整串 includes 前须剥离，
 *  剥离后字符连续、子串匹配跨颜色段成立 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g, '')
}

interface CronItem { id?: string; name?: string; lastResult?: string }
interface SessionInfo { id?: string; name?: string; kind?: string }

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function cleanup() {
  const headers = await unlockHeaders()
  const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
  const crons = ((await listRes.json()) as { data?: CronItem[] }).data || []
  for (const c of crons) {
    if (c.name?.startsWith('e2e-cronvars-') && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
  const tRes = await fetch(`${API_BASE}/api/terminals`, { headers })
  const sessions = ((await tRes.json()) as { data?: SessionInfo[] }).data || []
  for (const s of sessions) {
    if (s.name?.startsWith('e2e-cronvars-') && s.id) {
      await fetch(`${API_BASE}/api/terminals/${s.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

test.describe('agent cron prompt runtime variables', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('试跑触发：launchArgs 含展开后日期/星期，未知占位符透传，设置分区有占位符提示', async ({ page }) => {
    await cleanup() // 上次中断遗留的同前缀任务/会话先清
    const headers = await unlockHeaders()

    // 模板：三枚已知变量 + 一枚未知变量。shell 会话把 prompt 作为首条命令
    // 注入执行，scrollback 回显的即展开后的 launchArgs
    const prompt = 'echo CRONVARS_{date}_W{weekday}_X{nosuchvar}_END'
    const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: CRON_NAME,
        hour: 2,
        minute: 0,
        weekdays: [],
        runtime: 'shell',
        prompt,
        dir: '',
        enabled: true,
        missCatchUp: true,
      }),
    })
    expect(createRes.ok).toBeTruthy()
    const created = ((await createRes.json()) as { data?: CronItem }).data
    expect(created?.id).toBeTruthy()

    // 立即试跑 = 与到期触发同一执行链（服务端在本次请求内展开变量）
    const runRes = await fetch(`${API_BASE}/api/agent-crons/${created!.id}/run`, { method: 'POST', headers })
    expect(runRes.ok).toBeTruthy()
    const run = ((await runRes.json()) as { data?: { id?: string; launched?: boolean } }).data
    expect(run?.launched).toBeTruthy()
    const sessionId = run?.id || ''

    // 展开证据：scrollback 回显 CRONVARS_<当日日期>_W<星期英文名>_X{nosuchvar}_END
    const now = new Date()
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
    const weekday = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][now.getDay()]
    let echoed = ''
    for (let i = 0; i < 10 && !echoed; i++) {
      const sb = await fetch(`${API_BASE}/api/terminals/${sessionId}/scrollback`, { headers })
      echoed = stripAnsi(await sb.text())
      if (!echoed.includes(`CRONVARS_${date}_W${weekday}_X{nosuchvar}_END`)) {
        echoed = ''
        await page.waitForTimeout(2000)
      }
    }
    expect(echoed, 'scrollback should echo the expanded launchArgs').toBeTruthy()
    // {date} 展开为当日日期（DBGVARS_ 前缀锚定是模板展开而非尾部计划戳）
    expect(echoed).toContain(`CRONVARS_${date}`)
    // {weekday} 展开为星期英文名、{time} 后缀计划戳同屏
    expect(echoed).toContain(`_W${weekday}_X`)
    // 模板原样（未展开形态）不得出现：{date} 已被消费而非字面注入
    expect(echoed).not.toContain('CRONVARS_{date}')
    // 未知占位符原样透传（agent 可读到未识别变量）
    expect(echoed).toContain('X{nosuchvar}_END')

    // 运行期事实：lastResult=launched（同一执行链记账）
    const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
    const items = ((await listRes.json()) as { data?: CronItem[] }).data || []
    expect(items.find(c => c.name === CRON_NAME)?.lastResult).toBe('launched')

    // 设置分区占位符提示（前端不预展开，只提示变量集合与配额口径）
    await fixedLocale(page)
    await closeDshConsoleAndClearState(page, page.request, API_BASE)
    await gotoAndUnlock(page, '/')
    await projectCardByName(page, 'simple-coding').first().click()
    await page.waitForURL('**/project')
    await page.locator('[data-testid="rail-settings"]').click()
    const modal = page.locator('.n-modal.settings-modal')
    await expect(modal).toBeVisible()
    await modal.locator('.nav-item').filter({ hasText: '定时任务' }).click()
    const manager = modal.locator('[data-testid="agentcron-manager"]')
    await expect(manager).toBeVisible()
    await manager.locator('[data-testid="agentcron-add"]').click()
    // 新增/编辑表单是独立顶层 NModal（非 settings-modal 后代），从 page 找；
    // data-testid 落在 .n-input 包裹层，placeholder 在内层 textarea 上
    const promptInput = page.locator('[data-testid="agentcron-form-prompt"] textarea')
    await expect(promptInput).toBeVisible()
    await expect(promptInput).toHaveAttribute('placeholder', /{date}/)
    await expect(promptInput).toHaveAttribute('placeholder', /{weekday}/)
    await expect(page.locator('[data-testid="agentcron-form-prompt-vars-hint"]')).toContainText('{time}')
  })
})
