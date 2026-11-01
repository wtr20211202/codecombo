import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡结构化影响面（P-20261003-319）：
 *   1. 带 impact 的审批 → 卡片顶部徽标行（kind 标签 + 一句话 summary + 文件计数
 *      + 命令清单），detail 散文折叠为次级（点「详情」展开）
 *   2. 不带 impact 的老卡 → 无徽标行，detail 原样全显（降级 = 现状零破坏）
 *   3. 坏载荷 → 400 稳定码 ops.confirm_impact_invalid（agent 按 code 分支自纠）
 * 全局审批模式是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，pending 残留统一清账防污染后续用例
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 全局审批模式置位（还原都走这一口） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
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

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('带 impact 的审批：徽标行速读（kind/summary/计数/命令）+ detail 折叠可展开', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: {
      sessionId: 'sc-impact-e2e',
      op: 'clean -fdx',
      target: '.',
      detail: '这段散文很长很长很长：将清理全部未跟踪文件与目录，包括构建产物、日志与临时文件，不可恢复，请确认工作区已无需要保留的未跟踪内容。',
      impact: {
        kind: 'delete',
        summary: '将删除 12 个未跟踪文件',
        filesCount: 12,
        commands: ['git clean -fdx'],
      },
    },
  })
  expect(res.ok()).toBeTruthy()
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 徽标行：kind 标签（zh 固定语）+ summary + 文件计数 + 命令清单
  const badge = card.locator('[data-test="aprv-impact"]')
  await expect(badge).toBeVisible()
  await expect(badge.locator('.aprv-impact-kind')).toContainText('删除')
  await expect(card.locator('[data-test="aprv-impact-summary"]')).toHaveText('将删除 12 个未跟踪文件')
  await expect(card.locator('[data-test="aprv-impact-count"]')).toContainText('12')
  await expect(card.locator('[data-test="aprv-impact-cmds"] code')).toHaveText(['git clean -fdx'])

  // detail 折叠为次级：默认收起，点「详情」展开散文
  await expect(card.locator('[data-test="aprv-detail"]')).toHaveCount(0)
  await card.locator('[data-test="aprv-detail-fold"]').click()
  await expect(card.locator('[data-test="aprv-detail"]')).toBeVisible()

  // 裁决链不受影响：允许一次 → 卡片清账
  await card.locator('button:has-text("允许一次")').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('老卡（无 impact）不受影响：无徽标行，detail 原样全显', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: {
      sessionId: 'sc-impact-legacy',
      op: 'reset --hard',
      target: 'main',
      detail: '丢弃未推送改动，恢复到 origin/main（老形态自由文本）',
    },
  })
  expect(res.ok()).toBeTruthy()
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })

  // 降级 = 现状：无徽标行/命令清单/折叠开关，detail 直接在场
  await expect(card.locator('[data-test="aprv-impact"]')).toHaveCount(0)
  await expect(card.locator('[data-test="aprv-impact-cmds"]')).toHaveCount(0)
  await expect(card.locator('[data-test="aprv-detail-fold"]')).toHaveCount(0)
  await expect(card.locator('[data-test="aprv-detail"]')).toContainText('丢弃未推送改动')

  await card.locator('button:has-text("允许一次")').click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
})

test('impact 坏载荷 400：kind 枚举外回稳定码 ops.confirm_impact_invalid（不落卡）', async ({ page, request }) => {
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // kind 枚举外 → 400 + 稳定 code
  const bad = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { op: 'rm -rf /', impact: { kind: 'nuke-everything', summary: 'x' } },
  })
  expect(bad.status()).toBe(400)
  const body = (await bad.json()) as { code?: string }
  expect(body.code).toBe('ops.confirm_impact_invalid')

  // commands 超 5 条同码（上限校验另一形态）
  const bad2 = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { op: 'script', impact: { kind: 'other', summary: 'x', commands: ['a', 'b', 'c', 'd', 'e', 'f'] } },
  })
  expect(bad2.status()).toBe(400)
  expect(((await bad2.json()) as { code?: string }).code).toBe('ops.confirm_impact_invalid')

  // 校验失败不落卡：页面无新卡片（载荷被拒，审批不存在）
  await expect(page.locator('.aprv-card')).toHaveCount(0)
})
