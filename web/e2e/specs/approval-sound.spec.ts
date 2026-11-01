import { test, expect, type APIRequestContext, type Page } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, LOCK_OVERLAY } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { installSoundStub, soundOscCount, gestureUnlockAudio, dndWindowCoveringNow } from '../../tests/alert-sound-stub'
import { DND_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * 审批/提问等待音效（P-20261003-33）桩测试：
 * 音频本身不可 e2e 断言（headless 语境无音频输出），以记录型 AudioContext 桩
 * （createOscillator 计数）断言「合成器调用发生 / 不发生」的门控矩阵：
 *   1. 默认开 + 首次手势解锁 → 真实播种审批 pending：桩命中 + 卡片照常弹出
 *      （门控只吞声音不吞卡）
 *   2. 开关关闭（设置·通知区 UI 全链路：勾掉 → 保存）→ 桩不命中、卡片照常
 *   3. 免打扰时段覆盖当下（localStorage 预置，P-40 同守卫位）→ 桩照常命中
 *      （P-20261003-115 例外类别：approval 默认在免打扰例外表，时段内穿透
 *      照响——抑制路径见 notify-dnd-exception.spec 的例外清空/提问分支）
 *   4. 锁定态（P-5 同守卫位）：锁定时 ops WS 被门控断开、播种事件到不了页面，
 *      直发 window 事件直达被测门控（lock-notify-mute.spec 同口径）→ 卡片入账
 *      照常、桩不命中
 *   5. 提问（input.request）同链路 → 桩命中
 * 审批模式 / 审批 / 提问均为服务端共享状态：beforeEach 归位 + afterEach 清账
 * 防残留（卡片全局常驻，pending 会污染后续用例，同 approval-hotkey.spec）。
 */

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 全局审批模式置位（还原走同一口） */
async function setApprovalMode(request: APIRequestContext, mode: 'ask' | 'allow'): Promise<void> {
  await request.put(`${API_BASE}/api/settings`, {
    headers: await unlockHeaders(request),
    data: { agentApprovalMode: mode },
  })
}

/** 清理 pending 审批（卡片全局常驻，残留污染后续用例的 .aprv-card 计数） */
async function cleanupApprovals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-confirm`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-confirm/${a.id}/resolve`, {
      headers, data: { allow: true, always: false },
    })
  }
}

/** 清理 pending 提问（作答清账，卡片即消失；同 ops-ask.spec） */
async function cleanupAsks(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeaders(request)
  const res = await request.get(`${API_BASE}/api/ops-ask`, { headers })
  const list = ((await res.json()) as { data?: { id: string; status: string }[] }).data || []
  for (const a of list.filter(x => x.status === 'pending')) {
    await request.post(`${API_BASE}/api/ops-ask/${a.id}/answer`, {
      headers, data: { answer: 'cleanup' },
    })
  }
}

/** API 造 pending 审批（满种方式对齐 approval-hotkey.spec） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-33 等待音效桩验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** API 造 pending 提问（等同 agent 发起，同 ops-ask.spec） */
async function seedAsk(request: APIRequestContext, question: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/ops-ask`, {
    headers: await unlockHeaders(request),
    data: { question },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data?: { id?: string } }).data!.id!
}

// 进入项目 → 通知中心 → 齿轮直达设置通知页签（同 notify-dnd.spec 入口）
async function openNotifSettings(page: Page) {
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  return page.locator('.settings-modal .content-pane:visible')
}

test.beforeEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test.afterEach(async ({ request }) => {
  await setApprovalMode(request, 'ask')
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test('审批 pending：默认开 + 手势解锁 → 合成器调用，卡片照常弹出', async ({ page, request }) => {
  await installSoundStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await gestureUnlockAudio(page)

  await seedApproval(request, 'sc-sound-approval', 'clean -fdx')
  // 卡片照常弹出：门控只吞声音不吞卡（视觉通道不经过音效链）
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await expect.poll(() => soundOscCount(page), { timeout: 5000 }).toBeGreaterThan(0)
})

test('审批 pending：设置页关闭开关（UI 全链路）→ 合成器不调用，卡片照常', async ({ page, request }) => {
  test.setTimeout(60000)
  await installSoundStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)

  const pane = await openNotifSettings(page)
  const soundRow = pane.locator('.setting-row', { hasText: '等待音效' })
  await expect(soundRow).toBeVisible()
  await soundRow.locator('.n-checkbox').click() // 同 notify-webhook.spec 的开关切换口径
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })

  await seedApproval(request, 'sc-sound-off', 'reset --hard')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await page.waitForTimeout(500) // 事件链余量：确非「还没响」而是「门控吞了」
  expect(await soundOscCount(page)).toBe(0)
})

test('审批 pending：免打扰时段内默认穿透照响（例外类别），卡片照常', async ({ page, request }) => {
  await installSoundStub(page)
  await fixedLocale(page)
  // 注意：addInitScript 回调被序列化执行，Node 侧 import 的常量不在浏览器
  // 闭包里——key 必须走参数传入（同 fixedLocale 的 [key, locale] 形态）。
  // 播种数据无 except 字段（旧落盘形态）：store 归一化补默认 ['approval']
  await page.addInitScript(([k, w]) => {
    localStorage.setItem(k, JSON.stringify(w))
  }, [DND_STORAGE_KEY, dndWindowCoveringNow()])
  await gotoAndUnlock(page, `${API_BASE}/`)
  await gestureUnlockAudio(page)

  await seedApproval(request, 'sc-sound-dnd', 'push --force')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await expect.poll(() => soundOscCount(page), { timeout: 5000 }).toBeGreaterThan(0)
})

test('锁定态：window 事件直达门控 → 卡片入账照常，合成器不调用', async ({ page }) => {
  test.setTimeout(60000)
  await installSoundStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await gestureUnlockAudio(page)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')

  // TopBar 锁定（前端立即 isLocked=true + 服务端撤销本页 token，同 lock-notify-mute.spec）
  await page.locator('button[title="锁定系统"]').first().click()
  await expect(page.locator(LOCK_OVERLAY)).toBeVisible({ timeout: 10000 })

  // 锁定时 ops WS 被断开、播种事件到不了页面——直发 window 事件直达被测门控
  //（抑制断言若走播种会因「事件根本没送达」而空洞）
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('sc-ops:approval.pending', {
      detail: { id: 'sc-sound-locked', status: 'pending', op: 'clean -fdx', sessionId: 'sc-sound-locked-s' },
    }))
  })
  // 卡片入账照常（门控只吞声音不吞卡），声音被锁定门吞掉
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  expect(await soundOscCount(page)).toBe(0)

  // 解锁还原（遮罩消失即本页解锁态，不留锁定页给后续用例）
  const input = page.locator(`${LOCK_OVERLAY} .lock-form input`).first()
  await input.fill(DEFAULT_PASSWORD)
  const unlockBtn = page.locator(`${LOCK_OVERLAY} button`).filter({ hasText: '解锁' }).first()
  await expect(unlockBtn).toBeEnabled({ timeout: 2000 })
  await unlockBtn.click()
  await expect(page.locator(LOCK_OVERLAY)).toHaveCount(0, { timeout: 10000 })
  const pwdTip = page.locator('.n-modal').filter({ hasText: '建议修改默认密码' })
  if (await pwdTip.count() > 0) {
    await pwdTip.getByRole('button', { name: '稍后提醒' }).click()
    await expect(pwdTip).toBeHidden()
  }
})

test('提问 input.request：默认开 + 手势解锁 → 合成器调用，提问卡弹出', async ({ page, request }) => {
  await installSoundStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await gestureUnlockAudio(page)

  await seedAsk(request, 'P-20261003-33 音效链提问（桩验证，请忽略）')
  await expect(page.locator('.ask-card')).toHaveCount(1, { timeout: 10000 })
  await expect.poll(() => soundOscCount(page), { timeout: 5000 }).toBeGreaterThan(0)
})
