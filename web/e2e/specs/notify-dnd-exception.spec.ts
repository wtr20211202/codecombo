import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { installSoundStub, soundOscCount, gestureUnlockAudio, dndWindowCoveringNow } from '../../tests/alert-sound-stub'
import { DND_STORAGE_KEY } from '../../src/stores/dnd'

/**
 * 免打扰例外类别（P-20261003-115）桩测试：免打扰时段无差别静默的例外口——
 * 例外表（DndWindow.except，默认 ['approval']）命中的类别在时段内照常提醒。
 * 以记录型 AudioContext 桩断言等待音效的穿透 / 抑制（ approval-sound.spec
 * 同款桩，已抽 tests/alert-sound-stub.ts 共用）：
 *   1. 设置页 UI 全链路开启免打扰（默认例外含审批）→ 审批 pending：桩命中
 *      （穿透照响，夜间挂机 agent 干等裁决不吞音）+ 卡片照常
 *   2. 设置页 UI 取消审批例外（例外多选全链路：去勾 → 保存）→ 桩不命中
 *      （例外表可关，恢复 P-40 无差别静默语义）+ 卡片照常（只吞音不吞卡）
 *   3. 非例外类别（ask，不在默认例外表）→ 桩不命中 + 提问卡照常
 * 审批/提问为服务端共享状态：beforeEach/afterEach 清账防残留（卡片全局常驻，
 * 同 approval-sound.spec）。
 */

async function unlockHeaders(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
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

/** API 造 pending 审批（满种方式对齐 approval-sound.spec） */
async function seedApproval(request: APIRequestContext, sessionId: string, op: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/ops-confirm`, {
    headers: await unlockHeaders(request),
    data: { sessionId, op, target: '', detail: 'P-20261003-115 免打扰例外验证' },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data: { id: string } }).data.id
}

/** API 造 pending 提问（等同 agent 发起，同 approval-sound.spec） */
async function seedAsk(request: APIRequestContext, question: string): Promise<string> {
  const res = await request.post(`${API_BASE}/api/ops-ask`, {
    headers: await unlockHeaders(request),
    data: { question },
  })
  expect(res.ok()).toBeTruthy()
  return ((await res.json()) as { data?: { id?: string } }).data!.id!
}

// 进入项目 → 通知中心 → 齿轮直达设置通知页签（同 notify-dnd.spec 入口）
async function openNotifSettings(page: import('@playwright/test').Page) {
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  await page.locator('.nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  return page.locator('.settings-modal .content-pane:visible')
}

// 免打扰例外多选里取消一个类别（n-select multiple：点开下拉 → 点选项去勾），
// 返回前 Escape 收起菜单避免遮住保存按钮。菜单是 body 级挂载（n-base-select-option
// 不在 .content-pane 内，从 page 找；approval-rules.spec 同款定位）
async function toggleExceptionOption(page: import('@playwright/test').Page, label: string) {
  await page.locator('.dnd-except .n-base-selection').click()
  await page.locator('.n-base-select-option').filter({ hasText: label }).click()
  await page.keyboard.press('Escape')
}

test.beforeEach(async ({ request }) => {
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test.afterEach(async ({ request }) => {
  await cleanupApprovals(request)
  await cleanupAsks(request)
})

test('免打扰 + 默认例外（含审批）：审批 pending 穿透照响，卡片照常（设置页 UI 全链路）', async ({ page, request }) => {
  test.setTimeout(60000)
  await installSoundStub(page)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  const pane = await openNotifSettings(page)

  // 开启免打扰 → 时段字段展开，填覆盖当前时刻的起止（notify-dnd.spec 同款），
  // 例外多选随分区出现且默认选中审批等待（store 初始默认）
  await pane.locator('.setting-row', { hasText: '免打扰时段' }).locator('.n-checkbox').click()
  const fields = pane.locator('.dnd-fields')
  await expect(fields).toBeVisible()
  const w = dndWindowCoveringNow()
  await fields.locator('input[type="time"]').first().fill(w.start)
  await fields.locator('input[type="time"]').nth(1).fill(w.end)
  const except = pane.locator('.dnd-except')
  await expect(except).toBeVisible()
  // 默认例外表含审批等待：多选里一个已选 tag（NTag 在 selection-tag-wrapper 内）
  await expect(except.locator('.n-base-selection-tag-wrapper .n-tag')).toHaveCount(1)

  // modal 保存（NotificationSettings.save → dndStore.set → localStorage）
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  await gestureUnlockAudio(page)

  await seedApproval(request, 'sc-dnd-exc-pierce', 'push --force')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await expect.poll(() => soundOscCount(page), { timeout: 5000 }).toBeGreaterThan(0)
})

test('免打扰 + 取消审批例外（UI 全链路）：审批 pending 恢复静默，卡片照常', async ({ page, request }) => {
  test.setTimeout(60000)
  await installSoundStub(page)
  await fixedLocale(page)
  // 播种覆盖当前时刻的免打扰（默认例外表）：本用例专验例外多选的去勾链路
  await page.addInitScript(([k, win]) => {
    localStorage.setItem(k, JSON.stringify(win))
  }, [DND_STORAGE_KEY, dndWindowCoveringNow()])
  await gotoAndUnlock(page, `${API_BASE}/`)
  const pane = await openNotifSettings(page)

  await toggleExceptionOption(page, '审批等待')
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  await gestureUnlockAudio(page)

  await seedApproval(request, 'sc-dnd-exc-mute', 'reset --hard')
  await expect(page.locator('.aprv-card')).toHaveCount(1, { timeout: 10000 })
  await page.waitForTimeout(500) // 事件链余量：确非「还没响」而是「例外关了被吞」
  expect(await soundOscCount(page)).toBe(0)
})

test('免打扰 + 非例外类别：提问 pending 静默，提问卡照常', async ({ page, request }) => {
  test.setTimeout(60000)
  await installSoundStub(page)
  await fixedLocale(page)
  await page.addInitScript(([k, win]) => {
    localStorage.setItem(k, JSON.stringify(win))
  }, [DND_STORAGE_KEY, dndWindowCoveringNow()])
  await gotoAndUnlock(page, `${API_BASE}/`)
  await gestureUnlockAudio(page)

  await seedAsk(request, 'P-20261003-115 免打扰例外验证（ask 不在默认例外表，请忽略）')
  await expect(page.locator('.ask-card')).toHaveCount(1, { timeout: 10000 })
  await page.waitForTimeout(500)
  expect(await soundOscCount(page)).toBe(0)
})
