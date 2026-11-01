import { test, expect } from '@playwright/test'
import { fixedLocale, gotoAndUnlock, DEFAULT_PASSWORD, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'

/**
 * 预览端口直达 E2E（P-20261002-70）：
 *   经 POST /api/ops-notify 播种 preview.port（真实前端链路：ops-channel WS →
 *   useOpsChannel 直通分发 sc-ops:preview.port → OpsChannelBridge →
 *   previewPortNotify 链），锁定三个可见结果：
 *   1. 通知中心入一条带动作条目（category=task）→ 点击 → 底部预览面板打开
 *      且端口填入 P-29 输入链路（iframe src=/preview/:port/）
 *   2. 悬浮球快捷按钮「预览 :N」出现（openState 预置 mini 形态）→ 点击 → 同样直达
 *   3. 同会话重复上报同端口去重：服务端通知计数不增（前端整链跳过）
 * 通知经共享实例 API 播种/清理，不残留测试数据
 */

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

// 服务端已入账的同标题条目数（去重在前端链完成，服务端计数即权威断言）
async function serverCount(title: string, headers: Record<string, string>): Promise<number> {
  const res = await fetch(`${API_BASE}/api/notifications`, { headers })
  const list = ((await res.json()) as { data?: Array<{ title?: string }> }).data || []
  return list.filter(n => n.title === title).length
}

// 轮询等待入账（WS 链路：ops-notify 广播 → 前端桥 → POST /notifications）
async function waitServerCount(title: string, headers: Record<string, string>, timeoutMs = 8000): Promise<number> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const n = await serverCount(title, headers)
    if (n > 0 || Date.now() > deadline) return n
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

// 进项目页（预览面板挂在项目页 Layout 底部）：路上留出 WS 建立窗口再播种
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test.beforeAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test.afterAll(async () => {
  const headers = await unlockHeaders()
  await fetch(`${API_BASE}/api/notifications/clear`, { method: 'POST', headers })
})

test('preview.port → 通知条目带动作，点击直达预览面板且端口填入', async ({ page }) => {
  test.setTimeout(60000)
  await enterProject(page)
  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'preview.port', payload: { port: 4173, label: 'e2e dev' } },
  })
  expect(await waitServerCount('预览端口 :4173 · e2e dev', headers)).toBe(1)

  // 通知中心：条目可见、带动作（行可点击）
  await page.locator('button[title="通知中心"]').first().click()
  await expect(page.locator('.nc-card')).toBeVisible({ timeout: 3000 })
  const row = page.locator('.nc-item').filter({ hasText: '预览端口 :4173 · e2e dev' }).first()
  await expect(row).toBeVisible({ timeout: 8000 })
  await expect(row).toHaveClass(/clickable/)
  await row.click()

  // 直达：底部面板切到预览 tab，端口填入输入框并激活（iframe 指向反代路径）
  await expect(page.locator('.preview-panel')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.preview-port-input input')).toHaveValue('4173')
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', /\/preview\/4173\//, { timeout: 8000 })
})

test('悬浮球快捷按钮「预览 :N」→ 点击直达；同端口重复上报去重', async ({ page }) => {
  test.setTimeout(60000)
  // 预置智能体终端收起为悬浮球（openState 启动恢复语义，useAgentTerminal 消费）
  await page.addInitScript(([key, value]) => {
    localStorage.setItem(key, value)
  }, ['sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' })])
  await enterProject(page)
  const headers = await unlockHeaders()
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'preview.port', payload: { port: 5173 } },
  })
  expect(await waitServerCount('预览端口 :5173', headers)).toBe(1)

  // 悬浮球快捷按钮出现（球形态下挂在球体正下方）
  const mini = page.locator('body > .agm-root')
  await expect(mini).toBeVisible({ timeout: 8000 })
  const previewBtn = mini.locator('.agm-preview-btn')
  await expect(previewBtn).toContainText('预览 :5173', { timeout: 8000 })
  await previewBtn.click()

  await expect(page.locator('.preview-panel')).toBeVisible({ timeout: 8000 })
  await expect(page.locator('.preview-port-input input')).toHaveValue('5173')
  await expect(page.locator('.preview-frame')).toHaveAttribute('src', /\/preview\/5173\//, { timeout: 8000 })

  // 去重：同端口重复上报 → 服务端通知计数不增（悬浮球登记不重复入账）
  await page.request.post(`${API_BASE}/api/ops-notify`, {
    headers,
    data: { type: 'preview.port', payload: { port: 5173 } },
  })
  await page.waitForTimeout(1500)
  expect(await serverCount('预览端口 :5173', headers)).toBe(1)
  // 端口直达状态仍在（会话内常驻——服务在任务结束后仍在跑）
  await expect(mini.locator('.agm-preview-btn')).toContainText('预览 :5173')
})
