import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批卡会话名归属（P-20261003-161）：
 * 多会话并行时卡头只有 agent 类型可辨（同类多会话归属不明）——agent 标签旁附
 * 发起会话名（ApprovalRecord.sessionId → terminal-sessions store 查名）：
 *   1. 两会话各发一审批 → 两卡头各显自己会话名（归属一眼可辨）
 *   2. 已关闭/未知会话 → 卡头降显尾 8 位截断 id（title 留全 id 供核对）
 * 造数方式对齐 approval-jump.spec（API 造会话 + pending 审批，afterEach 清账
 * 防残留污染其他用例的 .aprv-card 计数）
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，保证确定性 + 防残留 tmux 进程） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${BASE}/api/terminals/${s.id}`, { headers })
  }
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

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
  await cleanupApprovals(request)
})

test('两会话各发一审批：卡头各显自己会话名（归属一眼可辨）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // API 造两个可辨名的系统会话（纯终端 runtime，不拉起 claude TUI）
  for (const name of ['appr-name-alpha', 'appr-name-beta']) {
    const created = await request.post(`${BASE}/api/terminals`, {
      headers, data: { kind: 'agent', name, runtime: 'shell' },
    })
    expect(created.ok()).toBeTruthy()
  }
  const tlist = await (await request.get(`${BASE}/api/terminals`, { headers })).json()
  const sessions = (tlist?.data || []) as { id: string; name: string }[]
  const alpha = sessions.find(s => s.name === 'appr-name-alpha')
  const beta = sessions.find(s => s.name === 'appr-name-beta')
  expect(alpha).toBeTruthy()
  expect(beta).toBeTruthy()

  // 各发一 pending 审批（2 张 ≤ 折叠阈值 3，全显不折叠）
  for (const [s, op] of [[alpha, 'reset --hard'], [beta, 'push --force']] as const) {
    const appr = await request.post(`${BASE}/api/ops-confirm`, {
      headers, data: { sessionId: s!.id, op, target: 'main', detail: 'e2e 会话名归属' },
    })
    expect(appr.ok()).toBeTruthy()
  }

  // 两卡在屏，各卡头芯片显各自会话名（会话列表由堆层懒拉，名字随对账就位）
  const cards = page.locator('.aprv-card')
  await expect(cards).toHaveCount(2, { timeout: 10000 })
  const alphaCard = cards.filter({ hasText: 'reset --hard' })
  const betaCard = cards.filter({ hasText: 'push --force' })
  await expect(alphaCard.locator('[data-test="aprv-session"]')).toHaveText('appr-name-alpha')
  await expect(betaCard.locator('[data-test="aprv-session"]')).toHaveText('appr-name-beta')
})

test('已关闭会话的审批：卡头降显尾 8 位截断 id（title 留全 id）', async ({ page, request }) => {
  const headers = await unlockHeaders(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, '/')

  // 从未存在的会话 id（等价已关闭对账结果：列表对账后无此 id）
  const goneId = 'sc_e2e_gone_name_session'
  const appr = await request.post(`${BASE}/api/ops-confirm`, {
    headers, data: { sessionId: goneId, op: 'clean -fdx', target: '', detail: 'e2e 截断 id 验证' },
  })
  expect(appr.ok()).toBeTruthy()

  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const chip = card.locator('[data-test="aprv-session"]')
  await expect(chip).toHaveText('…' + goneId.slice(-8))
  await expect(chip).toHaveAttribute('title', goneId)
})
