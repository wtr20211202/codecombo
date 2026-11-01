import { test, expect, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 服务日志查看器 E2E（P-20261008-15）：本机服务自身运行日志的应用内只读面
 * （GET /api/system/logs 尾部窗口 + GET /api/system/logs/dates 日期清单，
 * 设置·系统监控分区「服务日志」承载）。
 *
 *   1. API 形状（真实例）：dates 降序日期数组；tail 响应五字段齐备、masked
 *      默认开、limit 截尾；q 过滤命中行全部包含关键词；非法日期 400。
 *      服务端倒读/遮蔽/预算语义由 Go 单测覆盖
 *      （server/api/system/servicelogs_test.go），此处只对账契约面。
 *   2. UI 链路（网络层 mock，确定性夹具）：窗口渲染 + 截尾/遮蔽注记 + 关键词
 *      过滤（防抖后带 q 重拉）+ 日期切换（带 date 重拉）+ 复制到剪贴板含尾部
 *      + 「交给智能体修复」POST /api/terminals launchArgs 含日志尾部
 *      （error-to-agent 同款请求体断言）。
 */

const MARKER = 'SVCLOG-E2E-MARKER'

// ── UI 夹具：窗口 5 行（首行早、尾行新，截尾语义）───────────────────────
const TAIL_LINES = [
  '2026-10-24 09:00:01 [INFO] simple-coding starting',
  '2026-10-24 09:00:02 [INFO] kernel modules started',
  `2026-10-24 09:00:03 [WARN] watcher degraded ${MARKER}-WARN-1`,
  '2026-10-24 09:00:04 [INFO] gin GET /api/health 200',
  `2026-10-24 09:00:05 [ERROR] update check failed ${MARKER}-BOOT-COMPLETE`,
]

function tailBody(date: string, lines: string[]) {
  return {
    data: { date, lines, truncated: true, missing: false, masked: true },
  }
}

/** 打开设置·系统监控分区（monitor-trend 同入口），等待服务日志分区挂载 */
async function openServerLogs(page: Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.locator('.rail-btn[title="设置"]').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  // 分区语义锚点（P-20261002-151）：不依赖导航序下标
  await page.locator('[data-testid="settings-nav-monitor"]').click()
  const section = page.locator('[data-testid="svclog"]')
  await expect(section).toBeVisible({ timeout: 5000 })
  return section
}

test.describe('服务日志 API 形状（真实例）', () => {
  test('dates 清单：降序日期数组；tail 窗口：五字段齐备 + masked 默认开 + q 过滤', async ({ request }) => {
    const datesRes = await request.get(`${API_BASE}/api/system/logs/dates`)
    expect(datesRes.status()).toBe(200)
    const dates = ((await datesRes.json()) as { data?: string[] }).data || []
    // 实例运行中当日日志文件必在（gin 访问日志每请求落盘）；降序 = 字典序降序
    expect(dates.length).toBeGreaterThan(0)
    for (const d of dates) expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect([...dates].sort().reverse()).toEqual(dates)

    // 尾部窗口：五字段齐备；limit 生效；masked 默认开（服务端遮蔽防线在册）
    const tailRes = await request.get(`${API_BASE}/api/system/logs?limit=5`)
    expect(tailRes.status()).toBe(200)
    const tail = ((await tailRes.json()) as { data?: { date: string; lines: string[]; truncated: boolean; missing: boolean; masked: boolean } }).data
    expect(tail).toBeTruthy()
    expect(tail!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(Array.isArray(tail!.lines)).toBe(true)
    expect(tail!.lines.length).toBeLessThanOrEqual(5)
    expect(tail!.missing).toBe(false)
    expect(tail!.masked).toBe(true)
    expect(typeof tail!.truncated).toBe('boolean')

    // q 过滤：实例自身访问日志恒含 gin 请求行——命中行全部包含关键词
    //（大小写不敏感）；本请求自身也会产生日志行，不受窗口截取时点影响
    const qRes = await request.get(`${API_BASE}/api/system/logs?q=gin&limit=50`)
    expect(qRes.status()).toBe(200)
    const qTail = ((await qRes.json()) as { data?: { lines: string[]; missing: boolean } }).data
    expect(qTail!.missing).toBe(false)
    for (const line of qTail!.lines) {
      expect(line.toLowerCase()).toContain('gin')
    }

    // 非法日期：400（稳定原文，agent/前端可编程分支）
    const bad = await request.get(`${API_BASE}/api/system/logs?date=not-a-date`)
    expect(bad.status()).toBe(400)
  })
})

test.describe('服务日志 UI 链路（mock 夹具）', () => {
  test('窗口渲染 + 截尾/遮蔽注记 + 过滤重拉 + 日期切换 + 复制剪贴板含尾部', async ({ page }) => {
    test.setTimeout(120_000)
    // 请求对账：过滤/切日期的重拉参数
    const tailUrls: string[] = []
    await page.route('**/api/system/logs/dates', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: ['2026-10-23', '2026-10-22'] }) }))
    // `*` 不跨 `/`：匹配 /api/system/logs（首拉无 query）与 ?limit=... 形态，
    // 不误伤 /api/system/logs/dates
    await page.route('**/api/system/logs*', (route) => {
      const url = new URL(route.request().url())
      tailUrls.push(url.search)
      const q = url.searchParams.get('q') || ''
      const date = url.searchParams.get('date') || '2026-10-24'
      // 夹具对账：q=MARKER 只回 2 条命中（WARN 行与 ERROR 行）；否则全窗
      const lines = q.includes(MARKER)
        ? TAIL_LINES.filter((l) => l.includes(MARKER))
        : TAIL_LINES
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tailBody(date, lines)) })
    })
    // 首拉之外其余 API 放行真实例（gotoAndUnlock 链路依赖）

    const section = await openServerLogs(page)

    // 窗口渲染：尾部最新行在场；截尾 + 遮蔽注记齐备；行数计数
    const lines = section.locator('[data-testid="svclog-lines"]')
    await expect(lines).toContainText(`${MARKER}-BOOT-COMPLETE`)
    await expect(lines).toContainText('simple-coding starting')
    await expect(section.locator('[data-testid="svclog-truncated"]')).toBeVisible()
    await expect(section.locator('[data-testid="svclog-masked"]')).toBeVisible()
    await expect(section.locator('[data-testid="svclog-meta"]')).toContainText('5 行')

    // 关键词过滤：防抖后带 q 重拉，窗口只剩命中行、计数同步
    await section.locator('[data-testid="svclog-search"] input').fill(MARKER)
    const filtered = section.locator('[data-testid="svclog-lines"]')
    await expect.poll(() => tailUrls.some((s) => s.includes('q='))).toBe(true)
    await expect(filtered).toContainText(`${MARKER}-WARN-1`)
    await expect(filtered).toContainText(`${MARKER}-BOOT-COMPLETE`)
    await expect(filtered).not.toContainText('simple-coding starting')
    await expect(section.locator('[data-testid="svclog-meta"]')).toContainText('2 行')

    // 复制到剪贴板：含日志尾部（错误日志面板 copyRaw 同族交互）
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
    await section.locator('[data-testid="svclog-copy"]').click()
    const clip = await page.evaluate(() => navigator.clipboard.readText())
    expect(clip.replace(/\r\n/g, '\n')).toContain(`${MARKER}-BOOT-COMPLETE`)

    // 日期切换：带 date 参数重拉（NSelect 语义锚点内点选历史日期档）
    await section.locator('[data-testid="svclog-date"]').click()
    await page.locator('.n-base-select-option').filter({ hasText: '2026-10-23' }).click()
    await expect.poll(() => tailUrls.some((s) => s.includes('date=2026-10-23'))).toBe(true)

    // 刷新按钮在场可用（手动重拉入口）
    await expect(section.locator('[data-testid="svclog-refresh"]')).toBeEnabled()
  })

  test('「交给智能体修复」→ POST /api/terminals launchArgs 含日志尾部（error-to-agent 同族）', async ({ page, request }) => {
    test.setTimeout(120_000)
    await page.route('**/api/system/logs/dates', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }))
    await page.route('**/api/system/logs*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tailBody('2026-10-24', TAIL_LINES)) }))

    // 会话表清场（error-to-agent 同款：恰一条断言基于空白会话表）
    const unlock = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
    const headers = { 'Content-Type': 'application/json', 'X-Lock-Token': ((await unlock.json()) as { token?: string }).token || '' }
    const listRes = await request.get(`${API_BASE}/api/terminals`, { headers })
    for (const s of ((await listRes.json()) as { data?: { id: string }[] }).data || []) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }

    await openServerLogs(page)
    // 无项目上下文也可发起（serverLog 免项目链）：设置面从项目页打开，此处
    // 项目在场 → dir=项目根；断言走请求体，与 dir 形态解耦
    const reqPromise = page.waitForRequest((r) => r.url().includes('/api/terminals') && r.method() === 'POST')
    await page.locator('[data-testid="svclog-agent"]').click()

    const req = await reqPromise
    const body = req.postDataJSON() as { kind?: string; launchArgs?: string }
    expect(body.kind).toBe('agent')
    // prompt：服务日志头行 + 日期对账锚 + 尾部窗口（含最新行）
    expect(body.launchArgs).toContain('服务运行日志')
    expect(body.launchArgs).toContain('2026-10-24')
    expect(body.launchArgs).toContain(`${MARKER}-BOOT-COMPLETE`)

    // 收尾：清掉本用例创建的会话，不污染共享实例
    const after = await request.get(`${API_BASE}/api/terminals`, { headers })
    for (const s of ((await after.json()) as { data?: { id: string }[] }).data || []) {
      await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
    }
  })
})
