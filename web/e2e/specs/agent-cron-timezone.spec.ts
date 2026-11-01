import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, closeDshConsoleAndClearState, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 定时任务评估时区 E2E（P-20261005-217）：
 * 跨时区换算正确性（Evaluate/预览/DST/非法名回落）由 Go 单测锁定
 * （server/api/agentcron/cron_timezone_test.go），本用例锁真实服务端全链路：
 * ① API 面——创建带 timezone 的任务持久化回读、列表响应携 server 时区快照
 * （name/now/utcOffset）、非法 IANA 名保存口 400；② UI 面——设置面板服务器
 * 时区对表行、显式时区任务的行内徽标、编辑表单回填与当地时刻标注。
 * 任务建为停用态（调度器不触发，无分钟级等待）；两用例各自播种任务、
 * 经共享实例 API 清理，不残留测试数据
 */

const CRON_NAME = `e2e-crontz-${Date.now()}`
const CRON_PREFIX = 'e2e-crontz-'
const TZ = 'Asia/Tokyo' // UTC+9 无夏令时：断言稳定

interface CronItem { id?: string; name?: string; timezone?: string }

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
    if (c.name?.startsWith(CRON_PREFIX) && c.id) {
      await fetch(`${API_BASE}/api/agent-crons/${c.id}`, { method: 'DELETE', headers }).catch(() => {})
    }
  }
}

/** 播种一个停用态带时区任务（调度器不触发，本 spec 不等待分钟级调度） */
async function seedCron(timezone: string, name = CRON_NAME): Promise<void> {
  const headers = await unlockHeaders()
  const createRes = await fetch(`${API_BASE}/api/agent-crons`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name,
      hour: 9,
      minute: 0,
      weekdays: [],
      timezone,
      runtime: 'shell',
      prompt: 'echo cron-tz-e2e',
      dir: '',
      enabled: false,
      missCatchUp: false,
    }),
  })
  expect(createRes.ok).toBeTruthy()
}

test.describe('agent cron evaluation timezone', () => {
  test.afterAll(async () => {
    await cleanup()
  })

  test('timezone 字段持久化 + 列表 server 段 + 非法名 400（API 面）', async () => {
    await cleanup()
    const headers = await unlockHeaders()
    await seedCron(TZ)

    // 列表回读：timezone 透传 + server 段三键齐备（now 壁钟 + 数字偏移）
    const listRes = await fetch(`${API_BASE}/api/agent-crons`, { headers })
    const body = (await listRes.json()) as {
      data?: CronItem[]
      server?: { name?: string; now?: string; utcOffset?: string }
    }
    expect(body.data?.find(c => c.name === CRON_NAME)?.timezone).toBe(TZ)
    expect(body.server?.name).toBeTruthy()
    expect(body.server?.now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/)
    expect(body.server?.utcOffset).toMatch(/^[+-]\d{2}:\d{2}$/)

    // 非法 IANA 名：保存口 LoadLocation 前置校验 400 不落库
    const bad = await fetch(`${API_BASE}/api/agent-crons`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: `${CRON_PREFIX}bad`,
        hour: 9,
        minute: 0,
        weekdays: [],
        timezone: 'Not/AZone',
        runtime: 'shell',
        prompt: 'echo bad',
        dir: '',
        enabled: false,
        missCatchUp: false,
      }),
    })
    expect(bad.status).toBe(400)
  })

  test('面板对表行 + 行内时区徽标 + 表单回填当地时刻标注（UI 面）', async ({ page }) => {
    await cleanup()
    await seedCron(TZ)

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

    // 服务器时区对表行：面板级标注可见（服务器时区 + 当前时刻）
    const serverLine = manager.locator('[data-testid="agentcron-server-tz"]')
    await expect(serverLine).toBeVisible()
    await expect(serverLine).toContainText('服务器')
    await expect(serverLine).toContainText(/\d{2}:\d{2}/)

    // 显式时区任务：行内徽标（时区名 · 偏移）
    const row = manager.locator(`[data-testid="agentcron-item-${CRON_NAME}"]`)
    await expect(row).toBeVisible()
    const badge = row.locator('[data-testid="agentcron-timezone-tag"]')
    await expect(badge).toBeVisible()
    await expect(badge).toContainText(TZ)
    await expect(badge).toContainText('UTC+9')

    // 编辑表单：时区回填候选值 + 标注显示当地当前时刻（对表）
    await row.locator('button', { hasText: '编辑' }).click()
    const dialog = page.locator('.n-modal').filter({ has: page.locator('[data-testid="agentcron-form-name"]') })
    await expect(dialog).toBeVisible()
    const tzSelect = dialog.locator('[data-testid="agentcron-form-timezone"]')
    await expect(tzSelect).toContainText(TZ)
    const hint = dialog.locator('[data-testid="agentcron-form-timezone-hint"]')
    await expect(hint).toContainText(TZ)
    await expect(hint).toContainText(/当地当前 \d{2}:\d{2}/)
  })
})
