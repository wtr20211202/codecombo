import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, waitForAppReady, unlockIfNeeded } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 审计查询键集游标分页（P-20261003-223）E2E：
 *   - API：cursor 走键集续翻——头部行走与 offset 全序逐位一致（不重）、尾部锚定
 *     行走恰取末页且终页无 nextCursor（不漏 + 到底判定）、翻页间隙新增事件窗口
 *     不后移（稳定性核心动机）、offset 旧参数保留兼容、非法 cursor 400
 *   - UI：审计面板无过滤视图滚动加载——近底续翻逐页追加，种子事件（列表头部
 *     最新段）逐条恰好一次且与 API 顺序逐位一致（不重不漏）；总量小（≤150）
 *     时加验滚到到底静停
 * 断言全部规模无关：合跑时实例可能已积累数百条存量事件（auditMaxLimit=500
 * 钳制单页，offset 基线不做「一页拿全」假设）。
 * 前置：后端实例已 setup admin（e2e-restart.sh 负责）。种子 = 凭据保存事件
 * （一次 POST 恰好一条审计、Time=now 落列表头部，host 唯一 → 行文本唯一），
 * afterAll 全量清理凭据。
 */

interface AuditRow {
  id: string
  time: string
  action: string
  detail?: string
}

interface AuditPage {
  data: AuditRow[]
  total: number
  nextCursor?: string
}

async function unlockToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, { data: { password: DEFAULT_PASSWORD } })
  if (!res.ok()) throw new Error(`unlock failed: ${res.status()}`)
  return ((await res.json()) as { token: string }).token
}

// 播种 N 条凭据保存审计事件（host 唯一 → 审计 Detail「user@host (create)」唯一）
async function seedAuditEvents(request: APIRequestContext, headers: object, n: number, prefix: string): Promise<void> {
  for (let i = 0; i < n; i++) {
    const res = await request.post(`${API_BASE}/api/credentials`, {
      headers,
      data: { host: `${prefix}-${i}.example.com`, username: 'cursor-e2e', secret: 'irrelevant' },
    })
    expect(res.ok()).toBeTruthy()
  }
}

// 清理本文件播种的凭据（按 host 前缀识别，防污染其他用例的凭据列表面）
async function cleanupSeededCredentials(request: APIRequestContext, headers: object, prefixes: string[]): Promise<void> {
  const list = await request.get(`${API_BASE}/api/credentials`, { headers })
  if (!list.ok()) return
  const creds = ((await list.json()) as { data?: { id: string; host: string }[] }).data || []
  for (const c of creds) {
    if (prefixes.some(p => c.host.startsWith(p))) {
      await request.delete(`${API_BASE}/api/credentials/${c.id}`, { headers })
    }
  }
}

test.describe('审计键集游标分页（P-20261003-223）', () => {
  const seedPrefixes = ['cursor-api-seed', 'cursor-scroll-seed']

  test.afterAll(async ({ request }) => {
    const token = await unlockToken(request)
    await cleanupSeededCredentials(request, { 'X-Lock-Token': token }, seedPrefixes)
  })

  // API 层：键集游标语义（头部/尾部行走、稳定性、兼容形态、非法拒绝）
  test('API cursor 续翻：与 offset 全序一致不重不漏 + 新增事件窗口不后移', async ({ request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    await seedAuditEvents(request, headers, 12, 'cursor-api-seed')

    const get = async (query: string) =>
      await request.get(`${API_BASE}/api/audit${query}`, { headers })

    const total = ((await (await get('?limit=1')).json()) as AuditPage).total
    expect(total).toBeGreaterThanOrEqual(12)

    // 首页（旧 offset 形态）：满页附 nextCursor（增量扩展，旧客户端忽略零影响）
    const page1 = await (await get('?limit=5&offset=0')).json() as AuditPage
    expect(page1.data.length).toBe(5)
    expect(page1.nextCursor).toBeTruthy()

    // offset 头部基线（20 ≥ 本用例行走窗口，绕开单页 500 钳制的规模假设）
    const head = (await (await get('?limit=20&offset=0')).json() as AuditPage).data

    // offset 旧参数保留兼容：切片语义不变；满页 offset 响应同样附 nextCursor
    //（混合形态——旧客户端忽略，新客户端可从任意一页切入键集续翻）
    const legacy = await (await get('?limit=3&offset=2')).json() as AuditPage
    expect(legacy.data.map(e => e.id)).toEqual(head.slice(2, 5).map(e => e.id))
    expect(legacy.nextCursor).toBeTruthy()
    // 页未满（越界空页）不带 nextCursor——「到底」的契约形状
    const emptyPage = await (await get('?limit=5&offset=999999')).json() as AuditPage
    expect(emptyPage.data.length).toBe(0)
    expect(emptyPage.nextCursor).toBeUndefined()

    // 键集头部行走（3 页）：与 offset 同窗逐位一致——不重（id 唯一）序不漂
    const walked: AuditRow[] = [...page1.data]
    let cursor = page1.nextCursor!
    for (let p = 1; p < 3 && cursor; p++) {
      const page = await (await get(`?limit=5&cursor=${encodeURIComponent(cursor)}`)).json() as AuditPage
      walked.push(...page.data)
      cursor = page.nextCursor || ''
    }
    expect(new Set(walked.map(e => e.id)).size).toBe(walked.length)
    expect(walked.map(e => e.id)).toEqual(head.slice(0, walked.length).map(e => e.id))

    // 键集尾部锚定行走：锚在倒数第 6 条，续翻恰取末 5 条且终页无 nextCursor
    //——「走到底不出缺页」的端到端证明（全量行走在大库上不可负担，尾部即边界）。
    // 锚 cursor 取服务端 offset 满页响应的 nextCursor：limit=2&offset=total-7
    // 是末 2 行的满页（页尾 = 倒数第 6 条），顺带验证 offset→cursor 混合切入
    const anchorResp = await (await get(`?limit=2&offset=${total - 7}`)).json() as AuditPage
    expect(anchorResp.data.length).toBe(2)
    expect(anchorResp.nextCursor).toBeTruthy()
    const tailBase = await (await get(`?limit=5&offset=${total - 5}`)).json() as AuditPage
    const tail = await (await get(`?limit=5&cursor=${encodeURIComponent(anchorResp.nextCursor!)}`)).json() as AuditPage
    expect(tail.data.map(e => e.id)).toEqual(tailBase.data.map(e => e.id))
    // 恰好整除的末页仍是满页 → 按通行语义带 nextCursor（多一次空页取数换
    // 稳定性）；再取一页必为空页且不带——「到底」的完整判定形状
    expect(tail.nextCursor).toBeTruthy()
    const afterTail = await (await get(`?limit=5&cursor=${encodeURIComponent(tail.nextCursor!)}`)).json() as AuditPage
    expect(afterTail.data.length).toBe(0)
    expect(afterTail.nextCursor).toBeUndefined()

    // 稳定性核心：头部行走中新增事件，锚定续页不后移——cursor 续翻首页的首条
    // 必须仍是原序列第 6 条（offset 同场景会整体后移造成跨页重复）
    const page1Anchor = page1.data[4]!.id
    await seedAuditEvents(request, headers, 1, 'cursor-api-seed')
    const cont = await (await get(`?limit=5&cursor=${encodeURIComponent(page1.nextCursor!)}`)).json() as AuditPage
    expect(cont.data[0]!.id).toBe(head[5]!.id)
    expect(cont.data.map(e => e.id)).not.toContain(page1Anchor)

    // 非法 cursor：400 明确拒绝（不静默回落成对不齐的页）
    const bad = await get('?limit=5&cursor=garbage')
    expect(bad.status()).toBe(400)
  })

  // UI 层：无过滤视图滚动加载——逐页追加、种子逐条恰好一次、顺序与 API 一致
  test('审计面板滚动加载：续翻逐页追加不重不漏，顺序与服务端一致', async ({ page, request }) => {
    const token = await unlockToken(request)
    const headers = { 'X-Lock-Token': token }

    // 45 条种子（Time=now 落列表头部最新段）→ 至少两次续翻（20 → 40 → 60），
    // 足以验证 cursor 链式传递；全部种子落在前 3 页窗口内
    await seedAuditEvents(request, headers, 45, 'cursor-scroll-seed')

    await openAuditPane(page)

    const rows = page.locator('[data-testid="audit-pane"] .n-data-table-tr:has(td)')
    await expect(rows.first()).toBeVisible({ timeout: 5000 })

    const totalText = await page.getByTestId('audit-total').textContent()
    const total = Number(totalText?.match(/共 (\d+) 条/)?.[1])
    expect(total).toBeGreaterThanOrEqual(45)
    await expect(rows).toHaveCount(20)

    // 近底滚动续翻至 ≥60 行（3 页，链式 cursor 传递两次以上）
    const scrollBox = page.getByTestId('audit-scroll')
    await expect.poll(async () => {
      if (await rows.count() < 60) {
        await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
      }
      return rows.count()
    }, { timeout: 20000, intervals: [400] }).toBeGreaterThanOrEqual(60)

    // 不重：45 条种子逐条恰好一次（host 唯一 → 行文本唯一）
    const texts = await rows.allTextContents()
    const seeded = texts.filter(t => t.includes('cursor-scroll-seed'))
    expect(seeded.length).toBe(45)
    expect(new Set(seeded).size).toBe(45)

    // 不漏 + 顺序正确：已加载窗口内的种子序列与 API 同窗逐位一致（服务端
    // time 倒序即 DOM 序；detail 含唯一 host，可从行文本中提取对齐）
    const head = (await (await page.request.get(`${API_BASE}/api/audit?limit=60&offset=0`, { headers })).json()) as AuditPage
    const apiSeeded = head.data
      .filter(e => (e.detail || '').includes('cursor-scroll-seed'))
      .map(e => (e.detail || '').match(/cursor-scroll-seed-\d+/)?.[0])
    const domSeeded = seeded.map(t => t.match(/cursor-scroll-seed-\d+/)?.[0])
    expect(domSeeded).toEqual(apiSeeded)

    // 到底静停（总量小才做——大库滚到底是服务端契约，已由 API 尾部行走覆盖）
    if (total <= 150) {
      await expect.poll(async () => {
        if (await rows.count() < total) {
          await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
        }
        return rows.count()
      }, { timeout: 30000, intervals: [400] }).toBe(total)
      // 到底后滚动零增长（末页无 nextCursor 静停）
      await scrollBox.evaluate((el) => { el.scrollTop = el.scrollHeight })
      await page.waitForTimeout(500)
      expect(await rows.count()).toBe(total)
    } else {
      console.log(`[audit-cursor-scroll] total=${total} > 150，跳过 UI 到底段（API 尾部行走已覆盖）`)
    }
  })
})

// 设置 → 安全 → 审计日志 Tab（audit-log.spec 同款入口）
async function openAuditPane(page: Page): Promise<void> {
  await fixedLocale(page)
  await page.goto(`${API_BASE}/`)
  await waitForAppReady(page)
  await unlockIfNeeded(page)
  await page.getByRole('button', { name: '设置' }).click()
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 5000 })
  await page.locator('.settings-nav .nav-item').filter({ hasText: '安全' }).click()
  await expect(page.locator('.security-settings')).toBeVisible({ timeout: 3000 })
  await page.locator('.security-settings .n-tabs-tab').filter({ hasText: '审计日志' }).click()
  await expect(page.getByTestId('audit-pane')).toBeVisible({ timeout: 5000 })
}
