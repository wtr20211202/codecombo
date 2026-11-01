import { test, expect, type APIRequestContext } from '@playwright/test'
import { DEFAULT_PASSWORD, fixedLocale, gotoAndUnlock, projectCardByName } from '../../tests/helpers'
import { API_BASE } from '../../tests/api-base'
import { createAgentSessionApi } from '../../tests/e2e-api'

/**
 * task.progress 结构化步骤清单 E2E（P-20261004-7）：
 *   经 POST /api/ops-notify 播种带 steps 的 task.progress（真实前端链路：
 *   ops-channel WS → OpsChannelBridge → assistantTask store），锁定两个消费面：
 *   1. 悬浮条（球/迷你窗）：进度 n/m 计数 + tooltip 全清单（✓ 完成 / ▶ 当前项 /
 *      ○ 未完成）；整包重发置单项 done → 计数与指针随动；缺省 steps 的后续
 *      上报不清既有清单
 *   2. 值班大屏任务进度卡：清单逐项渲染（完成划线 is-done、当前项高亮
 *      is-current、meta 行「步骤 n/m」）；整包更新后高亮与计数迁移
 * 服务端发布口校验/规整由 Go 单测覆盖（TestOpsNotify_TaskProgressSteps*）；
 * 终端会话经 API 创建/清理，不残留测试数据
 */

const STEPS_TASK = 'E2E步骤任务'

async function unlockHeaders(): Promise<Record<string, string>> {
  const res = await fetch(`${API_BASE}/api/lock/unlock`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: DEFAULT_PASSWORD }),
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

async function unlockHeadersViaRequest(request: APIRequestContext): Promise<Record<string, string>> {
  const res = await request.post(`${API_BASE}/api/lock/unlock`, {
    data: { password: DEFAULT_PASSWORD },
  })
  const token = ((await res.json()) as { token?: string }).token || ''
  return { 'Content-Type': 'application/json', 'X-Lock-Token': token }
}

/** 清理全部终端会话（服务端全局共享，防残留会话混入大屏卡片计数） */
async function cleanupTerminals(request: APIRequestContext): Promise<void> {
  const headers = await unlockHeadersViaRequest(request)
  const res = await request.get(`${API_BASE}/api/terminals`, { headers })
  const list = ((await res.json()) as { data?: { id: string }[] }).data || []
  for (const s of list) {
    await request.delete(`${API_BASE}/api/terminals/${s.id}`, { headers })
  }
}

// API 造纯终端系统会话统一走共享层 createAgentSessionApi（e2e-api，P-20261004-48）：
// runtime=shell 不拉起 claude TUI，dir 缺省自动建临时目录

/** 进项目页（悬浮条挂项目页 Layout）：留出 ops-channel WS 建立窗口再播种 */
async function enterProject(page: import('@playwright/test').Page): Promise<void> {
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/`)
  await projectCardByName(page, 'simple-coding').first().click()
  await page.waitForURL('**/project')
  await page.waitForTimeout(800)
}

test.beforeEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test.afterEach(async ({ request }) => {
  await cleanupTerminals(request)
})

test('悬浮条：steps 清单计数 + tooltip 全表 → 整包更新单项 done → 无 steps 上报不清清单', async ({ page }) => {
  test.setTimeout(60000)
  // 预置智能体终端收起为悬浮条形态（openState 启动恢复 + ballStyle 形态持久化，
  // 同 preview-port-event.spec 预置语义——省去管理页 → 悬浮窗 → 收起 → 右键切形态长链路）
  await page.addInitScript(() => {
    localStorage.setItem('sc.agentTerminal.openState', JSON.stringify({ visible: true, mode: 'mini' }))
    localStorage.setItem('sc.agentTerminal.ballStyle', JSON.stringify({ shape: 'bar', size: 'medium', opacity: 'solid' }))
  })
  await enterProject(page)
  const headers = await unlockHeaders()
  const seed = (payload: Record<string, unknown>) =>
    page.request.post(`${API_BASE}/api/ops-notify`, { headers, data: { type: 'task.progress', payload } })

  // 首报带全量计划：1/3 完成，step 指向未完成项
  await seed({
    task: STEPS_TASK,
    status: 'running',
    step: '应用变更',
    steps: [
      { name: '读取配置', done: true },
      { name: '应用变更', done: false },
      { name: '重启服务', done: false },
    ],
  })

  const mini = page.locator('body > .agm-root')
  await expect(mini).toBeVisible({ timeout: 8000 })
  await expect(mini).toHaveClass(/is-bar/)
  // 进度计数 n/m（共几步/完成几步一眼可读）
  await expect(mini.locator('.agm-steps-count')).toHaveText('1/3', { timeout: 8000 })
  // tooltip 全清单：✓ 完成 / ▶ 当前项（step 指针对应）/ ○ 未完成
  const title = await mini.getAttribute('title')
  expect(title).toContain('✓ 读取配置')
  expect(title).toContain('▶ 应用变更')
  expect(title).toContain('○ 重启服务')

  // 整包重发：应用变更完成、指针前移 → 计数 2/3、✓/▶ 随动（最后一份为准）
  await seed({
    task: STEPS_TASK,
    status: 'running',
    step: '重启服务',
    steps: [
      { name: '读取配置', done: true },
      { name: '应用变更', done: true },
      { name: '重启服务', done: false },
    ],
  })
  await expect(mini.locator('.agm-steps-count')).toHaveText('2/3', { timeout: 8000 })
  const title2 = await mini.getAttribute('title')
  expect(title2).toContain('✓ 应用变更')
  expect(title2).toContain('▶ 重启服务')

  // 缺省 steps 的单句进度上报：保留既有清单（计数不变），仅指针文本随动
  await seed({ task: STEPS_TASK, status: 'running', step: '重启服务进行中' })
  await expect(mini.locator('.agm-step')).toContainText('重启服务进行中', { timeout: 8000 })
  await expect(mini.locator('.agm-steps-count')).toHaveText('2/3')
})

test('值班大屏：任务进度卡清单渲染（划线/高亮/计数）→ 整包更新迁移', async ({ page, request }) => {
  test.setTimeout(60000)
  const headers = await unlockHeadersViaRequest(request)
  await fixedLocale(page)
  await gotoAndUnlock(page, `${API_BASE}/monitor`)

  const sessionId = (await createAgentSessionApi(request, { name: 'mon-steps-agent' })).id
  const seed = (payload: Record<string, unknown>) =>
    request.post(`${API_BASE}/api/ops-notify`, { headers, data: { type: 'task.progress', payload } })

  await seed({
    task: STEPS_TASK,
    status: 'running',
    step: '写实现',
    terminalId: sessionId,
    steps: [
      { name: '读代码', done: true },
      { name: '写实现', done: false },
      { name: '跑测试', done: false },
    ],
  })

  const card = page.locator('.mon-card.is-task')
  await expect(card).toHaveCount(1, { timeout: 10000 })
  await expect(card).toContainText(STEPS_TASK)
  await expect(card).toContainText('mon-steps-agent')

  // 清单逐项：3 项、首项完成划线、当前项高亮、meta 行计数
  const items = card.locator('.mon-task-step-item')
  await expect(items).toHaveCount(3, { timeout: 8000 })
  await expect(items.nth(0)).toHaveClass(/is-done/)
  await expect(items.nth(0)).toContainText('读代码')
  await expect(items.nth(1)).toHaveClass(/is-current/)
  await expect(items.nth(1)).toContainText('写实现')
  await expect(items.nth(2)).not.toHaveClass(/is-current/)
  await expect(card.locator('.mon-task-meta')).toContainText('步骤 1/3')

  // 整包更新：写实现完成 → 划线与计数随动，高亮迁移到「跑测试」
  await seed({
    task: STEPS_TASK,
    status: 'running',
    step: '跑测试',
    terminalId: sessionId,
    steps: [
      { name: '读代码', done: true },
      { name: '写实现', done: true },
      { name: '跑测试', done: false },
    ],
  })
  await expect(items.nth(1)).toHaveClass(/is-done/, { timeout: 8000 })
  await expect(items.nth(2)).toHaveClass(/is-current/)
  await expect(card.locator('.mon-task-meta')).toContainText('步骤 2/3')
})
