import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 通知的项目级静音 E2E（P-20261003-168，项目×类别二维）：
 *   1. 条目行快捷「静音此项目此类」→ 偏好落库（GET /notifications/prefs 可见）
 *   2. 静音后该组合不再入账：POST 同项目同类别 → 服务端 Add 判定点拦截，
 *      列表不出现；同项目异类别 / 异项目同类别照常入账（二维 AND 语义）
 *   3. 设置·通知·项目静音管理解除 → 同组合恢复入账
 * 通知经 POST /api/notifications 播种；静音清单是服务端全局状态，用例开头
 * 清空（PUT projectMutes=[]）+ 结束再清，不残留测试数据污染后续用例。
 */

const PROJ_A = 'e2e-mute-proj-alpha'
const PROJ_A_NAME = '静音alpha项目'
const PROJ_B = 'e2e-mute-proj-beta'
const PROJ_B_NAME = '静音beta项目'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function clearAll(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
  expect(res.ok).toBeTruthy()
}

async function resetMutes(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ projectMutes: [] }),
  })
  expect(res.ok).toBeTruthy()
}

async function getPrefs(headers: Record<string, string>) {
  const res = await fetch(`${API_BASE}/api/notifications/prefs`, { headers })
  expect(res.ok).toBeTruthy()
  return (await res.json()) as { projectMutes?: Array<{ projectId: string; category: string }> }
}

async function seed(headers: Record<string, string>, category: string, title: string, projectId?: string, projectName?: string) {
  const res = await fetch(`${API_BASE}/api/notifications`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ type: 'success', category, title, body: '', projectId: projectId ?? '', projectName: projectName ?? '' }),
  })
  expect(res.ok).toBeTruthy()
}

async function listTitles(headers: Record<string, string>): Promise<string[]> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const body = (await res.json()) as { data?: Array<{ title: string }> }
  return (body.data || []).map(n => n.title)
}

async function openPanel(page: import('@playwright/test').Page) {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await page.locator('.project-card').first().click()
  await page.waitForURL('**/project')
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await resetMutes(headers)
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await resetMutes(headers)
})

test('条目快捷静音后该组合不再入账，其它组合照常', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await resetMutes(headers)
  await seed(headers, 'task', 'e2e-静音-初始', PROJ_A, PROJ_A_NAME)

  await openPanel(page)
  const row = (text: string) => page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
  await expect(row('e2e-静音-初始')).toHaveCount(1, { timeout: 5000 })

  // 条目行快捷「静音此项目此类」：轻反馈（toast），偏好即刻落库
  await row('e2e-静音-初始').hover()
  await row('e2e-静音-初始').locator('[data-testid="notif-mute-project"]').click()
  await expect(page.locator('.n-message')).toContainText('已静音', { timeout: 3000 })
  const prefs = await getPrefs(headers)
  expect(prefs.projectMutes).toEqual([{ projectId: PROJ_A, category: 'task' }])

  // 静音组合重发：POST 成功但服务端 Add 判定点拦截——列表与 GET 均不入账
  await seed(headers, 'task', 'e2e-静音-重发', PROJ_A, PROJ_A_NAME)
  await expect(row('e2e-静音-重发')).toHaveCount(0)
  expect(await listTitles(headers)).not.toContain('e2e-静音-重发')

  // 二维 AND：同项目异类别、异项目同类别照常入账
  await seed(headers, 'git', 'e2e-静音-异类别', PROJ_A, PROJ_A_NAME)
  await seed(headers, 'task', 'e2e-静音-异项目', PROJ_B, PROJ_B_NAME)
  await expect(row('e2e-静音-异类别')).toHaveCount(1, { timeout: 5000 })
  await expect(row('e2e-静音-异项目')).toHaveCount(1, { timeout: 5000 })
})

test('设置·项目静音管理解除后同组合恢复入账', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await resetMutes(headers)
  // API 直播种静音（模拟上一用例遗留），页面启动即拉到该偏好；面板先播一条
  // 无关组合作对照（静音生效中，PROJ_A×task 的种子会被服务端拦截、不入账）
  await fetch(`${API_BASE}/api/notifications/prefs`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({ projectMutes: [{ projectId: PROJ_A, category: 'task' }] }),
  })
  await seed(headers, 'task', 'e2e-解除-对照', PROJ_B, PROJ_B_NAME)

  await openPanel(page)
  const row = (text: string) => page.locator('.nc-item:not(.nc-sub)').filter({ hasText: text })
  await expect(row('e2e-解除-对照')).toHaveCount(1, { timeout: 5000 })

  // 通知中心齿轮 → 设置·通知页签；项目静音区列出该组合（项目已删/未注册
  // 时回落原始 id 展示）
  await page.locator('.nc-card .nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  const pane = page.locator('[data-testid="settings-pane-notifications"]')
  const mutes = pane.locator('[data-testid="settings-project-mutes"]')
  await expect(mutes.locator('.mute-row')).toHaveCount(1, { timeout: 3000 })
  await expect(mutes.locator('.mute-row')).toContainText(PROJ_A)

  // 解除 → 保存（modal 保存语义，与其它通知偏好同一提交时机）
  await mutes.locator('[data-testid="settings-project-mute-remove"]').click()
  await page.locator('.settings-modal .settings-footer button', { hasText: '保存' }).click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 5000 })
  const prefs = await getPrefs(headers)
  expect(prefs.projectMutes ?? []).toEqual([])

  // 同组合恢复入账
  await seed(headers, 'task', 'e2e-解除-恢复', PROJ_A, PROJ_A_NAME)
  expect(await listTitles(headers)).toContain('e2e-解除-恢复')
})

test('设置开页即关不误报未保存（projectMutes 缺字段归一防 isDirty 假阳性）', async ({ page }) => {
  const headers = await unlockHeaders()
  await clearAll(headers)
  await resetMutes(headers)

  await openPanel(page)
  // 延迟弹出的默认密码提醒会拦点击：出现则先「稍后提醒」收起（audit-log.spec 同款）
  const laterBtn = page.getByRole('button', { name: '稍后提醒' })
  if (await laterBtn.count() > 0) {
    await laterBtn.click()
    await expect(laterBtn).toHaveCount(0, { timeout: 3000 })
  }

  // 通知中心齿轮 → 设置·通知页签 → 无任何编辑直接 ×：不得弹「未保存」确认
  //（服务端 omitempty 省略空 projectMutes 字段，前端归一为 [] 后两侧深比较一致）
  await page.locator('.nc-card .nc-action-btn').first().click()
  await expect(page.locator('.n-modal.settings-modal')).toBeVisible({ timeout: 3000 })
  await page.locator('.settings-close').click()
  await expect(page.locator('.n-modal.settings-modal')).toBeHidden({ timeout: 3000 })
  await expect(page.locator('.n-dialog')).toHaveCount(0)
})
