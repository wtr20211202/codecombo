import { test, expect, type APIRequestContext } from '@playwright/test'
import fs from 'node:fs'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批裁决历史 CSV 导出（P-20261003-247）：最近裁决下拉尾部「导出裁决 CSV」
 * 出口（服务端 /api/ops-confirm/export 全量转 CSV，审计 CSV 同模式）。
 *   1. UI 出口端到端：API 造 pending → 卡上「允许一次」→ 最近裁决下拉 →
 *      点导出 → 下载文件（名 codecombo-approvals-<日期>.csv，4adaf9da 品牌切换
 *      后客户端合成名；服务端 content-disposition 仍是 simple-coding-）内容含
 *      列头与本用例裁决行（result=allowed）
 *   2. 注入防护 + API 契约：op 以 = 开头的拒绝裁决 → 直连导出端点 →
 *      对应行带 ' 前缀（表格软件公式注入防护）+ 附件下载头
 * 审批记录无删除端点（30 天保留档），resolved 记录跨用例累积：断言一律按
 * 本用例唯一 op 标记过滤，不做全局面计数（approval-recent.spec 同纪律）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

const EXPORT_HEADER = 'op,target,result,agent,createdAt,resolvedAt,detail,reason'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理 pending 审批（卡片全局常驻，残留会污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** API 造 pending 审批，返回 id */
async function createPending(
  request: APIRequestContext,
  op: string,
  detail: string,
): Promise<string> {
  const headers = await unlockHeaders(request)
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { op, target: 'main', detail },
  })
  expect(res.ok()).toBeTruthy()
  const body = ((await res.json()) as { data?: { id?: string; status?: string } }).data
  expect(body?.id).toBeTruthy()
  expect(body?.status).toBe('pending')
  return body!.id!
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
})

test('UI 导出：裁决一条→下载 CSV 含列头与该裁决行', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)

  const marker = `export-e2e-${Date.now()} reset --hard`
  await createPending(request, marker, 'e2e 裁决历史导出')
  await gotoAndUnlock(page, '/')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 允许一次 → 卡清账，最近裁决触发条在场 → 打开下拉
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  const trigger = page.locator('[data-test="aprv-recent-trigger"]')
  await expect(trigger).toBeVisible({ timeout: 10000 })
  await trigger.click()

  // 导出按钮（有回看记录才可达）→ blob 下载，文件名客户端合成（audit 导出同款）
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 10000 }),
    page.locator('[data-test="aprv-recent-export"]').click(),
  ])
  // 下载名客户端合成（ApprovalCards.vue），4adaf9da 品牌切换后前缀 codecombo-
  expect(download.suggestedFilename()).toMatch(/^codecombo-approvals-\d{4}-\d{2}-\d{2}\.csv$/)

  // 内容：列头在首行 + 本用例裁决行（op 可辨 + result=allowed + 裁决时刻）。
  // 本用例字段均无逗号/引号（无 RFC 4180 加引号形态），直接 split 可对位
  const csv = fs.readFileSync(await download.path(), 'utf-8')
  const lines = csv.replace(/^\uFEFF/, '').trim().split(/\r?\n/)
  expect(lines[0]).toBe(EXPORT_HEADER)
  const markerLine = lines.find(l => l.includes(marker))
  expect(markerLine, '裁决行在文件中').toBeTruthy()
  const fields = (markerLine as string).split(',')
  expect(fields).toHaveLength(8)
  expect(fields[2]).toBe('allowed')
  expect(fields[5]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
})

test('注入防护与 API 契约：= 开头 op 带 \' 前缀 + 附件下载头', async ({ request }) => {
  test.setTimeout(60000)

  const marker = `=e2e-inj-${Date.now()} delete file`
  const id = await createPending(request, marker, 'e2e 导出注入防护')
  // 拒绝裁决（API 直达，注入防护与 UI 出口正交）
  const resolve = await request.post(`${BASE}/api/ops-confirm/${id}/resolve`, {
    headers: await unlockHeaders(request), data: { allow: false },
  })
  expect(resolve.ok()).toBeTruthy()

  const res = await request.get(`${BASE}/api/ops-confirm/export`, { headers: await unlockHeaders(request) })
  expect(res.ok()).toBeTruthy()
  expect(res.headers()['content-type']).toContain('text/csv')
  expect(res.headers()['content-disposition']).toContain('simple-coding-approvals-')

  const csv = (await res.text()).replace(/^\uFEFF/, '')
  const lines = csv.trim().split(/\r?\n/)
  expect(lines[0]).toBe(EXPORT_HEADER)
  const markerLine = lines.find(l => l.includes(marker))
  expect(markerLine, '注入样例行在文件中').toBeTruthy()
  // = 开头单元格前置单引号（OWASP CSV 公式注入防护，审计 CSV 同惯例）
  expect(markerLine).toContain(`'${marker}`)
  expect(markerLine).toContain(',denied,')
})
