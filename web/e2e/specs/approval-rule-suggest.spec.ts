import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'

/**
 * 审批模式自学习建议（P-20261006-28）：近 7 天同 op 前缀「手动允许 ≥3 次」
 * 且无对应规则覆盖 → 审批卡堆顶建议条「已手动允许 N 次——创建规则？」；
 * 「创建规则」一键直达 设置·安全·审批规则 表单并预填该前缀（P-35 规则
 * 可发现性闭环）；「暂不」会话内收起 + 7 天同模式只建议一次（localStorage
 * 单键节流）；拒绝不计入（信任方向单向）、已有规则覆盖（任一 effect 命中
 * 同前缀）不建议。检测源 = GET /ops-confirm?status=allowed 既有裁决记录。
 *
 * 「手动允许」判定的服务端数据面前提：人工裁决的 createdAt→resolvedAt 间隔
 * 远大于落库即终态的自动放行（AUTO_ALLOW_GAP_MS=1s）。e2e 经 API 造人工
 * 允许须让间隔越过该分界——种子全部先落、统一等待 MANUAL_GAP_MS 后再裁，
 * 单次等待覆盖三条记录，测试时长代价 ~1.6s。
 *
 * 前缀隔离：各用例用不同 git 子命令前缀（push/pull/fetch/stash/merge），
 * 且带运行唯一后缀 TAG（服务端裁决历史 30 天保留窗跨运行留存——非 fresh
 * 数据面复跑时上一轮同前缀手动允许会计入本轮阈值，第二 token 加后缀即让
 * 前缀跨运行互不相通，见 TAG 注记）；并行无扰（playwright workers=1 串行，
 * 邻域 spec 的 git 记录要么带 ruleHit 要么间隔 <1s，均不进「手动允许」计数）。
 * 审批规则表与全局审批模式是服务端共享状态：beforeEach 快照规则表，
 * afterEach 还原（approval-guide/temp-window 同款卫生纪律）。
 */

const BASE = process.env.PLAYWRIGHT_BASE_URL || 'http://localhost:9999'
/** 模式建议节流单键（与 utils/approvalPattern.APPROVAL_SUGGEST_SHOWN_KEY 同串） */
const SUGGEST_KEY = 'sc.approvalRuleSuggestShown'
/** API 造「人工允许」的间隔：> AUTO_ALLOW_GAP_MS(1s)，留 CI 抖动余量 */
const MANUAL_GAP_MS = 1600
/** 运行唯一 git 子命令后缀（跨运行前缀隔离，见文件头注记） */
const TAG = Date.now().toString(36).slice(-5)

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function setApprovalMode(request: APIRequestContext, mode: 'ask'): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 审批规则表快照/还原：建议的「无规则覆盖」前提是服务端共享状态 */
let rulesSnapshot: unknown[] = []

async function snapshotRules(request: APIRequestContext): Promise<void> {
  const res = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const data = ((await res.json()) as { data?: { agentApprovalRules?: unknown[] } }).data
  rulesSnapshot = data?.agentApprovalRules ?? []
}

async function setRules(request: APIRequestContext, rules: unknown[]): Promise<void> {
  await request.put(`${BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalRules: rules },
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

/** API 造 pending 审批（满种方式对齐 approval-guide.spec），返回 id */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261006-28 模式自学习建议验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** API 裁决（allow=false 即拒绝——拒绝不进手动允许计数，拒绝不计数用例依赖） */
async function resolveApproval(request: APIRequestContext, id: string, allow: boolean): Promise<void> {
  const res = await request.post(`${BASE}/api/ops-confirm/${id}/resolve`, {
    headers: await unlockHeaders(request),
    data: { allow, always: false },
  })
  expect(res.ok()).toBeTruthy()
}

/** 造「近 7 天手动允许 N 次」：先全量种子（让 createdAt 聚在一起），统一等待
 *  越过自动放行分界后逐一裁决——单次等待覆盖全部记录（见文件头注记） */
async function seedManualAllows(request: APIRequestContext, sessionId: string, ops: string[], allow = true): Promise<void> {
  const ids: string[] = []
  for (const op of ops) ids.push(await seedApproval(request, sessionId, op))
  await new Promise(r => setTimeout(r, MANUAL_GAP_MS))
  for (const id of ids) await resolveApproval(request, id, allow)
}

/** 清节流标记：新 context 本无残留，显式 removeItem 对齐「清标记→出条」前置；
 *  addInitScript 带一次性哨兵防 reload 把运行期标记又删掉（approval-guide
 *  同款装置，防自我破坏）。哨兵键带 attempt 号：playwright 重试虽是全新
 *  context，带号让「每 attempt 首航必清、同 attempt 内 reload 不误删运行期
 *  标记」两个语义同时成立 */
async function clearSuggestMarker(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(([key, sentinel]) => {
    if (localStorage.getItem(sentinel) === '1') return
    localStorage.removeItem(key)
    localStorage.setItem(sentinel, '1')
  }, [SUGGEST_KEY, `sc.aprvRuleSuggestTestFresh${test.info().retry}`])
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await snapshotRules(request)
})

test.afterEach(async ({ request }) => {
  await setRules(request, rulesSnapshot)
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
})

test('三次同型允许 → 下一张同型卡带建议条（N 与前缀可辨），异型卡不带', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearSuggestMarker(page)

  await gotoAndUnlock(page, '/')
  await seedManualAllows(request, 'sc-rs-1', [
    `git push${TAG} origin release/v1`,
    `git push${TAG} origin release/v2`,
    `git push${TAG} origin release/v3`,
  ])

  // 第 4 张同型卡：建议条在场，计数 3、前缀可辨（规则表单将预填的值）
  await seedApproval(request, 'sc-rs-1', `git push${TAG} origin release/v4`)
  const card = page.locator('.aprv-card')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  const bar = page.locator('[data-test="aprv-rule-suggest"]')
  await expect(bar).toBeVisible()
  await expect(bar.locator('[data-test="aprv-rule-suggest-text"]')).toContainText('3')
  await expect(bar.locator('[data-test="aprv-rule-suggest-pattern"]')).toHaveText(`git push${TAG}`)

  // 异型 pending（无同前缀手动允许史）不带建议——检测按前缀隔离
  await card.getByRole('button', { name: '允许一次' }).click()
  await expect(bar).toHaveCount(0)
  await seedApproval(request, 'sc-rs-1', `git tag${TAG} v9`)
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await expect(page.locator('[data-test="aprv-rule-suggest"]')).toHaveCount(0)
})

test('拒绝不计数：2 允许 + 1 拒绝未达阈值，不出建议', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearSuggestMarker(page)

  await gotoAndUnlock(page, '/')
  await seedManualAllows(request, 'sc-rs-2', [
    `git stash${TAG} list A`,
    `git stash${TAG} list B`,
  ])
  await seedManualAllows(request, 'sc-rs-2', [`git stash${TAG} list C`], false) // 拒绝

  await seedApproval(request, 'sc-rs-2', `git stash${TAG} list D`)
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  // 计数只认允许（2 < 3），拒绝方向不建议——给足刷新窗口后仍不在场
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-test="aprv-rule-suggest"]')).toHaveCount(0)
})

test('已有规则覆盖同型前缀 → 不建议（任一 effect，含 ask 留档）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearSuggestMarker(page)

  await gotoAndUnlock(page, '/')
  await setRules(request, [{ opPattern: `git merge${TAG}`, effect: 'ask' }])
  await seedManualAllows(request, 'sc-rs-3', [
    `git merge${TAG} --no-ff feat/a`,
    `git merge${TAG} --no-ff feat/b`,
    `git merge${TAG} --no-ff feat/c`,
  ])

  await seedApproval(request, 'sc-rs-3', `git merge${TAG} --no-ff feat/d`)
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-test="aprv-rule-suggest"]')).toHaveCount(0)
})

test('创建规则 → 设置·安全·审批规则新增表单预填前缀（用户确认粒度）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearSuggestMarker(page)

  await gotoAndUnlock(page, '/')
  await seedManualAllows(request, 'sc-rs-4', [
    `git pull${TAG} origin main A`,
    `git pull${TAG} origin main B`,
    `git pull${TAG} origin main C`,
  ])
  await seedApproval(request, 'sc-rs-4', `git pull${TAG} origin main D`)

  const bar = page.locator('[data-test="aprv-rule-suggest"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await bar.locator('[data-test="aprv-rule-suggest-create"]').click()

  // 深链半程：设置弹窗开且落在审批规则页签；表单半程：新增弹窗带预填
  // （data-testid 落在 NInput 包装 div 上——取值断言走内部 input，与
  // approval-rules.spec 同款）
  await expect(page.locator('.settings-modal')).toBeVisible({ timeout: 10000 })
  const patternInput = page.locator('[data-testid="approval-rules-form-pattern"] input')
  await expect(patternInput).toBeVisible({ timeout: 10000 })
  await expect(patternInput).toHaveValue(`git pull${TAG}`)
  // 预填动作 = allow（用户确认粒度后自行保存，不自动落库）
  await expect(page.locator('[data-testid="approval-rules-form-effect"] .n-base-selection')).toContainText('允许')
  // 未保存：规则表零新增（快照形态保持）
  const saved = await request.get(`${BASE}/api/settings`, { headers: await unlockHeaders(request) })
  const rules = ((await saved.json()) as { data?: { agentApprovalRules?: unknown[] } }).data?.agentApprovalRules
  expect(rules).toEqual(rulesSnapshot)
})

test('「暂不」即隐；刷新后同型卡不再建议（7 天节流落盘）', async ({ page, request }) => {
  test.setTimeout(60000)
  await fixedLocale(page)
  await clearSuggestMarker(page)

  await gotoAndUnlock(page, '/')
  await seedManualAllows(request, 'sc-rs-5', [
    `git fetch${TAG} --prune A`,
    `git fetch${TAG} --prune B`,
    `git fetch${TAG} --prune C`,
  ])
  await seedApproval(request, 'sc-rs-5', `git fetch${TAG} --prune D`)

  const bar = page.locator('[data-test="aprv-rule-suggest"]')
  await expect(bar).toBeVisible({ timeout: 10000 })
  await bar.locator('[data-test="aprv-rule-suggest-later"]').click()
  await expect(bar).toHaveCount(0)
  // 展示时刻已落节流键（7 天同模式只建议一次——与是否点「暂不」无关）
  await expect.poll(() =>
    page.evaluate(([k]) => localStorage.getItem(k), [SUGGEST_KEY]),
  ).not.toBeNull()

  // 刷新：卡片经冷启动补账恢复，节流从存储读回，同模式不再建议
  await page.reload()
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await page.waitForTimeout(1500)
  await expect(page.locator('[data-test="aprv-rule-suggest"]')).toHaveCount(0)
})
