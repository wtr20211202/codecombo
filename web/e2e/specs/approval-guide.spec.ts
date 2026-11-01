import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 首张审批卡首触说明条（P-20261003-311）：首次出现审批卡（localStorage 一次性
 * 标记 sc.approvalGuideDismissed）时卡顶三行说明条——agent 在等裁决 / 允许与
 * 拒绝语义 / 完全允许=同类不再询问（设置页可改回）：
 *   1. 清标记 → 造 pending 出卡 → 说明条在场（三行）→ 收起/展开切换可用
 *   2. 点「不再显示」→ 说明条即隐且标记落盘 → 再出卡（新造 + 刷新补账）无说明条
 *   3. 值班大屏同款同标记键（共用 ApprovalGuideBar）：大屏 dismiss 后全局卡堆
 *      也不再出现（跨宿主单例 + localStorage 标记双保险）
 * 全局审批模式是服务端共享状态（approval-* 域用例都吃它）：beforeEach 归位
 * ask + afterEach 兜底还原，pending 残留统一清账防污染后续用例
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
/** 首触一次性标记键（与 useApprovalGuide.APPROVAL_GUIDE_DISMISS_KEY 同串） */
const GUIDE_KEY = 'sc.approvalGuideDismissed'

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

/** API 造 pending 审批（满种方式对齐 approval-seed.spec），返回 id */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-311 首触说明条验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** 清首触标记：说明条出现与否是纯客户端 localStorage 语义（新 context 本无
 *  残留，显式 removeItem 对齐提案「清标记→出卡」前置）。addInitScript 每次
 *  导航都会重跑——带一次性哨兵只在首航清，防 reload 时把运行期落好的 dismiss
 *  标记又删掉（装置自我破坏，实测踩坑）；必须 await 注册完成，否则与首次
 *  goto 竞速、首航不清而 reload 补删（同款踩坑） */
async function clearGuideMarker(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(([key]) => {
    const FRESH = 'sc.approvalGuideTestFresh'
    if (localStorage.getItem(FRESH) === '1') return
    localStorage.removeItem(key)
    localStorage.setItem(FRESH, '1')
  }, [GUIDE_KEY])
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('首触出卡带说明条：三行在场，收起/展开切换可用', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearGuideMarker(page)

  await gotoAndUnlock(page, '/')
  await seedApproval(request, 'sc-guide-1', 'guide-e2e reset --hard')

  const guide = page.locator('[data-test="aprv-guide"]')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(guide).toBeVisible()

  // 三行说明逐行在场（提案定稿口径：等裁决 / 允许拒绝语义 / 完全允许全局语义）
  const lines = guide.locator('[data-test="aprv-guide-lines"]')
  await expect(lines).toContainText('智能体在等你裁决')
  await expect(lines).toContainText('「允许一次」= 继续执行这一项')
  await expect(lines).toContainText('「拒绝」= 中止该操作')
  await expect(lines).toContainText('「完全允许」= 同类操作此后不再询问')
  await expect(lines).toContainText('设置页可改回')

  // 收起：三行收起、标题行与「不再显示」入口仍在；再展开恢复
  await guide.locator('[data-test="aprv-guide-toggle"]').click()
  await expect(lines).toBeHidden()
  await expect(guide).toBeVisible()
  await guide.locator('[data-test="aprv-guide-toggle"]').click()
  await expect(lines).toBeVisible()

  // 允许一次清账（还原现场）：说明条随卡堆清空退场（宿主 v-if 卸载）
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  await expect(guide).toHaveCount(0)
})

test('「不再显示」落一次性标记：说明条即隐，再出卡（新造+刷新补账）均不复活', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearGuideMarker(page)

  await gotoAndUnlock(page, '/')
  await seedApproval(request, 'sc-guide-2', 'guide-e2e clean -fdx')

  const guide = page.locator('[data-test="aprv-guide"]')
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(guide).toBeVisible()

  // 点不再显示：说明条即隐，标记落 localStorage（跨刷新语义的前提）
  await guide.locator('[data-test="aprv-guide-dismiss"]').click()
  await expect(guide).toHaveCount(0)
  await expect.poll(() => page.evaluate(([k]) => localStorage.getItem(k), [GUIDE_KEY])).toBe('1')

  // 裁掉当前卡 → 再造一张：新卡经广播入账，说明条不复活（同页单例即时生效）
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(card).toHaveCount(0, { timeout: 10000 })
  await seedApproval(request, 'sc-guide-3', 'guide-e2e rm -rf build')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(guide).toHaveCount(0)

  // 刷新：卡片经冷启动补账恢复，标记从 localStorage 读回，说明条仍不出现
  await page.reload()
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(guide).toHaveCount(0)
})

test('值班大屏同款同标记键：大屏 dismiss 后全局卡堆也不再出现', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearGuideMarker(page)

  await gotoAndUnlock(page, '/monitor')
  await seedApproval(request, 'sc-guide-mon', 'guide-e2e push --force')

  const guide = page.locator('[data-test="aprv-guide"]')
  const monCard = page.locator('.mon-card.is-approval')
  await expect(monCard.first()).toBeVisible({ timeout: 15000 })
  await expect(guide).toBeVisible()
  await expect(guide).toContainText('智能体在等你裁决')

  // 大屏点不再显示：落同一标记键
  await guide.locator('[data-test="aprv-guide-dismiss"]').click()
  await expect(guide).toHaveCount(0)
  await expect.poll(() => page.evaluate(([k]) => localStorage.getItem(k), [GUIDE_KEY])).toBe('1')

  // 先裁决掉大屏这张（防导航回主页后 seedPending 补账双卡干扰计数）
  await monCard.getByRole('button', { name: '允许一次' }).click()
  await expect(monCard).toHaveCount(0, { timeout: 10000 })

  // 全量重载回主页：全局卡堆同标记键，出卡无说明条（跨宿主一致）
  await page.goto(`${BASE}/`)
  await seedApproval(request, 'sc-guide-mon-2', 'guide-e2e chmod 777 /')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator('[data-test="aprv-guide"]')).toHaveCount(0)
})
