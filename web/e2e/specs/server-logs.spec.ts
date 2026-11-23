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

/**
 * 诊断包导出 E2E（P-20261122-10 S2a）：设置·系统监控「服务日志」分区的
 * 「导出诊断包」按钮 + GET /api/system/diagnostics/export。
 *
 *   1. API 形状（真实例）：probe=1 只回体量预览（200 JSON，files/totals/limits
 *      齐备、凭据路径不入清单、缺席条目可见）；不触发打包 → 不吃 30s 冷却、
 *      可安全重复跑。正式导出的 zip 内容/脱敏/预算语义由 Go 单测覆盖
 *      （server/diagnostics + server/api/system/diagnostics_test.go）。
 *   2. UI 链路（网络层 mock，确定性夹具）：点按钮 → 先带 probe=1 取体量 →
 *      再触发同源直链下载（不经 blob）→ 体量提示就地可见。
 */
const PROBE_FIXTURE = {
  generatedAt: '2026-10-24T09:00:00Z',
  version: '0.0.1-test',
  source: 'api',
  mask: true,
  logDays: 3,
  files: [
    { name: 'logs/codecombo-2026-10-24.log', status: 'present', originalBytes: 1048576, includedBytes: 1048576 },
    { name: 'logs/update.log', status: 'absent', originalBytes: 0, includedBytes: 0, reason: 'expected file absent' },
    { name: 'logs/dsh-web.log', status: 'present', originalBytes: 524288, includedBytes: 524288 },
  ],
  totals: { files: 3, packedFiles: 3, absent: 1, truncated: 0, omitted: 0, includedBytes: 1572864, zipUpperBoundBytes: 1572864 },
  limits: { fullFileBytes: 8388608, headBytes: 2097152, tailBytes: 14680064, rawBudgetBytes: 100663296, zipCapBytes: 67108864 },
  derivedFiles: ['README.txt', 'manifest.json', 'logs-summary.txt'],
}

test.describe('诊断包导出 API 形状（真实例）', () => {
  test('probe=1 体量预览：files/totals/limits 齐备 + 凭据路径不在清单', async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/system/diagnostics/export?probe=1`)
    expect(res.status()).toBe(200)
    const data = ((await res.json()) as {
      data?: {
        files?: { name: string; status: string; includedBytes: number }[]
        totals?: { files: number; packedFiles: number; includedBytes: number }
        limits?: { rawBudgetBytes: number; zipCapBytes: number }
        derivedFiles?: string[]
      }
    }).data
    expect(data).toBeTruthy()
    expect(data!.files!.length).toBeGreaterThan(0)
    // 实例运行中当天主日志必在（packedFiles>0 即证明计划里真有东西要打）
    expect(data!.totals!.packedFiles).toBeGreaterThan(0)
    expect(data!.limits!.rawBudgetBytes).toBe(96 * 1024 * 1024)
    expect(data!.limits!.zipCapBytes).toBe(64 * 1024 * 1024)
    expect(data!.derivedFiles!.length).toBeGreaterThan(0)
    // dsh-web.log 在 DataDir 根不在 logs/——显式列举才会出现在清单里
    expect(data!.files!.some((f) => f.name === 'logs/dsh-web.log')).toBe(true)
    // 更新链条目恒在清单（缺席则 status=absent，本身就是判别证据）
    expect(data!.files!.some((f) => f.name.startsWith('logs/update'))).toBe(true)
    // 凭据路径绝不出现
    for (const f of data!.files!) {
      expect(f.name).not.toContain('master-key')
      expect(f.name).not.toContain('config.json')
    }
  })
})

test.describe('诊断包导出 UI 链路（mock 夹具）', () => {
  test('点「导出诊断包」→ 先 probe 取体量再直链下载 + 体量提示可见', async ({ page }) => {
    test.setTimeout(120_000)
    const probeCalls: string[] = []
    // 下载导航在 Chromium 里由浏览器网络栈发起，page.route 不保证拦得到
    // （实测：直链请求直接打到真实例，suggestedFilename 带服务端时间戳）——
    // 这里改在 DOM 层截获程序化锚点点击：断言「先 probe、再发起同源直链」的
    // 契约，且**不重复打真包**（真包产出/流式/脱敏由 Go 单测 + 本文件真实例
    // probe 用例覆盖，避免 e2e 每次跑都做一次几十 MB 的采集）
    await page.addInitScript(() => {
      const w = window as unknown as { __diagClicks?: { href: string; download: string }[] }
      w.__diagClicks = []
      const origClick = HTMLAnchorElement.prototype.click
      HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        if (this.href.includes('/api/system/diagnostics/export')) {
          w.__diagClicks!.push({ href: this.href, download: this.download })
          return // 拦下真实导航（测的是触发契约，不是再打一次包）
        }
        return origClick.call(this)
      }
    })
    await page.route('**/api/system/logs/dates', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [] }) }))
    await page.route('**/api/system/logs*', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(tailBody('2026-10-24', TAIL_LINES)) }))
    await page.route('**/api/system/diagnostics/export*', (route) => {
      const url = new URL(route.request().url())
      probeCalls.push(url.search)
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: PROBE_FIXTURE }) })
    })

    const section = await openServerLogs(page)
    await section.locator('[data-testid="svclog-diag"]').click()

    // 先 probe（体量预览），再触发下载直链
    await expect.poll(() => probeCalls.length).toBeGreaterThan(0)
    expect(probeCalls[0]).toContain('probe=1')
    // 锚点点击发生在 probe 响应回来之后（axios 解包 → triggerDirectDownload）：
    // probe 请求被拦获的瞬间页面侧还没点，必须轮询等点击落账
    await expect.poll(async () => page.evaluate(() =>
      (window as unknown as { __diagClicks: { href: string; download: string }[] }).__diagClicks.length),
    { timeout: 10_000 }).toBe(1)
    const clicks = await page.evaluate(() =>
      (window as unknown as { __diagClicks: { href: string; download: string }[] }).__diagClicks)
    // 直链形态：同源导出端点 + days 参数，不带 probe（probe 只用于预览）
    expect(clicks[0].href).toContain('/api/system/diagnostics/export')
    expect(clicks[0].href).toContain('days=3')
    expect(clicks[0].href).not.toContain('probe')
    // 锚点 download 兜底名（服务端 Content-Disposition 是保存名权威，这里只
    // 守兜底名不变，别让重构把它改成 undefined）
    expect(clicks[0].download).toBe('codecombo-diagnostics.zip')
    // 体量提示就地可见（文件数来自 probe 响应）
    await expect(section.locator('[data-testid="svclog-diag-size"]')).toContainText('3 个文件')
  })
})
